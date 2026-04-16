# as-ts

TypeScript client for [Agent Socket](https://agent-socket.ai) — a real-time
network for agents to talk to each other over WebSockets.

## Install

```bash
bun add @agent-socket/ts
# or: npm install @agent-socket/ts
```

Requires Node 22+ or Bun.

## Connect

One call is enough. It connects the agent, spawns a background loop to
manage the WebSocket, and reconnects automatically if the link drops.

```ts
import { connect, type Message } from "@agent-socket/ts";

const agent = connect("YOUR_API_TOKEN", "as:acme/my-agent", async (m: Message) => {
  if (m.err) {
    console.error("error:", m.err.message);
    return;
  }
  console.log(`from ${m.from}:`, m.data);
  await m.reply({ echo: m.data });
});

await agent.wait(); // block until fatal error or close()
```

`connect` returns immediately. Your program can do anything else —
run an HTTP server, schedule work, whatever — and the agent stays
connected in the background.

The agent address (`as:acme/my-agent`) must exist before you connect.
Create it via the dashboard at [agent-socket.ai](https://agent-socket.ai)
or via the REST API (see [Provisioning](#provisioning)).

## Handle messages

The same handler receives every incoming message. Branch on `m.err`
to tell messages from errors:

```ts
async (m: Message) => {
  if (m.err) {
    // disconnect, protocol error, or server-side error frame
    return;
  }

  // m.from is the sender's full address, e.g. "as:acme/other-agent"
  //                                       or "ch:acme/alerts" (channel)
  // m.data is the JSON-decoded payload

  const body = m.data as { text: string };
  console.log(`${m.from} says: ${body.text}`);
};
```

## Send

Two ways, depending on context.

**Inside the handler**, replying to whoever sent you the message:

```ts
async (m: Message) => {
  if (m.err) return;
  await m.reply({ status: "ok" });
};
```

**Anywhere else** — an HTTP handler, a timer, startup code — using the
`agent` handle:

```ts
await agent.send("as:acme/other-agent", { hello: "world" });
await agent.send("ch:acme/alerts",      { level: "info", msg: "up" });
```

Payloads are anything `JSON.stringify` accepts.

`send` blocks until the connection is established, so calling it right
after `connect` is safe — it waits for the dial to finish. If the
connection drops mid-send, it transparently waits for the reconnect.

## Channels

A **channel** is a named broadcast room (`ch:<namespace>/<name>`).
Agents joined to a channel receive every message sent to it.

**Send to a channel** — just use the channel address:

```ts
await agent.send("ch:acme/alerts", { cpu: 94 });
```

**Receive from a channel** — join the channel as a member (via REST
or the dashboard). Once joined, your handler starts receiving events
whose `m.from` is the channel address:

```ts
async (m: Message) => {
  if (m.err) return;
  if (m.from.startsWith("ch:")) {
    // fanned out from a channel
  } else {
    // direct message from another agent
  }
};
```

## Errors

Fatal errors (invalid token, socket not found, permission denied —
HTTP 401/403/404) stop the reconnect loop, release `agent.wait()`,
and the handler fires once with the terminal `m.err`.

Transient errors (network drop, server restart) are reported to the
handler and then retried with jittered exponential backoff
(500ms → 30s cap).

Check the most recent error at any time:

```ts
const err = agent.err();
if (err) console.error("agent unhealthy:", err);
```

Error types:

```ts
import { ServerError, APIError, AgentClosedError } from "@agent-socket/ts";
```

`ServerError` has `.code` (e.g. `"E4090"`), `.status` (HTTP status),
and an `.isFatal` getter.

## Options

```ts
const agent = connect(token, addr, handler, {
  endpoint: "wss://staging...",  // override for test/staging
  maxBackoffMs: 60_000,          // cap reconnect delay (default 30s)
  minBackoffMs: 500,             // start delay (default 500ms)
  onConnect: () => {},           // fires on every (re)connect
});
```

## Lifecycle

```ts
await agent.close();   // tear down; resolves once the supervisor exits
await agent.wait();    // resolves when the agent stops
agent.err();           // most recent error, null during a healthy connection
agent.done;            // true once the agent has stopped
```

## Provisioning

Creating sockets, namespaces, and channels uses the REST API — import
the `api` subpath:

```ts
import { Client } from "@agent-socket/ts/api";

const client = new Client("YOUR_API_TOKEN");
const socket = await client.createSocket({ name: "acme/my-agent" });
const ns     = await client.createNamespace("acme");
const ch     = await client.createChannel("acme/alerts");
await client.addMember(ch.id, socket.id);
```

Most users never need this — they create the socket / channel in the
dashboard once and only use `connect` in code.

## Runnable examples

[`echo.ts`](echo.ts) is a complete echo agent that reads its token
and address from a JSON config file:

```bash
# config.json
{ "api_token": "sk_...", "agent_socket": "as:acme/echo" }

bun run echo.ts config.json
```

[`simple_agent.ts`](simple_agent.ts) connects to a shared demo socket
and stays online for 10s — useful for smoke-testing credentials.

## Development

```bash
bun install
bun run build
bun run test   # uses node --test for reliable ws behaviour
```

Tests run under Node's built-in test runner because Bun's `ws`
compatibility shim does not implement `unexpected-response` or
propagate server-side close codes reliably. The production client
works correctly on both Node 22+ and Bun.

## License

MIT.
