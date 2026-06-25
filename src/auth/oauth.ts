import { randomBytes } from "crypto";
import type { DatabaseService } from "@/db";
import type { CryptoService } from "@/auth/crypto";
import type { ProviderService } from "@/providers";

// ── Types ──

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

export interface DevicePollResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  interval?: number;
}

export interface WebFlowResponse {
  auth_url: string;
  state: string;
}

export interface TokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface OAuthTokenRow {
  id: number;
  provider_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  created_at: string;
}

export interface MaskedTokenRow {
  id: number;
  providerId: number;
  providerName: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  scope: string | null;
  createdAt: string;
}

// ── Provider OAuth configs ──

type FlowType = "device" | "web";

interface OAuthProviderConfig {
  flowType: FlowType;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authorizeUrl?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  redirectUris?: string[];
}

const PROVIDER_CONFIGS: Record<string, OAuthProviderConfig> = {
  // GitHub Copilot — token paste flow (user provides GitHub OAuth/PAT token,
  // which is exchanged for a Copilot API token at runtime)
  "github-copilot": {
    flowType: "device", // kept as "device" for UI routing; actual impl uses token paste
    clientId: "Iv1.b507a76440c95a4c",
    scope: "read:user",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
  },
  "copilot": {
    flowType: "device",
    clientId: "Iv1.b507a76440c95a4c",
    scope: "read:user",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
  },
  // Google / Gemini — web flow (requires user to register OAuth app)
  "google": {
    flowType: "web",
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    scope: "https://www.googleapis.com/auth/generative-language.retriever",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
  },
  "gemini": {
    flowType: "web",
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    scope: "https://www.googleapis.com/auth/generative-language.retriever",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
  },
  // Kiro — web flow (placeholder config)
  "kiro": {
    flowType: "web",
    scope: "",
    authorizeUrl: "https://kiro.dev/oauth/authorize",
    tokenUrl: "https://kiro.dev/oauth/token",
  },
};

// Active state for web flow (state → provider name)
interface PendingWebFlow {
  providerName: string;
  redirectUri: string;
  createdAt: number;
}

// ── OAuthService ──

export class OAuthService {
  private pendingWebFlows = new Map<string, PendingWebFlow>();

  constructor(
    private db: DatabaseService,
    private crypto: CryptoService,
    private providers: ProviderService,
  ) {}

  // ── Device Flow ──

  async startDeviceFlow(providerName: string): Promise<DeviceFlowResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "device") {
      throw new Error(`Provider '${providerName}' does not support device flow`);
    }
    if (!config.deviceCodeUrl || !config.clientId) {
      throw new Error(`Provider '${providerName}' is missing device flow configuration`);
    }

    const body = new URLSearchParams();
    body.set("client_id", config.clientId);
    if (config.scope) body.set("scope", config.scope);

    const resp = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Device flow request failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval: data.interval,
    };
  }

  async pollDeviceFlow(providerName: string, deviceCode: string): Promise<DevicePollResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "device") {
      throw new Error(`Provider '${providerName}' does not support device flow`);
    }
    if (!config.tokenUrl || !config.clientId) {
      throw new Error(`Provider '${providerName}' is missing token endpoint configuration`);
    }

    const body = new URLSearchParams();
    body.set("client_id", config.clientId);
    body.set("device_code", deviceCode);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

    const resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token poll failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
      interval?: number;
      expires_in?: number;
      token_type?: string;
    };

    // If we got an access token, persist it
    if (data.access_token) {
      const provider = this.providers.getByName(providerName);
      if (provider) {
        const expiresAt = data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : "";
        this.storeToken({
          providerId: provider.id,
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? "",
          expiresAt,
          scope: config.scope ?? "",
        });
      }
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      error: data.error,
      interval: data.interval,
    };
  }

  // ── Web Flow ──

  startWebFlow(providerName: string, redirectUri: string): WebFlowResponse {
    const config = this.getConfig(providerName);
    if (config.flowType !== "web") {
      throw new Error(`Provider '${providerName}' does not support web flow`);
    }
    if (!config.authorizeUrl) {
      throw new Error(`Provider '${providerName}' is missing authorize URL configuration`);
    }
    if (!config.clientId) {
      throw new Error(`Provider '${providerName}' requires GOOGLE_OAUTH_CLIENT_ID env var. Register an OAuth app at https://console.cloud.google.com/apis/credentials and set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET.`);
    }

    const state = randomBytes(16).toString("hex");
    this.pendingWebFlows.set(state, {
      providerName,
      redirectUri,
      createdAt: Date.now(),
    });

    // Clean up old pending flows (older than 10 minutes)
    this.cleanupPendingFlows();

    const params = new URLSearchParams();
    if (config.clientId) params.set("client_id", config.clientId);
    params.set("redirect_uri", redirectUri);
    params.set("response_type", "code");
    if (config.scope) params.set("scope", config.scope);
    params.set("state", state);

    const authUrl = `${config.authorizeUrl}?${params.toString()}`;

    return { auth_url: authUrl, state };
  }

  async exchangeCode(
    providerName: string,
    code: string,
    redirectUri: string,
  ): Promise<TokenExchangeResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "web") {
      throw new Error(`Provider '${providerName}' does not support web flow`);
    }
    if (!config.tokenUrl || !config.clientId) {
      throw new Error(`Provider '${providerName}' is missing token endpoint configuration`);
    }

    const body = new URLSearchParams();
    body.set("client_id", config.clientId);
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("grant_type", "authorization_code");

    const resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type?: string;
    };

    // Persist the token
    const provider = this.providers.getByName(providerName);
    if (provider) {
      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : "";
      this.storeToken({
        providerId: provider.id,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresAt,
        scope: config.scope ?? "",
      });
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? "",
      expires_in: data.expires_in,
    };
  }

  // ── Token management ──

  /**
   * Store a raw token (e.g. GitHub PAT or pasted OAuth token) for a provider.
   * Used for providers that don't support device/web flow but accept pasted tokens.
   */
  storeRawToken(providerName: string, accessToken: string, scope?: string): void {
    const provider = this.providers.getByName(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`);
    }
    this.storeToken({
      providerId: provider.id,
      accessToken,
      refreshToken: "",
      expiresAt: "",
      scope: scope ?? "",
    });
  }

  async refreshToken(providerName: string, providerId: number): Promise<string> {
    const config = this.getConfig(providerName);
    if (!config.tokenUrl || !config.clientId) {
      throw new Error(`Provider '${providerName}' is missing token endpoint configuration`);
    }

    const row = this.getTokenRow(providerId);
    if (!row || !row.refresh_token) {
      throw new Error(`No refresh token stored for provider '${providerName}'`);
    }

    const refreshTokenPlain = this.crypto.decrypt(row.refresh_token);

    const body = new URLSearchParams();
    body.set("client_id", config.clientId);
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    body.set("refresh_token", refreshTokenPlain);
    body.set("grant_type", "refresh_token");

    const resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Update stored token
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : "";

    this.updateTokenRow(providerId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshTokenPlain,
      expiresAt,
    });

    return data.access_token;
  }

  getToken(providerId: number): string | null {
    const row = this.getTokenRow(providerId);
    if (!row) return null;

    // Check if token is expired
    if (row.expires_at) {
      const expiresAt = new Date(row.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        return null;
      }
    }

    try {
      return this.crypto.decrypt(row.access_token);
    } catch {
      return null;
    }
  }

  // ── Token listing / disconnect ──

  listTokens(): MaskedTokenRow[] {
    const rows = this.db.prepare(
      "SELECT ot.*, p.name as provider_name FROM oauth_tokens ot LEFT JOIN providers p ON ot.provider_id = p.id ORDER BY ot.created_at DESC"
    ).all() as (OAuthTokenRow & { provider_name: string })[];

    return rows.map(r => ({
      id: r.id,
      providerId: r.provider_id,
      providerName: r.provider_name ?? "unknown",
      hasAccessToken: !!r.access_token,
      hasRefreshToken: !!r.refresh_token,
      expiresAt: r.expires_at || null,
      scope: r.scope || null,
      createdAt: r.created_at,
    }));
  }

  disconnect(providerName: string): boolean {
    const provider = this.providers.getByName(providerName);
    if (!provider) return false;

    const result = this.db.prepare(
      "DELETE FROM oauth_tokens WHERE provider_id = ?"
    ).run(provider.id);
    return result.changes > 0;
  }

  // ── Internal helpers ──

  getFlowType(providerName: string): FlowType {
    const config = this.getConfig(providerName);
    return config.flowType;
  }

  private getConfig(providerName: string): OAuthProviderConfig {
    // Try exact match first
    const config = PROVIDER_CONFIGS[providerName];
    if (config) return config;

    // Try case-insensitive
    const lower = providerName.toLowerCase();
    for (const [key, val] of Object.entries(PROVIDER_CONFIGS)) {
      if (key.toLowerCase() === lower) return val;
    }

    throw new Error(`No OAuth configuration for provider '${providerName}'`);
  }

  private storeToken(params: {
    providerId: number;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope: string;
  }): void {
    const encAccess = this.crypto.encrypt(params.accessToken);
    const encRefresh = params.refreshToken ? this.crypto.encrypt(params.refreshToken) : "";

    // Check if a token already exists for this provider
    const existing = this.db.prepare(
      "SELECT id FROM oauth_tokens WHERE provider_id = ?"
    ).get(params.providerId) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ? WHERE id = ?`
      ).run(encAccess, encRefresh, params.expiresAt, params.scope, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO oauth_tokens (provider_id, access_token, refresh_token, expires_at, scope)
         VALUES (?, ?, ?, ?, ?)`
      ).run(params.providerId, encAccess, encRefresh, params.expiresAt, params.scope);
    }
  }

  private getTokenRow(providerId: number): OAuthTokenRow | undefined {
    return this.db.prepare(
      "SELECT * FROM oauth_tokens WHERE provider_id = ?"
    ).get(providerId) as OAuthTokenRow | undefined;
  }

  private updateTokenRow(providerId: number, params: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  }): void {
    const encAccess = this.crypto.encrypt(params.accessToken);
    const encRefresh = params.refreshToken ? this.crypto.encrypt(params.refreshToken) : "";

    this.db.prepare(
      `UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE provider_id = ?`
    ).run(encAccess, encRefresh, params.expiresAt, providerId);
  }

  private cleanupPendingFlows(): void {
    const now = Date.now();
    const ttl = 10 * 60 * 1000; // 10 minutes
    for (const [state, pending] of this.pendingWebFlows) {
      if (now - pending.createdAt > ttl) {
        this.pendingWebFlows.delete(state);
      }
    }
  }

  /** Consume a pending web flow state, returning the provider name and redirect URI */
  consumeState(state: string): { providerName: string; redirectUri: string } | null {
    const pending = this.pendingWebFlows.get(state);
    if (!pending) return null;
    this.pendingWebFlows.delete(state);
    return { providerName: pending.providerName, redirectUri: pending.redirectUri };
  }
}
