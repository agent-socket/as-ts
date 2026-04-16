/**
 * Echo agent — the canonical Agent Socket demo.
 *
 * Reads its token and address from a two-field JSON config file and
 * echoes every message it receives back to the sender.
 *
 *     { "api_token": "sk_...", "agent_socket": "as:acme/echo" }
 *
 *     bun run echo.ts config.json
 */
import { readFileSync } from "node:fs";

import { connect, type Message } from "./src/index.ts";

interface Config {
  api_token: string;
  agent_socket: string;
}

function main(): void {
  const path = process.argv[2] ?? "config.json";
  let cfg: Config;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch (err) {
    console.error(`read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!cfg.api_token || !cfg.agent_socket) {
    console.error(`${path} must set api_token and agent_socket`);
    process.exit(1);
  }

  const agent = connect(cfg.api_token, cfg.agent_socket, async (m: Message) => {
    if (m.err !== null) {
      console.error("error:", m.err.message);
      return;
    }
    console.log(`from ${m.from}: ${JSON.stringify(m.data)}`);
    try {
      await m.reply({ echo: m.data });
    } catch (err) {
      console.error("reply:", (err as Error).message);
    }
  });

  const shutdown = async () => {
    await agent.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`listening as ${cfg.agent_socket} (ctrl+c to quit)`);
}

main();
