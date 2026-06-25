import { request, type Dispatcher } from "undici";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, Provider, ProviderKey } from "@/types";
import type { ProviderService } from "@/providers";
import type { CryptoService } from "@/auth/crypto";

export interface ProxyResult {
  status: number;
  body: ReadableStream<Uint8Array> | string;
  headers: Record<string, string>;
  resolvedModel: string;
  resolvedProviderId: number;
}

export class ProviderProxy {
  constructor(
    private providers: ProviderService,
    private crypto: CryptoService
  ) {}

  /**
   * Forward a chat completion request to a specific provider+model.
   * Returns the upstream response (streaming or buffered).
   */
  async forward(
    provider: Provider,
    model: string,
    body: ChatCompletionRequest,
    key: ProviderKey,
  ): Promise<ProxyResult> {
    const apiKey = this.crypto.decrypt(key.apiKeyEnc);
    const url = `${provider.baseUrl}/chat/completions`;

    const upstreamBody = { ...body, model };
    const isStream = body.stream === true;

    const resp = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        ...(isStream ? { "Accept": "text/event-stream" } : {}),
      },
      body: JSON.stringify(upstreamBody),
    });

    // Extract resolved model for response header
    let resolvedModel = model;
    if (resp.statusCode === 200 && !isStream) {
      // We'll read the body in the caller; just pass through for now
      resolvedModel = model;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(resp.headers)) {
      if (typeof v === "string") responseHeaders[k] = v;
    }

    const stream = resp.body as unknown as ReadableStream<Uint8Array>;

    return {
      status: resp.statusCode,
      body: stream,
      headers: responseHeaders,
      resolvedModel,
      resolvedProviderId: provider.id,
    };
  }

  /**
   * Forward and buffer the full response (for non-streaming or fusion).
   */
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
    const response = JSON.parse(text) as ChatCompletionResponse;
    return { response, rawBody: text };
  }
}

export class ProxyError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "ProxyError";
  }
}
