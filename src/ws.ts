/**
 * WebSocket transport for the Agent Socket wire protocol.
 *
 * Thin wrapper around the `ws` package — chosen over the native
 * WebSocket because Node.js's built-in WebSocket doesn't support the
 * custom `Authorization` header needed for bearer auth.
 */
import WebSocket, { type ClientOptions } from "ws";

import { ServerError } from "./errors.js";

const WIRE_ERROR = "error";

export type MessageCallback = (from: string, data: unknown) => void;
export type ErrorCallback = (err: Error) => void;

/** Reasons a connection may terminate. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/**
 * Thrown by {@link WSClient.send} when the underlying socket is not
 * in the OPEN state. Distinct from arbitrary write failures so the
 * caller can distinguish "retry after reconnect" from "this payload
 * cannot be sent on any connection".
 */
export class NotConnectedError extends Error {
  constructor() {
    super("not connected");
    this.name = "NotConnectedError";
  }
}

export class WSClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private closeInfo: CloseInfo | null = null;
  private closeErr: Error | null = null;
  private readonly closeWaiters: Array<() => void> = [];

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly onMessage: MessageCallback,
    private readonly onError: ErrorCallback,
  ) {}

  /**
   * Open the WebSocket. Resolves on successful upgrade; rejects with
   * a {@link ServerError} on a typed server rejection or a generic
   * Error on transport failure.
   *
   * Frame and close listeners are attached before the upgrade
   * completes so no data is missed between `open` and `run()`.
   */
  connect(socketId: string): Promise<void> {
    const url = `${this.endpoint}/${socketId}`;
    const opts: ClientOptions = {
      headers: { Authorization: `Bearer ${this.token}` },
    };

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, opts);
      this.ws = ws;

      let settled = false;

      // Attach frame/close/error listeners up front — messages may
      // arrive in the same tick as the 'open' event.
      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        this.dispatch(raw.toString());
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.ws = null;
        const reasonStr = reason.toString();
        if (code === 1000 || code === 1001 || code === 1005) {
          this.closeInfo = { code, reason: reasonStr };
        } else {
          this.closeErr = new Error(`connection closed: ${code} ${reasonStr}`);
        }
        for (const w of this.closeWaiters) w();
        this.closeWaiters.length = 0;
      });

      ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        this.onError(err);
      });

      ws.on("unexpected-response", (_req, res) => {
        settled = true;
        let bodyDone = false;
        const finishOnce = (fn: () => void) => {
          if (bodyDone) return;
          bodyDone = true;
          fn();
        };
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          finishOnce(() => {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(parseDialError(status, body));
          }),
        );
        res.on("error", (err: Error) => finishOnce(() => reject(err)));
      });

      ws.once("open", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  /**
   * Send a JSON frame on the connection.
   *
   * Rejects with {@link NotConnectedError} if the socket is not OPEN
   * (including mid-send drops, where the callback receives an error).
   * Serialization failures surface as regular `Error`s.
   */
  send(to: string, data: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
        reject(new NotConnectedError());
        return;
      }
      let frame: string;
      try {
        frame = JSON.stringify({ to, data });
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.ws.send(frame, (err) => {
        if (err) {
          // `ws` emits write errors when the socket has closed or is
          // closing. Treat as a transient "not connected" so the
          // supervisor retries after reconnect.
          reject(new NotConnectedError());
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Resolves when the connection closes cleanly, or rejects on an
   * abnormal close. Close handling is already wired up in `connect()`;
   * this method just awaits the outcome.
   */
  run(): Promise<CloseInfo> {
    return new Promise<CloseInfo>((resolve, reject) => {
      if (this.closeInfo !== null) {
        resolve(this.closeInfo);
        return;
      }
      if (this.closeErr !== null) {
        reject(this.closeErr);
        return;
      }
      this.closeWaiters.push(() => {
        if (this.closeErr !== null) reject(this.closeErr);
        else resolve(this.closeInfo ?? { code: 1006, reason: "" });
      });
    });
  }

  /** Close the connection. Idempotent. Resolves once the socket is closed. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const ws = this.ws;
    if (ws === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // readyState 3 = CLOSED
      if (ws.readyState === 3) {
        resolve();
        return;
      }
      const onClose = () => {
        ws.off("close", onClose);
        resolve();
      };
      ws.on("close", onClose);
      try {
        ws.close(1000, "");
      } catch {
        /* already closed */
      }
      // Belt-and-suspenders: if the clean close hasn't completed quickly,
      // force the socket shut. `ws.close()` under bun's shim does not always
      // emit the close event promptly when there is no server round-trip.
      setTimeout(() => {
        if (ws.readyState !== 3) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
      }, 100);
    });
  }

  private dispatch(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      this.onError(err as Error);
      return;
    }

    if (msg.type === WIRE_ERROR) {
      this.onError(
        new ServerError(
          typeof msg.code === "string" ? msg.code : "",
          typeof msg.message === "string" ? msg.message : "",
        ),
      );
      return;
    }

    const from = msg.from;
    if (typeof from === "string" && from.length > 0) {
      this.onMessage(from, msg.data);
    }
  }
}

function parseDialError(status: number, body: string): ServerError {
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const code = typeof parsed.error_code === "string" ? parsed.error_code : "";
      const message =
        typeof parsed.error_message === "string" ? parsed.error_message : "";
      if (code) return new ServerError(code, message, status);
    } catch {
      /* fall through */
    }
  }
  return new ServerError("", `websocket dial failed with HTTP ${status}`, status);
}
