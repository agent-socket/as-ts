/**
 * Supervisor behaviour tests — reconnect, fatal-error detection,
 * send-blocking, reply. Uses a lightweight local WebSocket server
 * from the `ws` package to exercise the real wire protocol.
 *
 * Tests run on Node's built-in test runner (`node --test`) — Bun's
 * `ws` shim doesn't implement `unexpected-response` or propagate
 * server-side close codes reliably, which breaks the fatal-error
 * and reconnect tests there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import * as http from "node:http";
import { WebSocketServer, type WebSocket as WSServerConn } from "ws";

import { connect, Message, ServerError } from "../src/index.js";

interface Started {
  url: string;
  attempts: () => number;
  stop: () => Promise<void>;
}

function startServer(
  onConn: (attempt: number, conn: WSServerConn) => void,
): Promise<Started> {
  return new Promise((resolve) => {
    let attempts = 0;
    const open = new Set<WSServerConn>();
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        attempts: () => attempts,
        stop: () =>
          new Promise<void>((r) => {
            for (const c of open) c.terminate();
            wss.close(() => r());
          }),
      });
    });

    wss.on("connection", (conn) => {
      attempts += 1;
      open.add(conn);
      conn.on("close", () => open.delete(conn));
      onConn(attempts, conn);
    });
  });
}

function startRejectingServer(status: number, body: string): Promise<Started> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.on("upgrade", (_req, socket) => {
      socket.write(
        `HTTP/1.1 ${status} Unauthorized\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n` +
          body,
      );
      socket.destroy();
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        attempts: () => 0,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function waitFor<T>(
  predicate: () => T | null,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

test("reconnects after drop and keeps delivering messages", async () => {
  const server = await startServer((attempt, conn) => {
    if (attempt === 1) {
      conn.send(JSON.stringify({ from: "as:test/sender", data: "first" }));
      setTimeout(() => conn.close(1011, "drop"), 20);
    } else if (attempt === 2) {
      conn.send(JSON.stringify({ from: "as:test/sender", data: "second" }));
    }
  });

  const events: Message[] = [];
  const agent = connect(
    "tok",
    "as:test/me",
    (m) => {
      events.push(m);
    },
    { endpoint: server.url, minBackoffMs: 50, maxBackoffMs: 100 },
  );

  try {
    await waitFor(() => (events.length >= 3 ? true : null), 5000);

    const msgs = events.filter((e) => e.err === null);
    const errs = events.filter((e) => e.err !== null);

    assert.ok(msgs.length >= 2, `want >=2 messages, got ${msgs.length}`);
    assert.ok(errs.length >= 1, `want >=1 error, got ${errs.length}`);
    assert.ok(server.attempts() >= 2);
  } finally {
    await agent.close();
    await server.stop();
  }
});

test("stops on 401 auth error", async () => {
  const server = await startRejectingServer(
    401,
    JSON.stringify({ error_code: "E1001", error_message: "bad token" }),
  );

  const agent = connect("bad", "as:test/me", () => {}, {
    endpoint: server.url,
    minBackoffMs: 50,
    maxBackoffMs: 100,
  });

  try {
    await Promise.race([
      agent.wait(),
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("agent never gave up on 401")), 3000),
      ),
    ]);

    const err = agent.err();
    assert.ok(err instanceof ServerError, `want ServerError, got ${err}`);
    assert.equal((err as ServerError).status, 401);
    assert.equal((err as ServerError).isFatal, true);
  } finally {
    await agent.close();
    await server.stop();
  }
});

test("send blocks until connected", async () => {
  let received: { to: string; data: unknown } | null = null;
  const server = await startServer((_attempt, conn) => {
    conn.on("message", (raw) => {
      received = JSON.parse(raw.toString());
    });
  });

  const agent = connect("tok", "as:test/me", () => {}, {
    endpoint: server.url,
    minBackoffMs: 50,
  });

  try {
    await agent.send("as:test/peer", { ping: 1 });
    await waitFor(() => (received !== null ? received : null), 3000);
    assert.deepEqual(received, { to: "as:test/peer", data: { ping: 1 } });
  } finally {
    await agent.close();
    await server.stop();
  }
});

test("send rejects on non-transient error without spinning", async () => {
  // Build a server that accepts the connection so the ws is OPEN.
  const server = await startServer(() => {});

  const agent = connect("tok", "as:test/me", () => {}, {
    endpoint: server.url,
    minBackoffMs: 50,
  });

  try {
    // BigInt is not JSON-serialisable — JSON.stringify throws, which
    // should propagate out of agent.send() instead of being treated
    // as a retryable transport error.
    const badPayload = { n: 1n } as unknown;
    // Wait briefly so the socket is live (send path reaches ws.send).
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(
      agent.send("as:test/peer", badPayload),
      (err: unknown) => err instanceof TypeError,
    );
  } finally {
    await agent.close();
    await server.stop();
  }
});

test("dispatch does not lose messages under tight enqueue timing", async () => {
  // Server sends a burst of frames as fast as it can; an async
  // handler that yields once between messages stresses the
  // dispatch-queue drain/kick race.
  const BURST = 50;
  const server = await startServer((_attempt, conn) => {
    for (let i = 0; i < BURST; i++) {
      conn.send(JSON.stringify({ from: "as:test/sender", data: { i } }));
    }
  });

  let seen = 0;
  const agent = connect(
    "tok",
    "as:test/me",
    async (m: Message) => {
      if (m.err) return;
      await Promise.resolve(); // yield, inviting the race
      seen += 1;
    },
    { endpoint: server.url, minBackoffMs: 50 },
  );

  try {
    await waitFor(() => (seen >= BURST ? true : null), 3000);
    assert.equal(seen, BURST);
  } finally {
    await agent.close();
    await server.stop();
  }
});

test("handler can reply without deadlocking", async () => {
  const replies: unknown[] = [];
  const server = await startServer((_attempt, conn) => {
    conn.send(JSON.stringify({ from: "as:test/peer", data: { ping: 1 } }));
    conn.on("message", (raw) => {
      replies.push(JSON.parse(raw.toString()));
    });
  });

  const agent = connect(
    "tok",
    "as:test/me",
    async (m) => {
      if (m.err) return;
      await m.reply({ pong: m.data });
    },
    { endpoint: server.url, minBackoffMs: 50 },
  );

  try {
    await waitFor(() => (replies.length > 0 ? replies : null), 3000);
    assert.deepEqual(replies[0], {
      to: "as:test/peer",
      data: { pong: { ping: 1 } },
    });
  } finally {
    await agent.close();
    await server.stop();
  }
});
