import { request } from "undici";
import type { ProviderService } from "@/providers";
import type { ModelMetadata } from "@/types";

const MODELS_DEV_URL = "https://models.dev/api/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface ModelsDevModel {
  id: string;
  name: string;
  provider: string;
  context_window?: number;
  modality?: {
    input?: string[];
    output?: string[];
  };
  pricing?: {
    input?: string;
    output?: string;
  };
  max_output_tokens?: number;
  supported_parameters?: string[];
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
}

export class ModelMetadataSync {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private providers: ProviderService,
    private refreshIntervalSec: number = 3600,
  ) {}

  /**
   * Start background sync on interval. Fetches once immediately, then on schedule.
   */
  start(): void {
    this.sync().catch(err => console.error("[models-sync] initial fetch failed:", err));
    this.intervalHandle = setInterval(() => {
      this.sync().catch(err => console.error("[models-sync] periodic fetch failed:", err));
    }, this.refreshIntervalSec * 1000);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Fetch from models.dev first, then OpenRouter as fallback.
   * Merge results into the model metadata cache.
   */
  async sync(): Promise<{ fetched: number; source: string }> {
    try {
      const count = await this.fetchFromModelsDev();
      if (count > 0) return { fetched: count, source: "models.dev" };
    } catch (err) {
      console.warn("[models-sync] models.dev fetch failed, trying OpenRouter:", err);
    }

    try {
      const count = await this.fetchFromOpenRouter();
      return { fetched: count, source: "openrouter" };
    } catch (err) {
      console.error("[models-sync] all sources failed:", err);
      return { fetched: 0, source: "none" };
    }
  }

  private async fetchFromModelsDev(): Promise<number> {
    const resp = await request(MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`models.dev returned ${resp.statusCode}`);
    }
    const body = await resp.body.json() as ModelsDevModel[];
    let count = 0;

    for (const m of body) {
      // Find or create provider by name
      let provider = this.providers.getByName(m.provider);
      if (!provider) {
        const id = this.providers.create({
          name: m.provider,
          baseUrl: "",
          type: "free",
          wireFormat: "openai",
          rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          enabled: false, // disabled until user configures base URL + key
        });
        provider = this.providers.get(id);
      }
      if (!provider) continue;

      const inputModalities = m.modality?.input ?? [];
      const supportsVision = inputModalities.includes("image");
      const supportsAudio = inputModalities.includes("audio");
      const supportsTools = m.supported_parameters?.includes("tools") ?? false;

      this.providers.upsertModel({
        providerId: provider.id,
        modelId: m.id,
        name: m.name ?? m.id,
        contextWindow: m.context_window ?? 0,
        supportsVision,
        supportsAudio,
        supportsTools,
        inputCostPerMtok: m.pricing?.input ? parseFloat(m.pricing.input) : null,
        outputCostPerMtok: m.pricing?.output ? parseFloat(m.pricing.output) : null,
        maxOutputTokens: m.max_output_tokens ?? null,
      });
      count++;
    }

    return count;
  }

  private async fetchFromOpenRouter(): Promise<number> {
    const resp = await request(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
    });
    if (resp.statusCode !== 200) {
      throw new Error(`OpenRouter returned ${resp.statusCode}`);
    }
    const body = await resp.body.json() as { data: OpenRouterModel[] };
    let count = 0;

    for (const m of body.data) {
      // OpenRouter model IDs are "provider/model" — extract provider name
      const slashIdx = m.id.indexOf("/");
      if (slashIdx === -1) continue;
      const providerName = m.id.substring(0, slashIdx);

      let provider = this.providers.getByName(providerName);
      if (!provider) {
        const id = this.providers.create({
          name: providerName,
          baseUrl: "",
          type: "free",
          wireFormat: "openai",
          rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          enabled: false,
        });
        provider = this.providers.get(id);
      }
      if (!provider) continue;

      const inputModalities = m.architecture?.input_modalities ?? [];
      const supportsVision = inputModalities.includes("image");
      const supportsAudio = inputModalities.includes("audio");
      const supportsTools = m.supported_parameters?.includes("tools") ?? false;

      this.providers.upsertModel({
        providerId: provider.id,
        modelId: m.id,
        name: m.name ?? m.id,
        contextWindow: m.context_length ?? 0,
        supportsVision,
        supportsAudio,
        supportsTools,
        inputCostPerMtok: m.pricing?.prompt ? parseFloat(m.pricing.prompt) : null,
        outputCostPerMtok: m.pricing?.completion ? parseFloat(m.pricing.completion) : null,
        maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
      });
      count++;
    }

    return count;
  }
}
