/**
 * Agent — the long-lived handle returned by {@link connect}.
 *
 * Owns a supervisor that maintains one WebSocket connection at a
 * time, reconnecting on drop with jittered exponential backoff until
 * {@link Agent.close} is called or a fatal error is observed.
 *
 * The public surface (`send`, `close`, `wait`, `err`) is safe to call
 * before the first connection is established — `send` will wait for
 * the dial to finish.
 */

import { AgentClosedError, ServerError } from "./errors.js";
import { Message } from "./message.js";
import { WSClient } from "./ws.js";

export const DEFAULT_ENDPOINT = "wss://as.agent-socket.ai";
const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
// Sustained connected time before the backoff counter resets.
const HEALTHY_THRESHOLD_MS = 30_000;

export type Handler = (m: Message) => void | Promise<void>;

export interface ConnectOptions {
  /** WebSocket endpoint override. Default `wss://as.agent-socket.ai`. */
  endpoint?: string;
  /** Initial reconnect delay in ms. Default 500. */
  minBackoffMs?: number;
  /** Max reconnect delay in ms. Default 30_000. */
  maxBackoffMs?: number;
  /** Fires on every (re)connect — useful for re-subscribing. */
  onConnect?: () => void | Promise<void>;
}

/**
 * Open an Agent Socket connection and return immediately.
 *
 * A background supervisor opens the WebSocket, dispatches messages to
 * `handler`, and reconnects with exponential backoff if the
 * connection drops. Fatal errors (invalid token, socket not found,
 * permission denied) stop the reconnect loop — check {@link Agent.err}
 * or `await agent.wait()`.
 *
 * @example
 * ```ts
 * import { connect } from "@agent-socket/ts";
 *
 * const agent = connect("sk_...", "as:acme/my-agent", async (m) => {
 *   if (m.err) return;
 *   await m.reply({ echo: m.data });
 * });
 *
 * await agent.wait();
 * ```
 */
export function connect(
  token: string,
  socketId: string,
  handler: Handler,
  options: ConnectOptions = {},
): Agent {
  const agent = new Agent(token, socketId, handler, options);
  agent.start();
  return agent;
}

export class Agent {
  private readonly endpoint: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onConnect?: () => void | Promise<void>;

  private ws: WSClient | null = null;
  private lastErr: Error | null = null;
  private fatalErr: Error | null = null;

  // Promises used to coordinate readiness with the supervisor loop.
  private connReady: Promise<void>;
  private resolveConnReady!: () => void;

  private donePromise: Promise<void>;
  private resolveDone!: () => void;
  private isDone = false;

  // Abort signal that tells the supervisor to stop.
  private stopController = new AbortController();

  // Handler dispatch queue — keeps user handlers off the read loop and
  // prevents a handler that calls `agent.send()` from deadlocking the
  // supervisor. Messages are processed in order.
  private readonly dispatchQueue: Message[] = [];
  private dispatchRunning = false;

  constructor(
    private readonly token: string,
    public readonly socketId: string,
    private readonly handler: Handler,
    options: ConnectOptions,
  ) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.onConnect = options.onConnect;

    this.connReady = this.makePending();
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Start the supervisor. Called by {@link connect}. */
  start(): void {
    void this.supervisor();
  }

  /**
   * Send `payload` to target address `to`.
   *
   * `to` is a socket (`as:ns/name`) or channel (`ch:ns/name`).
   * `payload` must be JSON-serialisable. Resolves once the frame is
   * on the wire.
   *
   * Waits for the connection to be established (or re-established
   * after a drop). Rejects with {@link AgentClosedError} if the agent
   * is closed, or the underlying {@link ServerError} on fatal errors.
   */
  async send(to: string, payload: unknown): Promise<void> {
    while (true) {
      if (this.fatalErr) throw this.fatalErr;
      if (this.isDone) throw new AgentClosedError();

      const ws = this.ws;
      if (ws !== null) {
        try {
          await ws.send(to, payload);
          return;
        } catch {
          // Dropped mid-send. Fall through to wait for reconnect.
        }
      }

      await Promise.race([this.connReady, this.donePromise]);
      if (this.isDone) throw new AgentClosedError();
    }
  }

  /**
   * Tear down the agent. Resolves once the supervisor has exited.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    this.stopController.abort();
    if (this.ws !== null) {
      await this.ws.close();
    }
    await this.donePromise;
  }

  /** Resolves when the agent stops (close, fatal error). */
  wait(): Promise<void> {
    return this.donePromise;
  }

  /** The most recent error. `null` during a healthy connection. */
  err(): Error | null {
    return this.fatalErr ?? this.lastErr;
  }

  /** `true` once the agent has stopped. */
  get done(): boolean {
    return this.isDone;
  }

  // ------------------------------------------------------------ internals

  private async supervisor(): Promise<void> {
    let backoffMs = this.minBackoffMs;

    try {
      while (!this.stopController.signal.aborted) {
        const { connectedAt, err } = await this.cycle();

        if (this.stopController.signal.aborted) break;

        this.lastErr = err;

        if (err instanceof ServerError && err.isFatal) {
          this.fatalErr = err;
          this.enqueue(new Message("", null, err, null));
          break;
        }

        if (err !== null) {
          this.enqueue(new Message("", null, err, null));
        }

        if (
          connectedAt !== null &&
          Date.now() - connectedAt > HEALTHY_THRESHOLD_MS
        ) {
          backoffMs = this.minBackoffMs;
        }

        const sleep = backoffMs + Math.random() * (backoffMs / 2);
        await this.sleep(sleep);
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
      }
    } finally {
      this.isDone = true;
      this.resolveDone();
    }
  }

  private async cycle(): Promise<{
    connectedAt: number | null;
    err: Error | null;
  }> {
    const ws = new WSClient(
      this.endpoint,
      this.token,
      (from, data) => this.enqueue(new Message(from, data, null, this)),
      (err) => this.enqueue(new Message("", null, err, null)),
    );

    try {
      await ws.connect(this.socketId);
    } catch (err) {
      return { connectedAt: null, err: err as Error };
    }

    this.ws = ws;
    this.resolveConnReady();

    const connectedAt = Date.now();
    if (this.onConnect) {
      // Run off the hot path — don't await.
      Promise.resolve(this.onConnect()).catch(() => {
        /* swallow */
      });
    }

    try {
      await ws.run();
      return { connectedAt, err: null };
    } catch (err) {
      return { connectedAt, err: err as Error };
    } finally {
      this.ws = null;
      await ws.close();
      // Re-arm the readiness promise for the next cycle.
      this.connReady = this.makePending();
    }
  }

  private enqueue(msg: Message): void {
    this.dispatchQueue.push(msg);
    if (!this.dispatchRunning) {
      this.dispatchRunning = true;
      queueMicrotask(() => void this.drain());
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.dispatchQueue.length > 0) {
        const m = this.dispatchQueue.shift()!;
        try {
          await this.handler(m);
        } catch {
          // Intentionally swallow handler errors — same as Go/Python.
        }
      }
    } finally {
      this.dispatchRunning = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.stopController.signal.aborted) {
        onAbort();
        return;
      }
      this.stopController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });
  }

  private makePending(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveConnReady = resolve;
    });
  }
}
