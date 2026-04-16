/**
 * Error types for the Agent Socket client.
 */

export class AgentSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSocketError";
  }
}

/**
 * Standardized error returned by the Agent Socket server.
 *
 * Carries the server-assigned `code` (e.g. `"E4090"`), a human-readable
 * `message`, and the transport-level `status` (HTTP status on dial,
 * 0 for error frames received over an open socket).
 */
export class ServerError extends AgentSocketError {
  constructor(
    public readonly code: string,
    public readonly serverMessage: string,
    public readonly status: number = 0,
  ) {
    const suffix = status ? ` (status ${status})` : "";
    super(`[${code || "unknown"}] ${serverMessage}${suffix}`);
    this.name = "ServerError";
  }

  /**
   * Whether this error should stop the reconnect loop. Auth failures
   * (401/403) and a missing socket (404) are terminal — retrying
   * will not fix them.
   */
  get isFatal(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

/** Error returned by the REST API. */
export class APIError extends AgentSocketError {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string,
  ) {
    super(`api error (status ${status}): ${apiMessage}`);
    this.name = "APIError";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** Thrown when `Message.reply()` is called on an error event. */
export class ReplyOnErrorError extends AgentSocketError {
  constructor() {
    super("cannot reply on error event");
    this.name = "ReplyOnErrorError";
  }
}

/** Thrown when operating on an Agent after it has been closed. */
export class AgentClosedError extends AgentSocketError {
  constructor() {
    super("agent closed");
    this.name = "AgentClosedError";
  }
}
