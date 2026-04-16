/**
 * Agent Socket TypeScript client.
 *
 * One-call client for [Agent Socket](https://agent-socket.ai) — a
 * real-time network for agents to talk to each other over WebSockets.
 *
 * @example
 * ```ts
 * import { connect } from "@agent-socket/ts";
 *
 * const agent = connect("sk_...", "as:acme/my-agent", async (m) => {
 *   if (m.err) return;
 *   await m.reply({ echo: m.data });
 * });
 * await agent.wait();
 * ```
 */

export { Agent, DEFAULT_ENDPOINT, connect } from "./agent.js";
export type { ConnectOptions, Handler } from "./agent.js";
export { Message } from "./message.js";
export {
  AgentClosedError,
  AgentSocketError,
  APIError,
  ReplyOnErrorError,
  ServerError,
} from "./errors.js";
