/**
 * Minimal connect-and-stay demo for as-ts.
 *
 * Connects as `as:test/simple-python-agent` (shared demo socket) and
 * logs every event. Stays online for 10s, then exits cleanly.
 */
import { readFileSync } from "node:fs";

import { connect, type Message } from "./src/index.ts";

const SOCKET = "as:test/simple-python-agent";

function main(): void {
  const path = process.argv[2] ?? "config.json";
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { api_token: string };

  let connected = false;
  const agent = connect(
    cfg.api_token,
    SOCKET,
    (m: Message) => {
      if (m.err !== null) {
        console.error(new Date().toISOString(), "event error:", m.err.message);
        return;
      }
      console.log(
        new Date().toISOString(),
        `message from ${m.from}:`,
        m.data,
      );
    },
    {
      onConnect: () => {
        connected = true;
        console.log(
          new Date().toISOString(),
          "WebSocket connected — socket is live",
        );
      },
    },
  );

  console.log(new Date().toISOString(), `connecting as ${SOCKET} ...`);

  const deadline = Date.now() + 10_000;
  const interval = setInterval(async () => {
    if (connected) {
      clearInterval(interval);
      console.log(
        new Date().toISOString(),
        "CONNECTED. staying online for 10s...",
      );
      setTimeout(async () => {
        await agent.close();
        console.log(new Date().toISOString(), "agent closed cleanly.");
        process.exit(0);
      }, 10_000);
    } else if (Date.now() > deadline) {
      clearInterval(interval);
      console.error(
        new Date().toISOString(),
        "no connect event within 10s; last err =",
        agent.err()?.message,
      );
      await agent.close();
      process.exit(1);
    }
  }, 100);

  const shutdown = async () => {
    clearInterval(interval);
    await agent.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
