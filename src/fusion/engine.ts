import type { ProviderProxy } from "@/providers/proxy";
import type { ProviderService } from "@/providers";
import type { CryptoService } from "@/auth/crypto";
import type { RateLimitGuard } from "@/providers/rate-limiter";
import type { FusionService } from "@/fusion";
import type { ChatCompletionRequest, ChatCompletionResponse, FusionPool, ArbiterStrategy } from "@/types";

export interface FusionResult {
  response: ChatCompletionResponse;
  poolName: string;
  arbiterStrategy: ArbiterStrategy;
  legCount: number;
  legModels: string[];
  arbiterModel: string;
}

export class FusionEngine {
  constructor(
    private providers: ProviderService,
    private proxy: ProviderProxy,
    private crypto: CryptoService,
    private guard: RateLimitGuard,
    private fusionService: FusionService,
  ) {}

  /**
   * Execute a fusion request: fan out to panel, then arbitrate.
   * model string format: "fusion:<pool_name>"
   */
  async execute(
    body: ChatCompletionRequest,
    modelString: string,
  ): Promise<FusionResult> {
    const poolName = modelString.replace("fusion:", "");
    const pool = this.fusionService.getByName(poolName);
    if (!pool) {
      throw new FusionError(`Fusion pool '${poolName}' not found`, 404);
    }

    const members = this.fusionService.listMembers(pool.id);
    if (members.length === 0) {
      throw new FusionError(`Fusion pool '${poolName}' has no members`, 400);
    }

    // Fan out: send the request to all panel models in parallel
    const legResults = await Promise.allSettled(
      members.map(async (member) => {
        const provider = this.providers.get(member.providerId);
        if (!provider || !provider.enabled) {
          throw new Error(`Provider ${member.providerId} not available`);
        }

        const decision = this.guard.tryAcquire(provider, 1000);
        if (!decision.allowed || !decision.key) {
          throw new Error(`No available key for ${provider.name}`);
        }

        const { response } = await this.proxy.forwardBuffered(
          provider,
          member.modelId,
          { ...body, stream: false },
          decision.key,
        );

        return {
          modelId: member.modelId,
          providerId: member.providerId,
          response,
        };
      }),
    );

    // Collect successful legs (skip failures)
    const legs: Array<{ modelId: string; providerId: number; response: ChatCompletionResponse }> = [];
    for (const result of legResults) {
      if (result.status === "fulfilled") {
        legs.push(result.value);
      }
    }

    if (legs.length === 0) {
      throw new FusionError("All fusion legs failed", 502);
    }

    // Arbitrate
    const arbiterResult = await this.arbitrate(body, pool, legs);

    return {
      response: arbiterResult,
      poolName: pool.name,
      arbiterStrategy: pool.arbiterStrategy,
      legCount: legs.length,
      legModels: legs.map(l => l.modelId),
      arbiterModel: pool.arbiterModelId,
    };
  }

  /**
   * Run the arbiter strategy on the collected leg responses.
   */
  private async arbitrate(
    body: ChatCompletionRequest,
    pool: FusionPool,
    legs: Array<{ modelId: string; providerId: number; response: ChatCompletionResponse }>,
  ): Promise<ChatCompletionResponse> {
    switch (pool.arbiterStrategy) {
      case "best_of_n":
        return await this.bestOfN(body, pool, legs);
      case "synthesize":
        return await this.synthesize(body, pool, legs);
      case "majority":
        return this.majority(pool, legs);
      default:
        return await this.bestOfN(body, pool, legs);
    }
  }

  /**
   * best_of_n: Judge model reads all candidates, returns the single best one verbatim.
   */
  private async bestOfN(
    body: ChatCompletionRequest,
    pool: FusionPool,
    legs: Array<{ modelId: string; response: ChatCompletionResponse }>,
  ): Promise<ChatCompletionResponse> {
    const candidates = legs.map((leg, i) => ({
      index: i,
      model: leg.modelId,
      content: leg.response.choices[0]?.message?.content ?? "",
    }));

    const judgePrompt = this.buildJudgePrompt(body, candidates);
    const judgeResponse = await this.callArbiter(pool.arbiterModelId, judgePrompt);

    // Parse the judge's pick — expects a number (1-indexed)
    const pickIdx = this.parseJudgePick(judgeResponse, candidates.length);

    if (pickIdx !== null && pickIdx >= 0 && pickIdx < legs.length) {
      const winner = legs[pickIdx].response;
      return {
        ...winner,
        model: `fusion:${pool.name}`,
        choices: [{
          ...winner.choices[0],
          // Keep the winner's content verbatim
        }],
      };
    }

    // Fallback: return the first leg's response
    return { ...legs[0].response, model: `fusion:${pool.name}` };
  }

  /**
   * synthesize: Synthesizer model produces a fused response from all candidates.
   */
  private async synthesize(
    body: ChatCompletionRequest,
    pool: FusionPool,
    legs: Array<{ modelId: string; response: ChatCompletionResponse }>,
  ): Promise<ChatCompletionResponse> {
    const candidates = legs.map(leg => ({
      model: leg.modelId,
      content: leg.response.choices[0]?.message?.content ?? "",
    }));

    const synthPrompt = this.buildSynthesizePrompt(body, candidates);
    const synthResponse = await this.callArbiter(pool.arbiterModelId, synthPrompt);

    return {
      id: `fusion-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: `fusion:${pool.name}`,
      choices: [{
        index: 0,
        message: { role: "assistant", content: synthResponse },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: body.messages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 0), 0) / 4 | 0,
        completion_tokens: Math.ceil(synthResponse.length / 4),
        total_tokens: 0, // will be filled by caller
      },
    };
  }

  /**
   * majority: Returns the response that the plurality of models agree on.
   * Compares content similarity; if no clear majority, returns the first.
   */
  private majority(
    pool: FusionPool,
    legs: Array<{ modelId: string; response: ChatCompletionResponse }>,
  ): ChatCompletionResponse {
    const contents = legs.map(l => l.response.choices[0]?.message?.content ?? "");

    // Group by content similarity (first 200 chars as fingerprint)
    const groups = new Map<string, number[]>();
    for (let i = 0; i < contents.length; i++) {
      const fingerprint = contents[i].slice(0, 200).trim().toLowerCase();
      if (!groups.has(fingerprint)) groups.set(fingerprint, []);
      groups.get(fingerprint)!.push(i);
    }

    // Find the largest group
    let maxGroup: number[] = [0];
    for (const indices of groups.values()) {
      if (indices.length > maxGroup.length) maxGroup = indices;
    }

    const winnerIdx = maxGroup[0];
    return { ...legs[winnerIdx].response, model: `fusion:${pool.name}` };
  }

  // ── Helpers ──

  private async callArbiter(modelId: string, prompt: string): Promise<string> {
    // Find provider for arbiter model
    const model = this.providers.getModel(modelId);
    if (!model) {
      throw new FusionError(`Arbiter model '${modelId}' not found`, 500);
    }

    const provider = this.providers.get(model.providerId);
    if (!provider || !provider.enabled) {
      throw new FusionError(`Arbiter provider not available`, 500);
    }

    const decision = this.guard.tryAcquire(provider, 1000);
    if (!decision.allowed || !decision.key) {
      throw new FusionError(`Arbiter provider rate limited`, 429);
    }

    const { response } = await this.proxy.forwardBuffered(
      provider,
      modelId,
      {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      },
      decision.key,
    );

    return response.choices[0]?.message?.content ?? "";
  }

  private buildJudgePrompt(
    original: ChatCompletionRequest,
    candidates: Array<{ index: number; model: string; content: string }>,
  ): string {
    const originalPrompt = typeof original.messages[original.messages.length - 1]?.content === "string"
      ? original.messages[original.messages.length - 1]?.content as string
      : "the user's question";

    const candidateText = candidates
      .map(c => `--- Candidate ${c.index + 1} (${c.model}) ---\n${c.content}`)
      .join("\n\n");

    return `You are a judge evaluating multiple AI responses to the same prompt. Read all candidates carefully and pick the single best response.

Original user prompt:
${originalPrompt}

Candidates:
${candidateText}

Instructions:
1. Evaluate each candidate for accuracy, completeness, clarity, and helpfulness.
2. Pick the single best candidate.
3. Respond with ONLY the number of the best candidate (1 through ${candidates.length}). No other text.

Best candidate number:`;
  }

  private buildSynthesizePrompt(
    original: ChatCompletionRequest,
    candidates: Array<{ model: string; content: string }>,
  ): string {
    const originalPrompt = typeof original.messages[original.messages.length - 1]?.content === "string"
      ? original.messages[original.messages.length - 1]?.content as string
      : "the user's question";

    const candidateText = candidates
      .map(c => `--- Response from ${c.model} ---\n${c.content}`)
      .join("\n\n");

    return `You are a synthesis model. Multiple AI models have responded to the same prompt. Your job is to synthesize the best aspects of all responses into a single, comprehensive, high-quality response.

Original user prompt:
${originalPrompt}

Model responses:
${candidateText}

Instructions:
1. Identify the best elements from each response.
2. Combine them into a single, coherent response.
3. Fill any gaps and resolve any contradictions.
4. Do not mention the individual models or that this is a synthesis — just provide the best possible answer.

Your synthesized response:`;
  }

  private parseJudgePick(response: string, max: number): number | null {
    // Try to find a number in the response
    const match = response.match(/\b(\d+)\b/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= max) return num - 1; // convert to 0-indexed
    }
    return null;
  }
}

export class FusionError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "FusionError";
  }
}
