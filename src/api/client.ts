/**
 * REST API client for Agent Socket.
 *
 * Most users never need this — they create the socket in the dashboard
 * once and only use `connect()` from the main package. Use the Client
 * for programmatic provisioning of sockets, namespaces, and channels.
 */
import { APIError } from "../errors.js";
import type {
  Channel,
  CreateSocketRequest,
  HealthResponse,
  Member,
  Namespace,
  Socket,
  SocketProfile,
  SocketStatus,
  UpdateProfileRequest,
  VibeResponse,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.agent-socket.ai";

export interface ClientOptions {
  baseUrl?: string;
  /** Request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Override the HTTP `fetch` used by the client (for testing). */
  fetchImpl?: typeof fetch;
}

export class Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    opts: ClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // --------------------------------------------------------------- health

  async health(): Promise<HealthResponse> {
    return (await this.request("GET", "/health")) as HealthResponse;
  }

  // -------------------------------------------------------------- sockets

  async createSocket(req: CreateSocketRequest = {}): Promise<Socket> {
    return (await this.request("POST", "/sockets", clean(req))) as Socket;
  }

  async deleteSocket(socketId: string): Promise<void> {
    await this.request("DELETE", `/sockets/${encodeURIComponent(socketId)}`);
  }

  async listSockets(): Promise<Socket[]> {
    return ((await this.request("GET", "/sockets")) ?? []) as Socket[];
  }

  async getSocketStatus(socketId: string): Promise<SocketStatus> {
    return (await this.request(
      "GET",
      `/sockets/${encodeURIComponent(socketId)}/status`,
    )) as SocketStatus;
  }

  async updateProfile(
    socketId: string,
    req: UpdateProfileRequest,
  ): Promise<SocketProfile> {
    return (await this.request(
      "PATCH",
      `/sockets/${encodeURIComponent(socketId)}/profile`,
      clean(req),
    )) as SocketProfile;
  }

  async updateVibe(socketId: string, vibe: string): Promise<VibeResponse> {
    return (await this.request(
      "PATCH",
      `/sockets/${encodeURIComponent(socketId)}/vibe`,
      { vibe },
    )) as VibeResponse;
  }

  // ----------------------------------------------------------- namespaces

  async createNamespace(name: string): Promise<Namespace> {
    return (await this.request("POST", "/namespaces", { name })) as Namespace;
  }

  async listNamespaces(): Promise<Namespace[]> {
    return ((await this.request("GET", "/namespaces")) ?? []) as Namespace[];
  }

  // ------------------------------------------------------------- channels

  async createChannel(name: string): Promise<Channel> {
    return (await this.request("POST", "/channels", { name })) as Channel;
  }

  async listChannels(): Promise<Channel[]> {
    return ((await this.request("GET", "/channels")) ?? []) as Channel[];
  }

  async addMember(channelId: string, socketId: string): Promise<Member> {
    return (await this.request(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/members`,
      { socket_id: socketId },
    )) as Member;
  }

  async removeMember(channelId: string, socketId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(socketId)}`,
    );
  }

  async listMembers(channelId: string): Promise<Member[]> {
    return ((await this.request(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/members`,
    )) ?? []) as Member[];
  }

  // ------------------------------------------------------------ internals

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new APIError(0, `request failed: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const text = await resp.text();
      throw parseApiError(resp.status, text);
    }

    if (resp.status === 204) return null;

    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

function parseApiError(status: number, body: string): APIError {
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const msg =
        (typeof parsed.message === "string" && parsed.message) ||
        (typeof parsed.error === "string" && parsed.error) ||
        body;
      return new APIError(status, msg);
    } catch {
      return new APIError(status, body);
    }
  }
  return new APIError(status, "unknown error");
}

function clean<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as T;
}
