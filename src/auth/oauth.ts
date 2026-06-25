import { randomBytes, randomUUID, createHash } from "crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
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

// ── PKCE helpers ──

function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── Provider OAuth configs ──

type FlowType = "device" | "web" | "token_paste" | "minimax_device" | "kiro_device" | "pkce_paste" | "pkce_redirect";

interface OAuthProviderConfig {
  flowType: FlowType;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  authorizeUrl?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  redirectUris?: string[];
  // PKCE redirect (OpenAI, xAI)
  callbackPort?: number;
  redirectUri?: string;
  // Extra authorize params (e.g. nonce for xAI)
  extraAuthorizeParams?: Record<string, string>;
  // MiniMax
  minimaxRegion?: "china" | "international";
  // Kiro
  kiroStartUrl?: string;
  kiroScopes?: string[];
}

const MINIMAX_INTERNATIONAL_BASE = "https://api.minimax.io";
const MINIMAX_CHINA_BASE = "https://api.minimaxi.com";

const KIRO_BASE_URL = "https://oidc.us-east-1.amazonaws.com";
const KIRO_START_URL = "https://view.awsapps.com/start";
const KIRO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:taskassist",
  "codewhisperer:transformations",
];

const PROVIDER_CONFIGS: Record<string, OAuthProviderConfig> = {
  // GitHub Copilot — device flow (standard RFC 8628)
  "github-copilot": {
    flowType: "device",
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
  // MiniMax — custom device flow with PKCE + user_code grant
  "minimax": {
    flowType: "minimax_device",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
    scope: "group_id profile model.completion",
    tokenUrl: `${MINIMAX_INTERNATIONAL_BASE}/oauth/token`,
    deviceCodeUrl: `${MINIMAX_INTERNATIONAL_BASE}/oauth/code`,
    minimaxRegion: "international",
  },
  // Kiro — AWS SSO OIDC device flow (dynamic client registration)
  "kiro": {
    flowType: "kiro_device",
    tokenUrl: `${KIRO_BASE_URL}/token`,
    deviceCodeUrl: `${KIRO_BASE_URL}/device_authorization`,
    kiroStartUrl: KIRO_START_URL,
    kiroScopes: KIRO_SCOPES,
  },
  // Anthropic — PKCE redirect with manual paste
  "anthropic": {
    flowType: "pkce_paste",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scope: "org:create_api_key user:profile user:inference",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
  },
  // OpenAI — PKCE redirect with local callback server
  "openai": {
    flowType: "pkce_redirect",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scope: "openid profile email offline_access",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    callbackPort: 1455,
    redirectUri: "http://127.0.0.1:1455/callback",
  },
  // xAI — PKCE redirect with local callback server
  "xai": {
    flowType: "pkce_redirect",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scope: "openid profile email offline_access grok-cli:access api:access",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    callbackPort: 56121,
    redirectUri: "http://127.0.0.1:56121/callback",
    extraAuthorizeParams: { nonce: "" }, // nonce generated per-flow in startPkceRedirectFlow
  },
};

// Active state for web flow and PKCE flows (state → flow metadata)
interface PendingWebFlow {
  providerName: string;
  redirectUri: string;
  createdAt: number;
}

interface PendingPkceFlow {
  providerName: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

// Pending flows for custom device flows (MiniMax/Kiro)
interface PendingMinimaxFlow {
  userCode: string;
  codeVerifier: string;
  interval: number;
  createdAt: number;
}

interface PendingKiroFlow {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  interval: number;
  createdAt: number;
}

// ── OAuthService ──

export class OAuthService {
  private pendingWebFlows = new Map<string, PendingWebFlow>();
  private pendingPkceFlows = new Map<string, PendingPkceFlow>();
  private pendingMinimaxFlows = new Map<string, PendingMinimaxFlow>();
  private pendingKiroFlows = new Map<string, PendingKiroFlow>();
  private callbackServers = new Map<string, HttpServer>();

  constructor(
    private db: DatabaseService,
    private crypto: CryptoService,
    private providers: ProviderService,
  ) {}

  // ════════════════════════════════════════
  //  DISPATCHER: startFlow — routes based on flowType
  // ════════════════════════════════════════

  async startFlow(providerName: string, body?: any): Promise<any> {
    const config = this.getConfig(providerName);
    switch (config.flowType) {
      case "device":
        return this.startDeviceFlow(providerName);
      case "web":
        return this.startWebFlow(providerName, body?.redirectUri ?? `http://localhost:18080/v1/admin/oauth/${providerName}/callback`);
      case "minimax_device":
        return this.startMinimaxFlow(providerName);
      case "kiro_device":
        return this.startKiroFlow(providerName);
      case "pkce_paste":
        return this.startPkcePasteFlow(providerName);
      case "pkce_redirect":
        return this.startPkceRedirectFlow(providerName);
      default:
        throw new Error(`Unsupported flow type '${config.flowType}' for provider '${providerName}'`);
    }
  }

  // ════════════════════════════════════════
  //  DISPATCHER: pollFlow — polls device-type flows
  // ════════════════════════════════════════

  async pollFlow(providerName: string, deviceCode: string): Promise<DevicePollResponse> {
    const config = this.getConfig(providerName);
    switch (config.flowType) {
      case "device":
        return this.pollDeviceFlow(providerName, deviceCode);
      case "minimax_device":
        return this.pollMinimaxFlow(providerName, deviceCode);
      case "kiro_device":
        return this.pollKiroFlow(providerName, deviceCode);
      default:
        throw new Error(`Provider '${providerName}' does not support polling`);
    }
  }

  // ════════════════════════════════════════
  //  DISPATCHER: exchangeCodeManual — manual code exchange (Anthropic paste, PKCE redirect)
  // ════════════════════════════════════════

  async exchangeCodeManual(providerName: string, code: string, state?: string): Promise<TokenExchangeResponse> {
    const config = this.getConfig(providerName);
    switch (config.flowType) {
      case "pkce_paste":
        return this.exchangePkceCode(providerName, code, state);
      case "pkce_redirect":
        return this.exchangePkceCode(providerName, code, state);
      default:
        throw new Error(`Provider '${providerName}' does not support manual code exchange`);
    }
  }

  // ── Standard Device Flow (RFC 8628) ──

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

  // ── Web Flow (standard OAuth 2.0 authorization code) ──

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

  // ════════════════════════════════════════
  //  MiniMax — custom device flow with PKCE + user_code grant
  // ════════════════════════════════════════

  async startMinimaxFlow(providerName: string): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
  }> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "minimax_device") {
      throw new Error(`Provider '${providerName}' does not support MiniMax device flow`);
    }
    if (!config.clientId || !config.deviceCodeUrl) {
      throw new Error(`Provider '${providerName}' is missing MiniMax configuration`);
    }

    const codeVerifier = generatePkceVerifier();
    const codeChallenge = computePkceChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");

    const body = new URLSearchParams();
    body.set("response_type", "code");
    body.set("client_id", config.clientId);
    if (config.scope) body.set("scope", config.scope);
    body.set("code_challenge", codeChallenge);
    body.set("code_challenge_method", "S256");
    body.set("state", state);

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
      throw new Error(`MiniMax device flow request failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      user_code: string;
      verification_uri: string;
      expired_in?: number;
      interval?: number;
      state?: string;
    };

    // Store pending flow keyed by user_code (used as device_code for polling)
    const interval = data.interval ?? 5;
    this.pendingMinimaxFlows.set(data.user_code, {
      userCode: data.user_code,
      codeVerifier,
      interval,
      createdAt: Date.now(),
    });
    this.cleanupPendingFlows();

    return {
      device_code: data.user_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      interval,
    };
  }

  async pollMinimaxFlow(providerName: string, userCode: string): Promise<DevicePollResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "minimax_device") {
      throw new Error(`Provider '${providerName}' does not support MiniMax device flow`);
    }
    if (!config.clientId || !config.tokenUrl) {
      throw new Error(`Provider '${providerName}' is missing MiniMax configuration`);
    }

    const pending = this.pendingMinimaxFlows.get(userCode);
    if (!pending) {
      throw new Error(`No pending MiniMax flow for user_code '${userCode}'`);
    }

    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:user_code");
    body.set("client_id", config.clientId);
    body.set("user_code", userCode);
    body.set("code_verifier", pending.codeVerifier);

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
      throw new Error(`MiniMax token poll failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      status?: string;
      access_token?: string;
      refresh_token?: string;
      expired_in?: number;
      resource_url?: string;
      error?: string;
      interval?: number;
    };

    // Check for pending status
    if (data.status === "pending") {
      return { error: "authorization_pending", interval: pending.interval };
    }
    if (data.status === "error" || data.error) {
      return { error: data.error ?? "unknown_error" };
    }

    // Success — store token
    if (data.access_token) {
      this.pendingMinimaxFlows.delete(userCode);
      const provider = this.providers.getByName(providerName);
      if (provider) {
        const expiresAt = data.expired_in
          ? new Date(Date.now() + data.expired_in * 1000).toISOString()
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
    };
  }

  // ════════════════════════════════════════
  //  Kiro — AWS SSO OIDC device flow (dynamic client registration)
  // ════════════════════════════════════════

  async startKiroFlow(providerName: string): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    verification_uri_complete?: string;
  }> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "kiro_device") {
      throw new Error(`Provider '${providerName}' does not support Kiro device flow`);
    }
    if (!config.kiroStartUrl || !config.kiroScopes || !config.deviceCodeUrl) {
      throw new Error(`Provider '${providerName}' is missing Kiro configuration`);
    }

    // Step 1: Dynamic client registration
    const registerResp = await fetch(`${KIRO_BASE_URL}/client/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        clientName: "token-pool",
        clientType: "public",
        scopes: config.kiroScopes,
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      }),
    });

    if (!registerResp.ok) {
      const text = await registerResp.text();
      throw new Error(`Kiro client registration failed: ${registerResp.status} ${text}`);
    }

    const regData = await registerResp.json() as {
      clientId: string;
      clientSecret: string;
    };

    // Step 2: Start device authorization
    const authResp = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        clientId: regData.clientId,
        clientSecret: regData.clientSecret,
        startUrl: config.kiroStartUrl,
      }),
    });

    if (!authResp.ok) {
      const text = await authResp.text();
      throw new Error(`Kiro device authorization failed: ${authResp.status} ${text}`);
    }

    const authData = await authResp.json() as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
      interval: number;
    };

    // Store pending flow
    this.pendingKiroFlows.set(authData.deviceCode, {
      clientId: regData.clientId,
      clientSecret: regData.clientSecret,
      deviceCode: authData.deviceCode,
      interval: authData.interval,
      createdAt: Date.now(),
    });
    this.cleanupPendingFlows();

    return {
      device_code: authData.deviceCode,
      user_code: authData.userCode,
      verification_uri: authData.verificationUri,
      verification_uri_complete: authData.verificationUriComplete,
      interval: authData.interval,
    };
  }

  async pollKiroFlow(providerName: string, deviceCode: string): Promise<DevicePollResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "kiro_device") {
      throw new Error(`Provider '${providerName}' does not support Kiro device flow`);
    }
    if (!config.tokenUrl) {
      throw new Error(`Provider '${providerName}' is missing Kiro token endpoint configuration`);
    }

    const pending = this.pendingKiroFlows.get(deviceCode);
    if (!pending) {
      throw new Error(`No pending Kiro flow for device code '${deviceCode}'`);
    }

    const resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
        deviceCode,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Kiro token poll failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
      error_description?: string;
    };

    // Handle pending/slow_down errors
    if (data.error === "authorization_pending") {
      return { error: "authorization_pending", interval: pending.interval };
    }
    if (data.error === "slow_down") {
      const newInterval = pending.interval + 5;
      pending.interval = newInterval;
      this.pendingKiroFlows.set(deviceCode, pending);
      return { error: "slow_down", interval: newInterval };
    }
    if (data.error) {
      return { error: data.error };
    }

    // Success — store token
    if (data.accessToken) {
      this.pendingKiroFlows.delete(deviceCode);
      const provider = this.providers.getByName(providerName);
      if (provider) {
        const expiresAt = data.expiresIn
          ? new Date(Date.now() + data.expiresIn * 1000).toISOString()
          : "";
        this.storeToken({
          providerId: provider.id,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? "",
          expiresAt,
          scope: (config.kiroScopes ?? []).join(" "),
        });
      }
    }

    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
    };
  }

  // ════════════════════════════════════════
  //  Anthropic — PKCE redirect with manual paste
  // ════════════════════════════════════════

  startPkcePasteFlow(providerName: string): WebFlowResponse {
    const config = this.getConfig(providerName);
    if (config.flowType !== "pkce_paste") {
      throw new Error(`Provider '${providerName}' does not support PKCE paste flow`);
    }
    if (!config.authorizeUrl || !config.clientId || !config.redirectUri) {
      throw new Error(`Provider '${providerName}' is missing PKCE paste configuration`);
    }

    const codeVerifier = generatePkceVerifier();
    const codeChallenge = computePkceChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");

    this.pendingPkceFlows.set(state, {
      providerName,
      codeVerifier,
      redirectUri: config.redirectUri,
      createdAt: Date.now(),
    });
    this.cleanupPendingFlows();

    const params = new URLSearchParams();
    params.set("client_id", config.clientId);
    params.set("redirect_uri", config.redirectUri);
    params.set("response_type", "code");
    if (config.scope) params.set("scope", config.scope);
    params.set("state", state);
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");

    const authUrl = `${config.authorizeUrl}?${params.toString()}`;

    return { auth_url: authUrl, state };
  }

  // ════════════════════════════════════════
  //  OpenAI / xAI — PKCE redirect with local callback server
  // ════════════════════════════════════════

  async startPkceRedirectFlow(providerName: string): Promise<WebFlowResponse & { message: string }> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "pkce_redirect") {
      throw new Error(`Provider '${providerName}' does not support PKCE redirect flow`);
    }
    if (!config.authorizeUrl || !config.clientId || !config.redirectUri || !config.callbackPort) {
      throw new Error(`Provider '${providerName}' is missing PKCE redirect configuration`);
    }

    const codeVerifier = generatePkceVerifier();
    const codeChallenge = computePkceChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");

    this.pendingPkceFlows.set(state, {
      providerName,
      codeVerifier,
      redirectUri: config.redirectUri,
      createdAt: Date.now(),
    });
    this.cleanupPendingFlows();

    const params = new URLSearchParams();
    params.set("client_id", config.clientId);
    params.set("redirect_uri", config.redirectUri);
    params.set("response_type", "code");
    if (config.scope) params.set("scope", config.scope);
    params.set("state", state);
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");

    // Add extra authorize params (e.g. nonce for xAI)
    if (config.extraAuthorizeParams) {
      for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
        // Generate a fresh nonce per flow for xAI
        const val = key === "nonce" && !value ? randomUUID() : value;
        params.set(key, val);
      }
    }

    const authUrl = `${config.authorizeUrl}?${params.toString()}`;

    // Start local callback server
    await this.startCallbackServer(providerName, state, config.callbackPort);

    return {
      auth_url: authUrl,
      state,
      message: `Local callback server started on port ${config.callbackPort}. Visit the auth_url to authorize.`,
    };
  }

  // ════════════════════════════════════════
  //  PKCE code exchange (used by both pkce_paste and pkce_redirect)
  // ════════════════════════════════════════

  async exchangePkceCode(providerName: string, code: string, state?: string): Promise<TokenExchangeResponse> {
    const config = this.getConfig(providerName);
    if (config.flowType !== "pkce_paste" && config.flowType !== "pkce_redirect") {
      throw new Error(`Provider '${providerName}' does not support PKCE code exchange`);
    }
    if (!config.tokenUrl || !config.clientId || !config.redirectUri) {
      throw new Error(`Provider '${providerName}' is missing PKCE token endpoint configuration`);
    }

    // Look up the code verifier from pending flow
    let codeVerifier = "";
    let redirectUri = config.redirectUri;

    if (state) {
      const pending = this.pendingPkceFlows.get(state);
      if (!pending) {
        throw new Error(`Invalid or expired state parameter for PKCE exchange`);
      }
      codeVerifier = pending.codeVerifier;
      redirectUri = pending.redirectUri;
      this.pendingPkceFlows.delete(state);
    } else {
      // For pkce_redirect flows, the callback server may have already resolved the code.
      // Try to find any pending flow for this provider.
      let found = false;
      for (const [s, pending] of this.pendingPkceFlows) {
        if (pending.providerName === providerName) {
          codeVerifier = pending.codeVerifier;
          redirectUri = pending.redirectUri;
          this.pendingPkceFlows.delete(s);
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`No pending PKCE flow found for provider '${providerName}'. Start the flow first.`);
      }
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", config.clientId);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("code_verifier", codeVerifier);

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
      throw new Error(`PKCE token exchange failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
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
      expires_in: data.expires_in ?? 0,
    };
  }

  // ════════════════════════════════════════
  //  Local callback server (OpenAI, xAI)
  // ════════════════════════════════════════

  private startCallbackServer(providerName: string, state: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "", `http://127.0.0.1:${port}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");

          if (code && returnedState === state) {
            // Exchange code for token
            try {
              await this.exchangePkceCode(providerName, code, state);
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>`);
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end(`<html><body><h1>Authorization failed</h1><p>${err.message}</p></body></html>`);
            }
          } else {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body><h1>Invalid callback</h1><p>Missing code or state mismatch.</p></body></html>`);
          }

          // Close the server after handling the callback
          server.close();
          this.callbackServers.delete(state);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use. Close any process using it and try again.`));
        } else {
          reject(err);
        }
      });

      server.listen(port, "127.0.0.1", () => {
        this.callbackServers.set(state, server);
        resolve();
      });
    });
  }

  /** Stop any active callback servers (cleanup) */
  stopCallbackServers(): void {
    for (const [state, server] of this.callbackServers) {
      server.close();
    }
    this.callbackServers.clear();
  }

  // ── Token management ──

  /**
   * Store a raw token (e.g. GitHub PAT or pasted OAuth token) for a provider.
   * Used for providers that don't support device/web flow but accept pasted tokens.
   */
  storeRawToken(providerName: string, accessToken: string, scope?: string): void {
    const provider = this.findProviderByName(providerName);
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found. Add it in the Providers page first.`);
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
    const provider = this.findProviderByName(providerName);
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

  /** Find provider by name, trying exact match and common aliases */
  private findProviderByName(name: string): { id: number } | undefined {
    // Try exact match
    let provider = this.providers.getByName(name);
    if (provider) return provider;

    // Try aliases
    const aliases: Record<string, string[]> = {
      "github-copilot": ["copilot", "github-models", "github"],
      "google": ["gemini", "google-aistudio"],
      "anthropic": ["claude"],
      "openai": ["chatgpt"],
      "xai": ["grok"],
      "kiro": [],
    };
    const altNames = aliases[name] ?? [];
    for (const alt of altNames) {
      provider = this.providers.getByName(alt);
      if (provider) return provider;
    }

    return undefined;
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
    for (const [state, pending] of this.pendingPkceFlows) {
      if (now - pending.createdAt > ttl) {
        this.pendingPkceFlows.delete(state);
      }
    }
    for (const [key, pending] of this.pendingMinimaxFlows) {
      if (now - pending.createdAt > ttl) {
        this.pendingMinimaxFlows.delete(key);
      }
    }
    for (const [key, pending] of this.pendingKiroFlows) {
      if (now - pending.createdAt > ttl) {
        this.pendingKiroFlows.delete(key);
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
