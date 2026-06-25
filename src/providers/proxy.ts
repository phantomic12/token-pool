import { request } from "undici";
import type { ChatCompletionRequest, ChatCompletionResponse, Provider, ProviderKey, WireFormat } from "@/types";
import type { ProviderService } from "@/providers";
import type { CryptoService } from "@/auth/crypto";

export interface ProxyResult {
  status: number;
  body: ReadableStream<Uint8Array> | string;
  headers: Record<string, string>;
  resolvedModel: string;
  resolvedProviderId: number;
}

// ── Wire format builders ──

interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildOpenAIRequest(provider: Provider, model: string, body: ChatCompletionRequest, apiKey: string): BuiltRequest {
  const url = `${provider.baseUrl}/chat/completions`;
  const upstreamBody = { ...body, model };
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  };
}

function buildAnthropicRequest(provider: Provider, model: string, body: ChatCompletionRequest, apiKey: string): BuiltRequest {
  const url = `${provider.baseUrl}/v1/messages`;
  // Convert OpenAI messages → Anthropic format
  const systemMsgs = body.messages.filter(m => m.role === "system");
  const nonSystemMsgs = body.messages.filter(m => m.role !== "system");
  const systemText = systemMsgs.map(m => typeof m.content === "string" ? m.content : "").join("\n");

  const anthropicBody = {
    model,
    max_tokens: body.max_tokens ?? 4096,
    system: systemText || undefined,
    messages: nonSystemMsgs.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    stream: body.stream ?? false,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : undefined,
  };

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  };
}

function buildGoogleRequest(provider: Provider, model: string, body: ChatCompletionRequest, apiKey: string): BuiltRequest {
  const isStream = body.stream === true;
  const endpoint = isStream ? "streamGenerateContent" : "generateContent";
  const url = `${provider.baseUrl}/v1beta/models/${model}:${endpoint}${isStream ? "?alt=sse" : ""}`;

  // Convert OpenAI messages → Google Gemini format
  const systemMsgs = body.messages.filter(m => m.role === "system");
  const nonSystemMsgs = body.messages.filter(m => m.role !== "system");
  const systemText = systemMsgs.map(m => typeof m.content === "string" ? m.content : "").join("\n");

  const googleBody = {
    contents: nonSystemMsgs.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: typeof m.content === "string"
        ? [{ text: m.content }]
        : Array.isArray(m.content)
          ? m.content.map(p => p.type === "text" ? { text: p.text } : { text: JSON.stringify(p) })
          : [{ text: "" }],
    })),
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    generationConfig: {
      temperature: body.temperature,
      topP: body.top_p,
      maxOutputTokens: body.max_tokens,
      ...(Array.isArray(body.stop) ? { stopSequences: body.stop } : body.stop ? { stopSequences: [body.stop] } : {}),
    },
  };

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(googleBody),
  };
}

function buildRequest(provider: Provider, model: string, body: ChatCompletionRequest, apiKey: string): BuiltRequest {
  switch (provider.wireFormat) {
    case "anthropic":
      return buildAnthropicRequest(provider, model, body, apiKey);
    case "google":
      return buildGoogleRequest(provider, model, body, apiKey);
    default:
      return buildOpenAIRequest(provider, model, body, apiKey);
  }
}

export class ProviderProxy {
  constructor(
    private providers: ProviderService,
    private crypto: CryptoService,
  ) {}

  async forward(
    provider: Provider,
    model: string,
    body: ChatCompletionRequest,
    key: ProviderKey,
  ): Promise<ProxyResult> {
    const apiKey = this.crypto.decrypt(key.apiKeyEnc);
    const built = buildRequest(provider, model, body, apiKey);
    const isStream = body.stream === true;

    const resp = await request(built.url, {
      method: "POST",
      headers: {
        ...built.headers,
        ...(isStream ? { "Accept": "text/event-stream" } : {}),
      },
      body: built.body,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(resp.headers)) {
      if (typeof v === "string") responseHeaders[k] = v;
    }

    const stream = resp.body as unknown as ReadableStream<Uint8Array>;

    return {
      status: resp.statusCode,
      body: stream,
      headers: responseHeaders,
      resolvedModel: model,
      resolvedProviderId: provider.id,
    };
  }

  async forwardBuffered(
    provider: Provider,
    model: string,
    body: ChatCompletionRequest,
    key: ProviderKey,
  ): Promise<{ response: ChatCompletionResponse; rawBody: string }> {
    const result = await this.forward(provider, model, { ...body, stream: false }, key);
    if (result.status !== 200) {
      const text = typeof result.body === "string"
        ? result.body
        : await new Response(result.body).text();
      throw new ProxyError(`Upstream ${result.status}: ${text}`, result.status);
    }
    const text = typeof result.body === "string"
      ? result.body
      : await new Response(result.body).text();

    // Parse based on wire format — google and anthropic need conversion back to OpenAI shape
    const response = this.parseResponse(text, provider.wireFormat, model);
    return { response, rawBody: text };
  }

  /**
   * Parse upstream response based on wire format.
   * Google and Anthropic responses are converted to OpenAI shape.
   */
  private parseResponse(text: string, wireFormat: WireFormat, model: string): ChatCompletionResponse {
    const raw = JSON.parse(text);

    if (wireFormat === "google") {
      return this.parseGoogleResponse(raw, model);
    }
    if (wireFormat === "anthropic") {
      return this.parseAnthropicResponse(raw, model);
    }
    // OpenAI format — pass through
    return raw as ChatCompletionResponse;
  }

  private parseGoogleResponse(raw: any, model: string): ChatCompletionResponse {
    const candidate = raw?.candidates?.[0];
    const content = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const usage = raw?.usageMetadata ?? {};

    return {
      id: `google-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: candidate?.finishReason === "STOP" ? "stop" : candidate?.finishReason ?? "stop",
      }],
      usage: {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0,
      },
    };
  }

  private parseAnthropicResponse(raw: any, model: string): ChatCompletionResponse {
    const content = raw?.content?.map((c: any) => c.text ?? "").join("") ?? "";
    const usage = raw?.usage ?? {};

    return {
      id: raw?.id ?? `anthropic-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: raw?.stop_reason === "end_turn" ? "stop" : raw?.stop_reason ?? "stop",
      }],
      usage: {
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      },
    };
  }
}

export class ProxyError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "ProxyError";
  }
}
