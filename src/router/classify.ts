import type { ChatCompletionRequest, TierName } from "@/types";

export interface ClassificationResult {
  tier: TierName;
  reason: string;
}

/**
 * Layered classification pipeline (fast-path first).
 * 1. Explicit override (X-Router-Tier header)
 * 2. Modality detection (image/audio/video content)
 * 3. Context length (token estimate > threshold → complex)
 * 4. Keyword/heuristic scoring (math, code, step-by-step → reasoning)
 * 5. Token count estimate (short → simple; else standard)
 * 6. Default: standard
 */
export function classifyRequest(
  req: ChatCompletionRequest,
  explicitTier?: string,
  contextLengthThreshold: number = 32000,
): ClassificationResult {
  // 1. Explicit override
  if (explicitTier) {
    const tier = explicitTier as TierName;
    if (isValidTier(tier)) {
      return { tier, reason: "explicit override" };
    }
  }

  // 2. Modality detection
  for (const msg of req.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url" || part.type === "input_audio") {
          return { tier: "multimodal", reason: "media content detected" };
        }
      }
    }
  }

  // 3. Context length
  const tokenEst = estimateTokens(req);
  if (tokenEst > contextLengthThreshold) {
    return { tier: "complex", reason: `token estimate ${tokenEst} > threshold ${contextLengthThreshold}` };
  }

  // 4. Keyword scoring
  const text = extractText(req.messages);
  if (hasReasoningKeywords(text)) {
    return { tier: "reasoning", reason: "reasoning keywords detected" };
  }

  // 5. Token count
  if (tokenEst < 500 && (req.max_tokens ?? 1000) <= 500) {
    return { tier: "simple", reason: "short prompt + short output" };
  }

  // 6. Default
  return { tier: "standard", reason: "default" };
}

function isValidTier(t: string): boolean {
  return ["simple", "standard", "reasoning", "complex", "multimodal"].includes(t);
}

export function estimateTokens(req: ChatCompletionRequest): number {
  const text = extractText(req.messages);
  // Rough: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function extractText(messages: ChatCompletionRequest["messages"]): string {
  return messages
    .map(m => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(p => p.type === "text")
          .map(p => (p as { type: "text"; text: string }).text)
          .join(" ");
      }
      return "";
    })
    .join(" ");
}

const REASONING_KEYWORDS = [
  "step by step", "reasoning", "prove", "math", "equation", "logic",
  "theorem", "proof", "derive", "calculate", "solve for", "optimization",
  "algorithm", "complexity", "induction", "deduction", "chain of thought",
  "think through", "analyze the tradeoffs", "walk me through",
];

function hasReasoningKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return REASONING_KEYWORDS.some(kw => lower.includes(kw));
}
