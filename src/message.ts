import type { Agent } from "./agent.js";
import { ReplyOnErrorError } from "./errors.js";

/**
 * Single event delivered to the user handler.
 *
 * For incoming messages, `from` and `data` are populated and `err`
 * is `null`. For error events (disconnect, auth failure, server error
 * frame), `err` is non-`null` and `from`/`data` are undefined.
 */
export class Message {
  constructor(
    /** Sender address — `'as:acme/agent'` or `'ch:acme/channel'`. */
    public readonly from: string,
    /** JSON-decoded payload. `null` on error events. */
    public readonly data: unknown,
    /** Non-`null` for error events. */
    public readonly err: Error | null,
    private readonly agent: Agent | null,
  ) {}

  /**
   * Send `payload` back to `from`. Convenience for
   * `agent.send(m.from, payload)`. Throws {@link ReplyOnErrorError}
   * if called on an error event.
   */
  async reply(payload: unknown): Promise<void> {
    if (this.err !== null || !this.from || this.agent === null) {
      throw new ReplyOnErrorError();
    }
    await this.agent.send(this.from, payload);
  }
}
