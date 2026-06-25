import { describe, it, expect } from "vitest";
import { classifyRequest, estimateTokens } from "@/router/classify";
import type { ChatCompletionRequest } from "@/types";

describe("classifyRequest", () => {
  it("respects explicit tier override", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = classifyRequest(req, "reasoning");
    expect(result.tier).toBe("reasoning");
    expect(result.reason).toBe("explicit override");
  });

  it("detects multimodal from image content", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    };
    const result = classifyRequest(req);
    expect(result.tier).toBe("multimodal");
  });

  it("escalates to complex for long context", () => {
    const longText = "x".repeat(200000);
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: longText }],
    };
    const result = classifyRequest(req);
    expect(result.tier).toBe("complex");
  });

  it("detects reasoning keywords", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "prove step by step that the sum of two odd numbers is even" }],
    };
    const result = classifyRequest(req);
    expect(result.tier).toBe("reasoning");
  });

  it("classifies short prompts as simple", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    };
    const result = classifyRequest(req);
    expect(result.tier).toBe("simple");
  });

  it("defaults to standard", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "write a paragraph about cats" }],
    };
    const result = classifyRequest(req);
    expect(result.tier).toBe("standard");
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    const req: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello world" }],
    };
    expect(estimateTokens(req)).toBe(3); // 11 chars / 4 = 2.75 → 3
  });
});
