// ── OpenAI-compatible wire types ──

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: string | object;
  stop?: string | string[];
  n?: number;
  user?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

// ── Provider types ──

export type WireFormat = "openai" | "google" | "anthropic";

export interface Provider {
  id: number;
  name: string;
  baseUrl: string;
  type: "free" | "paid" | "local" | "subscription";
  wireFormat: WireFormat;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  enabled: boolean;
  createdAt: string;
}

export interface ProviderKey {
  id: number;
  providerId: number;
  label: string;
  apiKeyEnc: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  rrPosition: number;
  enabled: boolean;
  createdAt: string;
}

export interface ModelMetadata {
  id: number;
  providerId: number;
  modelId: string;
  name: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  maxOutputTokens: number | null;
  fetchedAt: string;
}

// ── Tier types ──

export type TierName = "simple" | "standard" | "reasoning" | "complex" | "multimodal";

export interface TierConfig {
  id: number;
  name: TierName;
  description: string;
}

export interface TierModel {
  tierId: number;
  modelId: string;
  providerId: number;
  priority: number;
}

// ── Fusion types ──

export type ArbiterStrategy = "best_of_n" | "synthesize" | "majority";

export interface FusionPool {
  id: number;
  name: string;
  arbiterStrategy: ArbiterStrategy;
  arbiterModelId: string;
}

export interface FusionPoolMember {
  poolId: number;
  modelId: string;
  providerId: number;
  position: number;
}

// ── Usage / stats types ──

export interface UsageEvent {
  id: number;
  userId: number;
  providerId: number | null;
  modelId: string;
  tier: TierName | "fusion";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  fusionPoolId: number | null;
  costUsd: number | null;
  timestamp: string;
}

// ── User types ──

export interface User {
  id: number;
  username: string;
  role: "admin" | "regular";
  createdAt: string;
}

export interface AuthUser extends User {
  passwordHash: string;
}
