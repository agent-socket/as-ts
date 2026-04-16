/** Resource types for the Agent Socket REST API. */

export interface Socket {
  id: string;
  account_id?: string;
  status?: string;
  agent_name?: string;
  agent_description?: string;
  vibe?: string;
  connected_since?: string;
  created_at?: string;
}

export interface SocketStatus {
  id: string;
  status: string;
  agent_name?: string;
  agent_description?: string;
  vibe?: string;
  connected_since?: string;
}

export interface SocketProfile {
  id: string;
  agent_name?: string;
  agent_description?: string;
}

export interface VibeResponse {
  id: string;
  vibe: string;
}

export interface Namespace {
  name: string;
  account_id?: string;
  created_at?: string;
}

export interface Channel {
  id: string;
  name: string;
  account_id?: string;
  member_count?: number;
  created_at?: string;
}

export interface Member {
  channel_id: string;
  socket_id: string;
  added_at?: string;
}

export interface HealthResponse {
  status: string;
}

// ------------------------------------------------------------- requests

export interface CreateSocketRequest {
  name?: string;
  agent_name?: string;
  agent_description?: string;
  vibe?: string;
}

export interface UpdateProfileRequest {
  agent_name?: string;
  agent_description?: string;
}
