import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, AreaChart, Area,
} from "recharts";

// ── Theme bootstrap (must run before first paint) ──

const themeStyle = `
:root {
  --bg: #f5f5f5;
  --surface: #fff;
  --text: #1a1a1a;
  --text-secondary: #666;
  --border: #e0e0e0;
  --accent: #4285f4;
  --success: #2d5;
  --danger: #d33;
  --badge-bg: #f0f0f0;
}
:root.dark {
  --bg: #1a1a2e;
  --surface: #16213e;
  --text: #eee;
  --text-secondary: #999;
  --border: #333;
  --accent: #4285f4;
  --success: #2d5;
  --danger: #e55;
  --badge-bg: #2a2a4a;
}
body { background: var(--bg); color: var(--text); margin: 0; }
* { box-sizing: border-box; }
@keyframes slideIn {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}
`;

// Inject the style element + apply theme class before React renders
const styleEl = document.createElement("style");
styleEl.textContent = themeStyle;
document.head.appendChild(styleEl);

// Apply theme: localStorage wins, otherwise follow system preference
function getPreferredTheme(): "light" | "dark" {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(t: "light" | "dark") {
  if (t === "dark") document.documentElement.classList.add("dark");
  else document.documentElement.classList.remove("dark");
}

applyTheme(getPreferredTheme());

// If user hasn't set a manual preference, track system theme changes
if (!localStorage.getItem("theme")) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    applyTheme(e.matches ? "dark" : "light");
  });
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  );
  const toggle = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, toggle };
}

// ── API helper ──

const API = "/v1";

function getToken(): string | null {
  return localStorage.getItem("token");
}

async function api(path: string, options?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...(options?.headers as any) } });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Login ──

function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem("token", data.token);
      onLogin();
    } catch {
      setError("Invalid credentials");
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "100px auto" }}>
      <h1>token-pool</h1>
      <form onSubmit={submit}>
        <input placeholder="username" value={username} onChange={e => setUsername(e.target.value)} style={inputStyle} />
        <input type="password" placeholder="password" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
        {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
        <button type="submit" style={btnStyle}>Login</button>
      </form>
    </div>
  );
}

// ── Providers ──

const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: "free", label: "Free Tier", color: "#2d5" },
  { key: "paid", label: "Paid", color: "#59f" },
  { key: "local", label: "Local", color: "#fa0" },
  { key: "subscription", label: "Subscription", color: "#c5f" },
];

// ── Provider presets with metadata ──
interface ProviderPreset {
  name: string;
  initial: string;
  color: string;
  subtitle: string;
  baseUrl: string;
  type: string;
  wireFormat: string;
  rpm?: number | null;
  rpd?: number | null;
  tpm?: number | null;
  tpd?: number | null;
  keyHint?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  // Free
  { name: "OpenRouter", initial: "OR", color: "#5d5d5d", subtitle: "Free models, 300+ options", baseUrl: "https://openrouter.ai/api/v1", type: "free", wireFormat: "openai", rpm: 20, rpd: 1000, keyHint: "sk-or-..." },
  { name: "Google AI Studio", initial: "G", color: "#4285f4", subtitle: "Gemini 2.0 Flash, Gemma", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", type: "free", wireFormat: "openai", rpm: 15, rpd: 1500, tpm: 250000, keyHint: "AIza..." },
  { name: "Groq", initial: "Gq", color: "#f55036", subtitle: "Llama, Mixtral — ultra-fast", baseUrl: "https://api.groq.com/openai/v1", type: "free", wireFormat: "openai", rpm: 30, rpd: 1000, tpm: 12000, keyHint: "gsk_..." },
  { name: "Cerebras", initial: "Ce", color: "#e63312", subtitle: "Llama 3.1, fast inference", baseUrl: "https://api.cerebras.ai/v1", type: "free", wireFormat: "openai", rpm: 30, rpd: 14400, tpm: 60000, keyHint: "csk-..." },
  { name: "Mistral", initial: "M", color: "#ff7000", subtitle: "Mistral, Mixtral models", baseUrl: "https://api.mistral.ai/v1", type: "free", wireFormat: "openai", rpm: 1, tpm: 500000, keyHint: "API key" },
  { name: "GitHub Models", initial: "GH", color: "#24292e", subtitle: "GPT, Llama, Phi via GitHub", baseUrl: "https://models.inference.ai.azure.com", type: "free", wireFormat: "openai", keyHint: "ghp_..." },
  { name: "Cohere", initial: "Co", color: "#39594d", subtitle: "Command R, Embed", baseUrl: "https://api.cohere.ai/v1", type: "free", wireFormat: "openai", rpm: 20, tpd: 1000, keyHint: "API key" },
  { name: "HuggingFace", initial: "HF", color: "#ff9d00", subtitle: "Serverless inference models", baseUrl: "https://api-inference.huggingface.co", type: "free", wireFormat: "openai", keyHint: "hf_..." },
  { name: "NVIDIA NIM", initial: "NV", color: "#76b900", subtitle: "Llama, Mistral, Qwen", baseUrl: "https://integrate.api.nvidia.com/v1", type: "free", wireFormat: "openai", rpm: 40, keyHint: "nvapi-..." },
  { name: "SambaNova", initial: "Sn", color: "#f0503f", subtitle: "Llama, DeepSeek, Qwen", baseUrl: "https://api.sambanova.ai/v1", type: "free", wireFormat: "openai", keyHint: "API key" },
  // Paid
  { name: "OpenAI", initial: "O", color: "#10a37f", subtitle: "GPT-4o, o3, o4", baseUrl: "https://api.openai.com/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Anthropic", initial: "An", color: "#d4a27e", subtitle: "Claude Sonnet, Opus, Haiku", baseUrl: "https://api.anthropic.com", type: "paid", wireFormat: "anthropic", keyHint: "sk-ant-..." },
  { name: "DeepSeek", initial: "DS", color: "#4d6bfe", subtitle: "DeepSeek V3, R1", baseUrl: "https://api.deepseek.com/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "xAI", initial: "xA", color: "#000000", subtitle: "Grok 2, Grok 3", baseUrl: "https://api.x.ai/v1", type: "paid", wireFormat: "openai", keyHint: "xai-..." },
  { name: "MiniMax", initial: "MM", color: "#ff2d55", subtitle: "abab6.5, MiniMax-01", baseUrl: "https://api.minimax.io/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Qwen / Alibaba", initial: "Qw", color: "#615ced", subtitle: "Qwen Plus, Max, QwQ", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Moonshot / Kimi", initial: "Mk", color: "#1e1e1e", subtitle: "Kimi K1.5, Moonshot", baseUrl: "https://api.moonshot.ai/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Z.ai", initial: "Z", color: "#7b2ff7", subtitle: "GLM-4, GLM-Z1", baseUrl: "https://api.z.ai/api/paas/v4", type: "paid", wireFormat: "openai", keyHint: "API key" },
  { name: "Fireworks AI", initial: "Fw", color: "#e25822", subtitle: "Llama, Mixtral, Qwen", baseUrl: "https://api.fireworks.ai/inference/v1", type: "paid", wireFormat: "openai", keyHint: "fw_..." },
  // Local
  { name: "Ollama", initial: "Ol", color: "#ff6b35", subtitle: "Local Llama, Mistral, Qwen", baseUrl: "http://localhost:11434/v1", type: "local", wireFormat: "openai" },
  { name: "llama.cpp", initial: "ll", color: "#8b5cf6", subtitle: "Local GGUF models", baseUrl: "http://localhost:8080/v1", type: "local", wireFormat: "openai" },
  { name: "LM Studio", initial: "LM", color: "#3b82f6", subtitle: "Local desktop inference", baseUrl: "http://localhost:1234/v1", type: "local", wireFormat: "openai" },
  { name: "Custom", initial: "+", color: "#888", subtitle: "Custom provider endpoint", baseUrl: "", type: "free", wireFormat: "openai" },
];

function avatarStyle(color: string): React.CSSProperties {
  return {
    width: 48, height: 48, borderRadius: 12,
    background: color, color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 20, fontWeight: 700, flexShrink: 0,
  };
}

function avatarSmStyle(color: string): React.CSSProperties {
  return {
    width: 32, height: 32, borderRadius: 8,
    background: color, color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 14, fontWeight: 700, flexShrink: 0,
  };
}

const tileStyle: React.CSSProperties = {
  padding: 16, border: "1px solid var(--border)", borderRadius: 12,
  background: "var(--surface)", cursor: "pointer",
  display: "flex", flexDirection: "column", gap: 8,
  transition: "border-color 0.15s, box-shadow 0.15s",
};

function findPreset(provider: any): ProviderPreset | null {
  const match = PROVIDER_PRESETS.find(p => p.name.toLowerCase() === (provider.name || "").toLowerCase());
  if (match) return match;
  // Fallback: match by baseUrl
  const byUrl = PROVIDER_PRESETS.find(p => p.baseUrl && p.baseUrl === provider.baseUrl);
  if (byUrl) return byUrl;
  return null;
}

function getPresetMeta(provider: any): { initial: string; color: string; subtitle: string } {
  const preset = findPreset(provider);
  if (preset) return { initial: preset.initial, color: preset.color, subtitle: preset.subtitle };
  return {
    initial: (provider.name || "?").charAt(0).toUpperCase(),
    color: "#888",
    subtitle: `${provider.wireFormat || "openai"} format`,
  };
}

function statusBadge(p: any, keyCount: number): { label: string; color: string } {
  if (!p.enabled) return { label: "Disabled", color: "#888" };
  if (p.type === "local") return { label: "Ready", color: "var(--success)" };
  if (p.type === "subscription") return { label: "OAuth", color: "#c5f" };
  if (keyCount > 0) return { label: "Connected", color: "var(--success)" };
  return { label: "No key", color: "var(--text-secondary)" };
}

// ── OAuth device flow types ──
interface OAuthState {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

// ── Providers main component ──

function Providers() {
  const [providers, setProviders] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createMode, setCreateMode] = useState(false);
  const [keyCounts, setKeyCounts] = useState<Record<number, number>>({});
  const [oauthConnected, setOauthConnected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const list = await api("/admin/providers");
    setProviders(list);
    // Fetch key counts for each provider
    const counts: Record<number, number> = {};
    await Promise.all(list.map(async (p: any) => {
      try {
        const keys = await api(`/admin/providers/${p.id}/keys`);
        counts[p.id] = Array.isArray(keys) ? keys.length : 0;
      } catch { counts[p.id] = 0; }
    }));
    setKeyCounts(counts);
    // Fetch connected OAuth tokens
    try {
      const tokens = await api("/admin/oauth/tokens");
      const connected = new Set<string>();
      if (Array.isArray(tokens)) {
        tokens.forEach((t: any) => connected.add(t.provider || t.providerId || t.name));
      }
      setOauthConnected(connected);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filter === "all" ? providers : providers.filter(p => p.type === filter);
  const byCategory: Record<string, any[]> = {};
  for (const p of filtered) {
    const cat = p.type || "free";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  const selected = selectedId != null ? providers.find(p => p.id === selectedId) : null;

  if (selected) {
    return <ProviderDetail provider={selected} onBack={() => setSelectedId(null)} onSaved={load} keyCounts={keyCounts} oauthConnected={oauthConnected} />;
  }
  if (createMode) {
    return <ProviderDetail provider={null} onBack={() => setCreateMode(false)} onSaved={async () => { setCreateMode(false); await load(); }} keyCounts={keyCounts} oauthConnected={oauthConnected} />;
  }

  // Empty state
  if (providers.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔌</div>
        <h2 style={{ color: "var(--text)", marginBottom: 8 }}>No providers yet</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>Add your first provider to get started</p>
        <button onClick={() => setCreateMode(true)} style={{ ...btnStyle, fontSize: 16, padding: "12px 24px" }}>+ Add Provider</button>
      </div>
    );
  }

  const hasConnected = providers.some(p => p.enabled && (p.type === "local" || (keyCounts[p.id] ?? 0) > 0 || oauthConnected.has(p.name.toLowerCase())));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--text)" }}>Providers ({providers.length})</h2>
        <button onClick={() => setCreateMode(true)} style={btnStyle}>+ Add Provider</button>
      </div>

      {!hasConnected && (
        <div style={{ ...cardStyle, marginBottom: 16, display: "flex", alignItems: "center", gap: 8, borderLeft: "3px solid var(--accent)" }}>
          <span style={{ fontSize: 16 }}>💡</span>
          <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>No active providers. Click a tile below to add a key or connect.</span>
        </div>
      )}

      {/* Category filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ ...filterBtn, background: filter === "all" ? "var(--accent)" : "var(--badge-bg)", color: filter === "all" ? "#fff" : "var(--text-secondary)" }}>All ({providers.length})</button>
        {CATEGORIES.map(c => {
          const count = providers.filter(p => p.type === c.key).length;
          if (count === 0) return null;
          return (
            <button key={c.key} onClick={() => setFilter(c.key)} style={{ ...filterBtn, background: filter === c.key ? c.color : "var(--badge-bg)", color: filter === c.key ? "#000" : "var(--text-secondary)" }}>
              {c.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Providers grouped by category */}
      {CATEGORIES.map(cat => {
        const items = byCategory[cat.key];
        if (!items || items.length === 0) return null;
        return (
          <div key={cat.key} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: cat.color, display: "inline-block" }} />
              <h3 style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>{cat.label}</h3>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>({items.length})</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {items.map(p => {
                const meta = getPresetMeta(p);
                const status = statusBadge(p, keyCounts[p.id] ?? 0);
                return (
                  <div
                    key={p.id}
                    style={tileStyle}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.boxShadow = "none"; }}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={avatarStyle(meta.color)}>{meta.initial}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.subtitle}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
                      <span style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4,
                        background: status.color === "var(--success)" ? "rgba(34,221,85,0.15)" : "var(--badge-bg)",
                        color: status.color,
                        fontWeight: 600,
                      }}>
                        {status.label}
                      </span>
                      {p.rpmLimit && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.rpmLimit} RPM</span>}
                    </div>
                  </div>
                );
              })}
              {/* Add custom provider tile at end of each category's grid */}
              {cat.key === (CATEGORIES.find(c => byCategory[c.key])?.key) && (
                <div
                  style={{
                    ...tileStyle,
                    border: "2px dashed var(--border)",
                    background: "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 100,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}
                  onClick={() => setCreateMode(true)}
                >
                  <div style={{ fontSize: 32, color: "var(--text-secondary)" }}>+</div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Add Provider</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Provider Detail View ──

function ProviderDetail({ provider, onBack, onSaved, keyCounts, oauthConnected }: {
  provider: any;
  onBack: () => void;
  onSaved: () => void;
  keyCounts: Record<number, number>;
  oauthConnected: Set<string>;
}) {
  const isCreate = !provider;
  const existingPreset = isCreate ? null : findPreset(provider);
  const meta = isCreate ? null : getPresetMeta(provider);

  // Form state
  const [name, setName] = useState(isCreate ? "" : provider.name);
  const [baseUrl, setBaseUrl] = useState(isCreate ? "" : provider.baseUrl || "");
  const [type, setType] = useState(isCreate ? "free" : provider.type || "free");
  const [wireFormat, setWireFormat] = useState(isCreate ? "openai" : provider.wireFormat || "openai");
  const [rpm, setRpm] = useState(isCreate ? "" : (provider.rpmLimit != null ? String(provider.rpmLimit) : ""));
  const [rpd, setRpd] = useState(isCreate ? "" : (provider.rpdLimit != null ? String(provider.rpdLimit) : ""));
  const [tpm, setTpm] = useState(isCreate ? "" : (provider.tpmLimit != null ? String(provider.tpmLimit) : ""));
  const [tpd, setTpd] = useState(isCreate ? "" : (provider.tpdLimit != null ? String(provider.tpdLimit) : ""));
  const [enabled, setEnabled] = useState(isCreate ? true : provider.enabled);
  const [presetIdx, setPresetIdx] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Key management state
  const [keys, setKeys] = useState<any[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [keyError, setKeyError] = useState("");

  // OAuth state
  const [oauthState, setOauthState] = useState<OAuthState | null>(null);
  const [oauthStatus, setOauthStatus] = useState<string>("");
  const [oauthPolling, setOauthPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load keys if editing existing provider
  const loadKeys = useCallback(async () => {
    if (isCreate || !provider) return;
    try {
      const k = await api(`/admin/providers/${provider.id}/keys`);
      setKeys(Array.isArray(k) ? k : []);
    } catch { setKeys([]); }
  }, [isCreate, provider]);

  useEffect(() => {
    loadKeys();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [loadKeys]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  const selectPreset = (idx: number) => {
    setPresetIdx(idx);
    const p = PROVIDER_PRESETS[idx];
    setName(p.name === "Custom" ? "" : p.name);
    setBaseUrl(p.baseUrl);
    setType(p.type);
    setWireFormat(p.wireFormat);
    setRpm(p.rpm != null ? String(p.rpm) : "");
    setRpd(p.rpd != null ? String(p.rpd) : "");
    setTpm(p.tpm != null ? String(p.tpm) : "");
    setTpd(p.tpd != null ? String(p.tpd) : "");
    setError("");
  };

  const save = async () => {
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (!baseUrl.trim() && type !== "local") { setError("Base URL is required"); return; }
    setSaving(true);
    try {
      const body: any = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        type,
        wireFormat,
        rpmLimit: rpm ? Number(rpm) : null,
        rpdLimit: rpd ? Number(rpd) : null,
        tpmLimit: tpm ? Number(tpm) : null,
        tpdLimit: tpd ? Number(tpd) : null,
        enabled,
      };
      if (isCreate) {
        const res = await api("/admin/providers", { method: "POST", body: JSON.stringify(body) });
        if (newKeyValue.trim() && res.id) {
          await api(`/admin/providers/${res.id}/keys`, {
            method: "POST",
            body: JSON.stringify({ apiKey: newKeyValue.trim(), label: newKeyLabel || "default" }),
          });
        }
        await onSaved();
      } else {
        await api(`/admin/providers/${provider.id}`, { method: "PUT", body: JSON.stringify(body) });
        await onSaved();
      }
    } catch (e: any) {
      setError(e.message || "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (isCreate) { setEnabled(!enabled); return; }
    try {
      await api(`/admin/providers/${provider.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...provider, enabled: !enabled }),
      });
      setEnabled(!enabled);
      onSaved();
    } catch (e: any) {
      setError(e.message || "Failed to toggle");
    }
  };

  const addKey = async () => {
    if (!newKeyValue.trim()) { setKeyError("API key is required"); return; }
    setKeyError("");
    try {
      await api(`/admin/providers/${provider.id}/keys`, {
        method: "POST",
        body: JSON.stringify({ apiKey: newKeyValue.trim(), label: newKeyLabel || "default" }),
      });
      setNewKeyValue("");
      setNewKeyLabel("");
      loadKeys();
      onSaved();
    } catch (e: any) {
      setKeyError(e.message || "Failed to add key");
    }
  };

  const delKey = async (keyId: number) => {
    try {
      await api(`/admin/providers/${provider.id}/keys/${keyId}`, { method: "DELETE" });
      loadKeys();
      onSaved();
    } catch (e: any) {
      setKeyError(e.message || "Failed to delete key");
    }
  };

  // ── OAuth device flow ──
  const startOAuth = async () => {
    if (!provider) return;
    setOauthStatus("Initiating OAuth device flow...");
    setOauthPolling(true);
    try {
      const res = await api(`/admin/oauth/${provider.name.toLowerCase()}/start`, { method: "POST" });
      setOauthState(res);
      setOauthStatus(`Go to ${res.verification_uri} and enter code: ${res.user_code}`);
      // Start polling
      const poll = async () => {
        if (pollRef.current) clearTimeout(pollRef.current);
        try {
          const result = await api(`/admin/oauth/${provider.name.toLowerCase()}/poll?device_code=${res.device_code}`);
          setOauthStatus("Connected successfully!");
          setOauthPolling(false);
          onSaved();
        } catch (e: any) {
          const msg = e.message || "";
          if (msg.includes("428") || msg.includes("authorization_pending")) {
            setOauthStatus(`Waiting for authorization... Go to ${res.verification_uri} and enter: ${res.user_code}`);
            pollRef.current = setTimeout(poll, (res.interval || 5) * 1000);
          } else if (msg.includes("410") || msg.includes("expired")) {
            setOauthStatus("Device code expired. Please try again.");
            setOauthPolling(false);
          } else if (msg.includes("400") || msg.includes("declined") || msg.includes("denied")) {
            setOauthStatus("Authorization was declined.");
            setOauthPolling(false);
          } else {
            // Unknown error, keep trying with backoff
            setOauthStatus(`Polling... Go to ${res.verification_uri} and enter: ${res.user_code}`);
            pollRef.current = setTimeout(poll, (res.interval || 5) * 1000);
          }
        }
      };
      pollRef.current = setTimeout(poll, (res.interval || 5) * 1000);
    } catch (e: any) {
      setOauthStatus(`OAuth error: ${e.message || "Failed to start OAuth flow"}`);
      setOauthPolling(false);
    }
  };

  const disconnectOAuth = async () => {
    if (!provider) return;
    if (!confirm("Disconnect OAuth for this provider?")) return;
    try {
      await api(`/admin/oauth/${provider.name.toLowerCase()}`, { method: "DELETE" });
      setOauthStatus("Disconnected.");
      onSaved();
    } catch (e: any) {
      setOauthStatus(`Error: ${e.message}`);
    }
  };

  // Determine display info for header
  const displayMeta = isCreate
    ? { initial: "+", color: "#888", subtitle: "New provider" }
    : meta!;

  const isSubscription = type === "subscription";
  const isLocal = type === "local";
  const isOAuthConnected = !isCreate && oauthConnected.has(provider.name.toLowerCase());
  const currentPreset = isCreate ? PROVIDER_PRESETS[presetIdx] : null;
  const keyHint = currentPreset?.keyHint || existingPreset?.keyHint || "";

  const sectionTitle: React.CSSProperties = {
    fontSize: 13, textTransform: "uppercase", letterSpacing: 1,
    color: "var(--text-secondary)", margin: "0 0 8px", fontWeight: 600,
  };

  const sectionCard: React.CSSProperties = {
    ...cardStyle, marginBottom: 16,
  };

  return (
    <div style={{ animation: "slideIn 0.2s ease-out" }}>
      {/* Back button */}
      <button onClick={onBack} style={{ ...smBtnStyle, marginBottom: 16, display: "inline-flex", alignItems: "center", gap: 4 }}>
        ← Back to providers
      </button>

      {/* Header: avatar + name + subtitle + enable/disable */}
      <div style={{ ...sectionCard, display: "flex", alignItems: "center", gap: 16 }}>
        <div style={avatarStyle(displayMeta.color)}>{displayMeta.initial}</div>
        <div style={{ flex: 1 }}>
          {isCreate ? (
            <input
              placeholder="Provider name"
              value={name}
              onChange={e => setName(e.target.value)}
              style={{ ...inputStyle, margin: 0, fontWeight: 700, fontSize: 18 }}
            />
          ) : (
            <h2 style={{ margin: 0, color: "var(--text)" }}>{provider.name}</h2>
          )}
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
            {isCreate ? "Configure a new provider" : displayMeta.subtitle}
          </div>
        </div>
        {!isCreate && (
          <button
            onClick={toggleEnabled}
            style={{
              ...smBtnStyle,
              background: enabled ? "var(--success)" : "var(--badge-bg)",
              color: enabled ? "#fff" : "var(--text-secondary)",
              padding: "6px 14px",
              fontWeight: 600,
            }}
          >
            {enabled ? "● Enabled" : "○ Disabled"}
          </button>
        )}
      </div>

      {/* In create mode: show preset picker */}
      {isCreate && (
        <div style={sectionCard}>
          <h3 style={sectionTitle}>Choose Template</h3>
          <select
            value={presetIdx}
            onChange={e => selectPreset(Number(e.target.value))}
            style={{ ...inputStyle, cursor: "pointer", margin: 0 }}
          >
            {PROVIDER_PRESETS.map((p, i) => (
              <option key={i} value={i}>
                {p.name} {p.type === "local" ? "(local)" : p.type === "paid" ? "(paid)" : p.type === "subscription" ? "(subscription)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Connection section */}
      {!isLocal && (
        <div style={sectionCard}>
          <h3 style={sectionTitle}>
            {isSubscription ? "OAuth Connection" : "API Keys"}
          </h3>

          {isSubscription ? (
            <div>
              {isOAuthConnected ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ ...badgeStyle, background: "rgba(34,221,85,0.15)", color: "var(--success)" }}>● Connected via OAuth</span>
                  <button onClick={disconnectOAuth} style={{ ...smBtnStyle, color: "var(--danger)" }}>Disconnect</button>
                </div>
              ) : (
                <div>
                  <button onClick={startOAuth} disabled={oauthPolling} style={{ ...btnStyle, opacity: oauthPolling ? 0.6 : 1 }}>
                    {oauthPolling ? "Connecting..." : "Connect via OAuth"}
                  </button>
                  {oauthStatus && (
                    <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "var(--badge-bg)", fontSize: 13, color: "var(--text)" }}>
                      {oauthStatus}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* Existing keys list */}
              {!isCreate && keys.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {keys.map(k => (
                    <div key={k.id} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "8px 12px", marginBottom: 4, borderRadius: 6,
                      background: "var(--badge-bg)", fontSize: 13,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "var(--text)" }}>{k.label || "key"}</span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>pos {k.rrPosition}</span>
                        {k.enabled === false && <span style={{ fontSize: 11, color: "var(--danger)" }}>disabled</span>}
                      </div>
                      <button onClick={() => delKey(k.id)} style={{ color: "var(--danger)", border: "none", cursor: "pointer", background: "transparent", fontSize: 16 }}>×</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add key form */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  placeholder="label (optional)"
                  value={newKeyLabel}
                  onChange={e => setNewKeyLabel(e.target.value)}
                  style={{ ...inputStyle, flex: 1, minWidth: 120, margin: 0 }}
                />
                <input
                  placeholder={keyHint ? `API key (${keyHint})` : "API key"}
                  value={newKeyValue}
                  onChange={e => setNewKeyValue(e.target.value)}
                  type="password"
                  style={{ ...inputStyle, flex: 2, minWidth: 200, margin: 0 }}
                />
                <button onClick={isCreate ? undefined : addKey} style={{ ...btnStyle, whiteSpace: "nowrap" }}>
                  {isCreate ? "Add on create" : "Add Key"}
                </button>
              </div>
              {isCreate && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
                  Key will be added automatically when provider is created
                </div>
              )}
              {keyError && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{keyError}</div>}
            </div>
          )}
        </div>
      )}

      {/* For local providers: show info */}
      {isLocal && (
        <div style={sectionCard}>
          <h3 style={sectionTitle}>Connection</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-secondary)" }}>
            <span>✓</span>
            <span>No API key needed. Token-pool will connect to the base URL directly.</span>
          </div>
        </div>
      )}

      {/* Configuration section */}
      <div style={sectionCard}>
        <h3 style={sectionTitle}>Configuration</h3>

        {!isCreate && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>Base URL</label>
            <input placeholder="https://..." value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Wire Format</label>
            <select value={wireFormat} onChange={e => setWireFormat(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={type} onChange={e => setType(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
              <option value="free">Free Tier</option>
              <option value="paid">Paid</option>
              <option value="local">Local</option>
              <option value="subscription">Subscription</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>RPM Limit</label>
            <input placeholder="—" value={rpm} onChange={e => setRpm(e.target.value)} style={inputStyle} type="number" />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>RPD Limit</label>
            <input placeholder="—" value={rpd} onChange={e => setRpd(e.target.value)} style={inputStyle} type="number" />
          </div>
          <div>
            <label style={labelStyle}>TPM Limit</label>
            <input placeholder="—" value={tpm} onChange={e => setTpm(e.target.value)} style={inputStyle} type="number" />
          </div>
          <div>
            <label style={labelStyle}>TPD Limit</label>
            <input placeholder="—" value={tpd} onChange={e => setTpd(e.target.value)} style={inputStyle} type="number" />
          </div>
        </div>

        {error && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={save} disabled={saving} style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving..." : isCreate ? "Create Provider" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Danger zone */}
      {!isCreate && (
        <div style={{ ...sectionCard, borderColor: "var(--danger)", borderWidth: 1 }}>
          <h3 style={{ ...sectionTitle, color: "var(--danger)" }}>Danger Zone</h3>
          <button
            onClick={async () => {
              if (!confirm("Delete this provider? This cannot be undone.")) return;
              await api(`/admin/providers/${provider.id}`, { method: "DELETE" });
              onSaved();
            }}
            style={{ ...btnStyle, background: "var(--danger)" }}
          >
            Delete Provider
          </button>
        </div>
      )}
    </div>
  );
}

// ── Tiers ──

function Tiers() {
  const [tiers, setTiers] = useState<any[]>([]);
  const [models, setModels] = useState<Record<string, any[]>>({});

  const load = useCallback(async () => {
    const t = await api("/admin/tiers");
    setTiers(t);
    const m: Record<string, any[]> = {};
    for (const tier of t) {
      m[tier.name] = await api(`/admin/tiers/${tier.name}/models`);
    }
    setModels(m);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h2 style={{ color: "var(--text)" }}>Routing Tiers</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {tiers.map(t => (
          <div key={t.id} style={cardStyle}>
            <strong style={{ color: "var(--text)" }}>{t.name}</strong>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{t.description}</div>
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text)" }}>
              {models[t.name]?.length > 0 ? (
                models[t.name].map((m: any, i: number) => (
                  <div key={i}>{m.priority}. {m.model_id} (provider {m.provider_id})</div>
                ))
              ) : (
                <div style={{ color: "var(--text-secondary)" }}>No models configured</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stats ──

const PIE_COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7300", "#e41d3d", "#a8328a", "#327ba8", "#32a85a"];

function StatCard({ title, value, sub, color }: { title: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{
      ...cardStyle,
      borderTop: `3px solid ${color}`,
      textAlign: "center" as const,
    }}>
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-secondary)", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Stats() {
  const [stats, setStats] = useState<any>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setStats(null);
    setStats(await api(`/admin/stats?days=${days}`));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (!stats) return <div style={{ color: "var(--text-secondary)" }}>Loading stats...</div>;

  const total = stats.total || {};
  const totalRequests = total.count ?? 0;
  const totalTokens = (total.inputTokens ?? 0) + (total.outputTokens ?? 0);
  const totalCost = total.totalCost ?? 0;
  const avgLatency = totalRequests > 0 ? (total.avgLatencyMs ?? total.latencyMs ?? 0) : 0;

  const tierData = (stats.byTier || []).map((t: any) => ({ name: t.tier, value: t.count }));
  const dailyData = (stats.daily || []).map((d: any) => ({
    date: d.date,
    count: d.count,
    inputTokens: d.inputTokens || 0,
    outputTokens: d.outputTokens || 0,
  }));
  const providerData = (stats.byProvider || [])
    .map((p: any) => ({ name: `Provider ${p.providerId}`, count: p.count }))
    .sort((a: any, b: any) => b.count - a.count)
    .slice(0, 10);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "var(--text)" }}>Usage Stats</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                ...filterBtn,
                background: days === d ? "var(--accent)" : "var(--badge-bg)",
                color: days === d ? "#fff" : "var(--text-secondary)",
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <StatCard title="Total Requests" value={totalRequests.toLocaleString()} color="#4285f4" />
        <StatCard title="Total Tokens" value={totalTokens.toLocaleString()} sub={`${(total.inputTokens ?? 0).toLocaleString()} in / ${(total.outputTokens ?? 0).toLocaleString()} out`} color="#2d5" />
        <StatCard title="Avg Latency" value={avgLatency > 0 ? `${Math.round(avgLatency)}ms` : "—"} color="#fa0" />
        <StatCard title="Total Cost" value={`$${totalCost.toFixed(2)}`} color="#a8328a" />
      </div>

      {/* Daily Requests — Area chart with gradient */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Daily Requests</h3>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={dailyData}>
            <defs>
              <linearGradient id="reqGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4285f4" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#4285f4" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" stroke="var(--text-secondary)" fontSize={12} />
            <YAxis stroke="var(--text-secondary)" fontSize={12} />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: `1px solid var(--border)`,
                borderRadius: 4,
                color: "var(--text)",
              }}
            />
            <Area type="monotone" dataKey="count" stroke="#4285f4" strokeWidth={2} fill="url(#reqGradient)" name="Requests" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Daily Token Usage — stacked bar */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Daily Token Usage</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={dailyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" stroke="var(--text-secondary)" fontSize={12} />
            <YAxis stroke="var(--text-secondary)" fontSize={12} />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: `1px solid var(--border)`,
                borderRadius: 4,
                color: "var(--text)",
              }}
            />
            <Legend wrapperStyle={{ color: "var(--text)" }} />
            <Bar dataKey="inputTokens" stackId="tokens" fill="#4285f4" name="Input Tokens" />
            <Bar dataKey="outputTokens" stackId="tokens" fill="#2d5" name="Output Tokens" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Two-column: Pie (by tier) + Horizontal bar (by provider) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Requests by Tier — Pie */}
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Requests by Tier</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={tierData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={{ fill: "var(--text)", fontSize: 12 }}>
                {tierData.map((_: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: "var(--surface)",
                  border: `1px solid var(--border)`,
                  borderRadius: 4,
                  color: "var(--text)",
                }}
              />
              <Legend wrapperStyle={{ color: "var(--text)" }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Requests by Provider — Horizontal bar */}
        <div style={cardStyle}>
          <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Requests by Provider (Top 10)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={providerData} layout="vertical" margin={{ left: 20, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis type="number" stroke="var(--text-secondary)" fontSize={12} />
              <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" fontSize={12} width={100} />
              <Tooltip
                contentStyle={{
                  background: "var(--surface)",
                  border: `1px solid var(--border)`,
                  borderRadius: 4,
                  color: "var(--text)",
                }}
              />
              <Bar dataKey="count" fill="#8884d8" name="Requests" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <a href={`/v1/admin/stats/export?days=${days}`} target="_blank">
          <button style={btnStyle}>Export CSV</button>
        </a>
      </div>
    </div>
  );
}

// ── App shell ──

function App() {
  const [logged, setLogged] = useState(!!getToken());
  const [tab, setTab] = useState("providers");
  const { theme, toggle } = useTheme();

  if (!logged) return <Login onLogin={() => setLogged(true)} />;

  const logout = () => {
    localStorage.removeItem("token");
    setLogged(false);
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: 20, background: "var(--bg)", color: "var(--text)", minHeight: "100vh" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ color: "var(--text)" }}>token-pool</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={toggle}
            style={{
              ...smBtnStyle,
              fontSize: 18,
              padding: "4px 10px",
              lineHeight: 1,
            }}
            title="Toggle dark mode"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button onClick={logout} style={btnStyle}>Logout</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, borderBottom: "2px solid var(--border)" }}>
        {["providers", "tiers", "stats"].map(key => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: "8px 16px",
              border: "none",
              background: tab === key ? "var(--accent)" : "transparent",
              color: tab === key ? "#fff" : "var(--text-secondary)",
              cursor: "pointer",
              borderRadius: "4px 4px 0 0",
            }}
          >
            {key.charAt(0).toUpperCase() + key.slice(1)}
          </button>
        ))}
      </div>
      {tab === "providers" && <Providers />}
      {tab === "tiers" && <Tiers />}
      {tab === "stats" && <Stats />}
    </div>
  );
}

// ── Styles ──

const labelStyle: React.CSSProperties = {
  fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "8px", margin: "8px 0",
  border: "1px solid var(--border)", borderRadius: 4, boxSizing: "border-box",
  background: "var(--surface)", color: "var(--text)",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px", border: "none", borderRadius: 4,
  background: "var(--accent)", color: "#fff", cursor: "pointer",
};

const smBtnStyle: React.CSSProperties = {
  padding: "4px 8px", margin: "0 4px 0 0", border: "1px solid var(--border)",
  borderRadius: 4, background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: 12,
};

const cardStyle: React.CSSProperties = {
  padding: 16, border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block", padding: "2px 6px", margin: "0 4px 2px 0",
  background: "var(--badge-bg)", color: "var(--text)", borderRadius: 4, fontSize: 12,
};

const filterBtn: React.CSSProperties = {
  padding: "6px 12px", border: "none", borderRadius: 4,
  cursor: "pointer", fontSize: 13, fontWeight: 600,
};

createRoot(document.getElementById("root")!).render(<App />);
