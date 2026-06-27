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
  --surface-2: #f9f9f9;
  --text: #1a1a1a;
  --text-secondary: #666;
  --border: #e0e0e0;
  --accent: #4285f4;
  --success: #2d5;
  --danger: #d33;
  --badge-bg: #f0f0f0;
  --shadow: 0 2px 8px rgba(0,0,0,0.08);
}
:root.dark {
  --bg: #1a1a2e;
  --surface: #16213e;
  --surface-2: #1e2a4a;
  --text: #eee;
  --text-secondary: #999;
  --border: #333;
  --accent: #4285f4;
  --success: #2d5;
  --danger: #e55;
  --badge-bg: #2a2a4a;
  --shadow: 0 2px 8px rgba(0,0,0,0.4);
}
body { background: var(--bg); color: var(--text); margin: 0; }
* { box-sizing: border-box; }
@media (max-width: 768px) {
  .tp-sidebar { width: 100% !important; height: auto !important; position: relative !important; flex-direction: row !important; overflow-x: auto; }
  .tp-nav-items { flex-direction: row !important; }
  .tp-main { padding: 12px !important; }
  .tp-stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .tp-params-grid { grid-template-columns: 1fr !important; }
  .tp-tier-grid { grid-template-columns: 1fr !important; }
}
@keyframes slideIn {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  const [healthResults, setHealthResults] = useState<Record<number, { healthy: boolean; latencyMs?: number; error?: string }>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [usageData, setUsageData] = useState<Record<number, any>>({});

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
    // Fetch usage for each provider
    const usage: Record<number, any> = {};
    await Promise.all(list.map(async (p: any) => {
      try {
        usage[p.id] = await api(`/admin/providers/${p.id}/usage`);
      } catch { usage[p.id] = null; }
    }));
    setUsageData(usage);
  }, []);

  useEffect(() => { load(); }, [load]);

  const testAll = async () => {
    setTestingAll(true);
    setHealthResults({});
    try {
      const results = await api("/admin/providers/test-all", { method: "POST" });
      const map: Record<number, { healthy: boolean; latencyMs?: number; error?: string }> = {};
      for (const r of results) {
        map[r.providerId] = { healthy: r.healthy, latencyMs: r.latencyMs, error: r.error };
      }
      setHealthResults(map);
    } catch (e: any) {
      console.error("Test all failed:", e);
    } finally {
      setTestingAll(false);
    }
  };

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
        <button onClick={testAll} disabled={testingAll} style={{ ...smBtnStyle, whiteSpace: "nowrap", opacity: testingAll ? 0.6 : 1 }}>
          {testingAll ? "Testing..." : "⚡ Test All"}
        </button>
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
                      {healthResults[p.id] && (
                        <span style={{
                          fontSize: 11, padding: "2px 8px", borderRadius: 4, fontWeight: 600,
                          background: healthResults[p.id].healthy ? "rgba(34,221,85,0.15)" : "rgba(255,50,50,0.15)",
                          color: healthResults[p.id].healthy ? "var(--success)" : "var(--danger)",
                        }} title={healthResults[p.id].error || `Healthy — ${healthResults[p.id].latencyMs}ms`}>
                          {healthResults[p.id].healthy ? `✓ ${healthResults[p.id].latencyMs}ms` : "✗ Failed"}
                        </span>
                      )}
                      {!healthResults[p.id] && p.rpmLimit && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{p.rpmLimit} RPM</span>}
                    </div>
                    {/* Rate limit usage bar */}
                    {usageData[p.id] && usageData[p.id].length > 0 && (() => {
                      const totalRpm = usageData[p.id].reduce((s: number, k: any) => s + (k.usage?.rpmUsed || 0), 0);
                      const totalRpmLimit = usageData[p.id].reduce((s: number, k: any) => s + (k.usage?.rpmLimit || 0), 0);
                      const totalRpd = usageData[p.id].reduce((s: number, k: any) => s + (k.usage?.rpdUsed || 0), 0);
                      const totalRpdLimit = usageData[p.id].reduce((s: number, k: any) => s + (k.usage?.rpdLimit || 0), 0);
                      const rpmPct = totalRpmLimit > 0 ? Math.min(100, (totalRpm / totalRpmLimit) * 100) : 0;
                      const rpdPct = totalRpdLimit > 0 ? Math.min(100, (totalRpd / totalRpdLimit) * 100) : 0;
                      if (totalRpmLimit === 0 && totalRpdLimit === 0) return null;
                      const barColor = (pct: number) => pct > 90 ? "var(--danger)" : pct > 70 ? "#fa0" : "var(--success)";
                      return (
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                          {totalRpmLimit > 0 && (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)", marginBottom: 1 }}>
                                <span>RPM</span><span>{totalRpm}/{totalRpmLimit}</span>
                              </div>
                              <div style={{ height: 3, borderRadius: 2, background: "var(--badge-bg)", overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${rpmPct}%`, background: barColor(rpmPct), borderRadius: 2 }} />
                              </div>
                            </div>
                          )}
                          {totalRpdLimit > 0 && (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)", marginBottom: 1 }}>
                                <span>RPD</span><span>{totalRpd}/{totalRpdLimit}</span>
                              </div>
                              <div style={{ height: 3, borderRadius: 2, background: "var(--badge-bg)", overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${rpdPct}%`, background: barColor(rpdPct), borderRadius: 2 }} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
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

  // Models list
  const [providerModels, setProviderModels] = useState<any[]>([]);

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

  // Load models for this provider
  const loadModels = useCallback(async () => {
    if (isCreate || !provider) return;
    try {
      const m = await api(`/admin/models?providerId=${provider.id}`);
      setProviderModels(Array.isArray(m) ? m : []);
    } catch { setProviderModels([]); }
  }, [isCreate, provider]);

  useEffect(() => {
    loadKeys();
    loadModels();
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
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button
              onClick={async () => {
                try {
                  const result = await api(`/admin/providers/${provider.id}/test`, { method: "POST" });
                  alert(`✓ Healthy — ${result.latencyMs}ms (model: ${result.model})`);
                } catch (e: any) {
                  alert(`✗ Failed: ${e.message}`);
                }
              }}
              style={{ ...smBtnStyle, whiteSpace: "nowrap" }}
              disabled={!enabled}
            >
              ⚡ Test
            </button>
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
          </div>
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

      {/* Available models */}
      {!isCreate && (
        <div style={sectionCard}>
          <h3 style={sectionTitle}>Available Models ({providerModels.length})</h3>
          {providerModels.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              No models synced. Click "Sync Models" to fetch from provider.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
              {providerModels.map(m => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 4, background: "var(--badge-bg)" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)", flex: 1 }}>{m.modelId}</span>
                  {m.contextWindow > 0 && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{(m.contextWindow / 1000).toFixed(0)}k ctx</span>}
                  {m.supportsVision && <span style={{ ...badgeStyle, fontSize: 10 }}>vision</span>}
                  {m.supportsTools && <span style={{ ...badgeStyle, fontSize: 10 }}>tools</span>}
                  {m.inputCostPerMtok != null && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>${m.inputCostPerMtok}/M</span>}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              onClick={async () => {
                try {
                  await api("/admin/models/sync", { method: "POST" });
                  await loadModels();
                } catch (e: any) {
                  setError(e.message);
                }
              }}
              style={smBtnStyle}
            >
              ↻ Sync Models
            </button>
          </div>
        </div>
      )}

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
  const [allModels, setAllModels] = useState<any[]>([]);
  const [allProviders, setAllProviders] = useState<any[]>([]);
  const [addingToTier, setAddingToTier] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");
  const [newProviderId, setNewProviderId] = useState("");

  const load = useCallback(async () => {
    const t = await api("/admin/tiers");
    setTiers(t);
    const m: Record<string, any[]> = {};
    for (const tier of t) {
      m[tier.name] = await api(`/admin/tiers/${tier.name}/models`);
    }
    setModels(m);
    setAllModels(await api("/admin/models"));
    setAllProviders(await api("/admin/providers"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveTierModels = async (tierName: string, updatedModels: any[]) => {
    try {
      await api(`/admin/tiers/${tierName}/models`, {
        method: "PUT",
        body: JSON.stringify(updatedModels.map((m, i) => ({
          modelId: m.model_id || m.modelId,
          providerId: m.provider_id || m.providerId,
          priority: i + 1,
        }))),
      });
      await load();
    } catch (e: any) {
      alert(`Failed to save: ${e.message}`);
    }
  };

  const removeModel = async (tierName: string, idx: number) => {
    const updated = models[tierName].filter((_: any, i: number) => i !== idx);
    await saveTierModels(tierName, updated);
  };

  const moveModel = async (tierName: string, idx: number, dir: "up" | "down") => {
    const arr = [...models[tierName]];
    const newIdx = dir === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    await saveTierModels(tierName, arr);
  };

  const addModel = async (tierName: string) => {
    if (!newModelId || !newProviderId) return;
    const updated = [...(models[tierName] || []), { model_id: newModelId, provider_id: parseInt(newProviderId) }];
    await saveTierModels(tierName, updated);
    setNewModelId(""); setNewProviderId(""); setAddingToTier(null);
  };

  return (
    <div>
      <h2 style={{ color: "var(--text)" }}>Routing Tiers</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))", gap: 16 }}>
        {tiers.map(t => (
          <div key={t.id} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <strong style={{ color: "var(--text)" }}>{t.name}</strong>
              <span style={{ ...badgeStyle, background: "var(--badge-bg)" }}>{models[t.name]?.length || 0} models</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>{t.description}</div>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {models[t.name]?.length > 0 ? (
                models[t.name].map((m: any, i: number) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 4, background: "var(--badge-bg)" }}>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12, minWidth: 20 }}>{i + 1}.</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)", flex: 1 }}>{m.model_id || m.modelId}</span>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {allProviders.find(p => p.id === (m.provider_id || m.providerId))?.name || `#${m.provider_id || m.providerId}`}
                    </span>
                    <button onClick={() => moveModel(t.name, i, "up")} disabled={i === 0} style={{ ...hoverBtn, opacity: i === 0 ? 0.3 : 1 }}>▲</button>
                    <button onClick={() => moveModel(t.name, i, "down")} disabled={i === models[t.name].length - 1} style={{ ...hoverBtn, opacity: i === models[t.name].length - 1 ? 0.3 : 1 }}>▼</button>
                    <button onClick={() => removeModel(t.name, i)} style={{ ...hoverBtn, color: "var(--danger)" }}>×</button>
                  </div>
                ))
              ) : (
                <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>No models configured</div>
              )}
            </div>
            {/* Fallback chain flow visualization */}
            {models[t.name]?.length > 1 && (
              <div style={{ marginTop: 8, padding: "8px 4px", fontSize: 11, color: "var(--text-secondary)", overflowX: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}>
                  <span style={{ padding: "2px 6px", borderRadius: 3, background: "var(--accent)", color: "#fff", fontSize: 10, fontWeight: 600 }}>Request</span>
                  {models[t.name].map((m: any, i: number) => (
                    <span key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <span style={{ color: "var(--text-secondary)" }}>→</span>
                      <span style={{ padding: "2px 6px", borderRadius: 3, background: "var(--badge-bg)", color: "var(--text)", fontSize: 10 }}>
                        {(m.model_id || m.modelId).slice(0, 20)}
                      </span>
                      {i < models[t.name].length - 1 && (
                        <span style={{ fontSize: 9, color: "var(--text-secondary)" }}>fallback</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {addingToTier === t.name ? (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                <select value={newModelId} onChange={e => setNewModelId(e.target.value)} style={{ ...inputStyle, margin: 0, fontSize: 12, cursor: "pointer" }}>
                  <option value="">Select model...</option>
                  {allModels.map((m: any, i: number) => <option key={i} value={m.modelId}>{m.modelId}</option>)}
                </select>
                <select value={newProviderId} onChange={e => setNewProviderId(e.target.value)} style={{ ...inputStyle, margin: 0, fontSize: 12, cursor: "pointer" }}>
                  <option value="">Select provider...</option>
                  {allProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => addModel(t.name)} disabled={!newModelId || !newProviderId} style={{ ...btnStyle, fontSize: 12, padding: "4px 12px" }}>Add</button>
                  <button onClick={() => setAddingToTier(null)} style={smBtnStyle}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingToTier(t.name)} style={{ ...smBtnStyle, marginTop: 8 }}>+ Add Model</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const hoverBtn: React.CSSProperties = {
  border: "none", background: "transparent", cursor: "pointer", fontSize: 12,
  padding: "2px 6px", borderRadius: 4, color: "var(--text-secondary)",
};

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

function DimensionTable({ stats }: { stats: any }) {
  const [dimension, setDimension] = useState<"model" | "provider" | "tier">("model");

  let rows: { name: string; count: number; inputTokens: number; outputTokens: number; avgLatency?: number }[] = [];
  if (dimension === "model") {
    rows = (stats.byModel || []).map((r: any) => ({ name: r.modelId, count: r.count, inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0, avgLatency: r.avgLatencyMs }));
  } else if (dimension === "provider") {
    rows = (stats.byProvider || []).map((r: any) => ({ name: `Provider #${r.providerId}`, count: r.count, inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0 }));
  } else {
    rows = (stats.byTier || []).map((r: any) => ({ name: r.tier, count: r.count, inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0 }));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["model", "provider", "tier"] as const).map(d => (
          <button key={d} onClick={() => setDimension(d)} style={{ ...filterBtn, background: dimension === d ? "var(--accent)" : "var(--badge-bg)", color: dimension === d ? "#fff" : "var(--text-secondary)" }}>
            {d.charAt(0).toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--border)", textAlign: "left" }}>
              <th style={{ padding: "6px 12px", color: "var(--text-secondary)" }}>{dimension.charAt(0).toUpperCase() + dimension.slice(1)}</th>
              <th style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right" }}>Requests</th>
              <th style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right" }}>Tokens</th>
              {dimension === "model" && <th style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right" }}>Avg Latency</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 12px", color: "var(--text)", fontFamily: "monospace", fontSize: 12 }}>{r.name}</td>
                <td style={{ padding: "6px 12px", color: "var(--text)", textAlign: "right" }}>{r.count}</td>
                <td style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right" }}>{((r.inputTokens || 0) + (r.outputTokens || 0)).toLocaleString()}</td>
                {dimension === "model" && <td style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right" }}>{r.avgLatency ? `${Math.round(r.avgLatency)}ms` : "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <div className="tp-stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
        <StatCard title="Total Requests" value={totalRequests.toLocaleString()} color="#4285f4" />
        <StatCard title="Total Tokens" value={totalTokens.toLocaleString()} sub={`${(total.inputTokens ?? 0).toLocaleString()} in / ${(total.outputTokens ?? 0).toLocaleString()} out`} color="#2d5" />
        <StatCard title="Avg Latency" value={avgLatency > 0 ? `${Math.round(avgLatency)}ms` : "—"} color="#fa0" />
        <StatCard title="Total Cost" value={`$${totalCost.toFixed(2)}`} color="#a8328a" />
        <StatCard title="Success Rate" value={totalRequests > 0 ? `${(((totalRequests - (total.errorCount ?? 0)) / totalRequests) * 100).toFixed(1)}%` : "—"} sub={`${total.errorCount ?? 0} errors`} color={totalRequests > 0 && (total.errorCount ?? 0) / totalRequests > 0.1 ? "var(--danger)" : "#2d5"} />
      </div>

      {/* Group-by summary table */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Summary by Dimension</h3>
        <DimensionTable stats={stats} />
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

// ── Playground ──

interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

interface PlaygroundMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: boolean;
  // For compare mode: multiple model responses for a single user turn
  responses?: { model: string; content: string; latencyMs?: number; error?: boolean }[];
}

function Playground() {
  const [models, setModels] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [topP, setTopP] = useState(1);
  const [stream, setStream] = useState(true);
  const [showParams, setShowParams] = useState(false);

  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api("/models").then((data: any) => {
      const list = data?.data || [];
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        const real = list.find((m: any) => !m.id.startsWith("profile:") && m.owned_by !== "tier");
        setSelectedModel(real?.id || list[0].id);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Core send-to-model function (reused by normal send, compare, regenerate) ──
  const sendToModel = async (
    model: string,
    chatMessages: ChatMsg[],
    onChunk: (chunk: string) => void,
    onDone: (latencyMs: number, tokensIn?: number, tokensOut?: number, resolvedModel?: string) => void,
    onError: (err: string) => void,
  ) => {
    const startTime = Date.now();
    const token = getToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const resp = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: chatMessages,
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
          stream,
        }),
      });

      const resolvedModel = resp.headers.get("x-resolved-model") || model;

      if (!resp.ok) {
        const errText = await resp.text();
        let errMsg = errText;
        try { errMsg = JSON.parse(errText)?.error?.message || errText; } catch {}
        onError(errMsg);
        return;
      }

      if (stream) {
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                outputTokens += Math.ceil(delta.content.length / 4);
                onChunk(delta.content);
              }
            } catch {}
          }
        }
        onDone(Date.now() - startTime, undefined, outputTokens, resolvedModel);
      } else {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || "";
        onChunk(content);
        onDone(Date.now() - startTime, data.usage?.prompt_tokens, data.usage?.completion_tokens, resolvedModel);
      }
    } catch (e: any) {
      onError(`Network error: ${e.message || e}`);
    }
  };

  const buildChatHistory = (upToIdx?: number): ChatMsg[] => {
    const msgs: ChatMsg[] = [];
    if (systemPrompt.trim()) {
      msgs.push({ role: "system", content: systemPrompt.trim() });
    }
    const history = upToIdx != null ? messages.slice(0, upToIdx) : messages;
    for (const m of history) {
      if (m.content && !m.error) {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    return msgs;
  };

  // ── Normal send (single model) ──
  const send = async () => {
    if (!input.trim() || sending || !selectedModel) return;
    const userMsg = input.trim();
    setInput("");
    setSending(true);

    const userEntry: PlaygroundMessage = { role: "user", content: userMsg };
    const assistantEntry: PlaygroundMessage = { role: "assistant", content: "", model: selectedModel };
    setMessages(prev => [...prev, userEntry, assistantEntry]);

    const chatMessages = buildChatHistory();
    chatMessages.push({ role: "user", content: userMsg });

    await sendToModel(
      selectedModel,
      chatMessages,
      // onChunk
      (chunk) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk };
          return copy;
        });
      },
      // onDone
      (latency, tokensIn, tokensOut, resolvedModel) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], latencyMs: latency, tokensIn, tokensOut, model: resolvedModel || model };
          return copy;
        });
      },
      // onError
      (err) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: `Error: ${err}`, error: true };
          return copy;
        });
      },
    );
    setSending(false);
  };

  // ── Compare send (multiple models side-by-side) ──
  const sendCompare = async () => {
    if (!input.trim() || sending || compareModels.length < 2) return;
    const userMsg = input.trim();
    setInput("");
    setSending(true);

    const responses = compareModels.map(m => ({ model: m, content: "", latencyMs: undefined as number | undefined, error: false }));
    const userEntry: PlaygroundMessage = { role: "user", content: userMsg, responses };
    setMessages(prev => [...prev, userEntry]);

    const chatMessages = buildChatHistory();
    chatMessages.push({ role: "user", content: userMsg });

    // Fire all requests in parallel
    await Promise.allSettled(compareModels.map(async (model, idx) => {
      await sendToModel(
        model,
        chatMessages,
        // onChunk — update specific response slot
        (chunk) => {
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last.responses) {
              const newResp = [...last.responses];
              newResp[idx] = { ...newResp[idx], content: newResp[idx].content + chunk };
              copy[copy.length - 1] = { ...last, responses: newResp };
            }
            return copy;
          });
        },
        // onDone
        (latency) => {
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last.responses) {
              const newResp = [...last.responses];
              newResp[idx] = { ...newResp[idx], latencyMs: latency };
              copy[copy.length - 1] = { ...last, responses: newResp };
            }
            return copy;
          });
        },
        // onError
        (err) => {
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last.responses) {
              const newResp = [...last.responses];
              newResp[idx] = { ...newResp[idx], content: `Error: ${err}`, error: true };
              copy[copy.length - 1] = { ...last, responses: newResp };
            }
            return copy;
          });
        },
      );
    }));
    setSending(false);
  };

  // ── Regenerate last assistant message ──
  const regenerate = async (idx: number) => {
    if (sending) return;
    setSending(true);
    // Find the user message before this assistant message
    const userMsg = messages[idx - 1];
    if (!userMsg || userMsg.role !== "user") { setSending(false); return; }

    // Build history up to (but not including) the user message
    const chatMessages = buildChatHistory(idx - 1);
    chatMessages.push({ role: "user", content: userMsg.content });

    const model = messages[idx].model || selectedModel;

    // Clear the assistant message
    setMessages(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], content: "", error: false };
      return copy;
    });

    await sendToModel(
      model,
      chatMessages,
      (chunk) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], content: copy[idx].content + chunk };
          return copy;
        });
      },
      (latency, tokensIn, tokensOut, resolvedModel) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], latencyMs: latency, tokensIn, tokensOut, model: resolvedModel || model };
          return copy;
        });
      },
      (err) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], content: `Error: ${err}`, error: true };
          return copy;
        });
      },
    );
    setSending(false);
  };

  // ── Edit a user message and re-send ──
  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditText(messages[idx].content);
  };

  const saveEdit = async () => {
    if (editingIdx == null || !editText.trim()) { setEditingIdx(null); return; }
    const idx = editingIdx;
    setEditingIdx(null);

    // Update the user message, truncate everything after it
    const updated = [...messages.slice(0, idx), { role: "user" as const, content: editText.trim() }];
    // Add new assistant placeholder
    const model = selectedModel;
    updated.push({ role: "assistant", content: "", model });
    setMessages(updated);

    const chatMessages = buildChatHistory(idx);
    chatMessages.push({ role: "user", content: editText.trim() });

    setSending(true);
    await sendToModel(
      model,
      chatMessages,
      (chunk) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk };
          return copy;
        });
      },
      (latency, tokensIn, tokensOut, resolvedModel) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], latencyMs: latency, tokensIn, tokensOut, model: resolvedModel || model };
          return copy;
        });
      },
      (err) => {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: `Error: ${err}`, error: true };
          return copy;
        });
      },
    );
    setSending(false);
  };

  const copyMessage = (content: string) => {
    navigator.clipboard.writeText(content);
  };

  // ── Prompt templates (localStorage) ──
  const [templates, setTemplates] = useState<{ name: string; systemPrompt: string; temperature?: number; maxTokens?: number; topP?: number }[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("playground-templates") || "[]");
      setTemplates(Array.isArray(stored) ? stored : []);
    } catch {}
  }, []);

  const saveTemplate = () => {
    if (!newTemplateName.trim()) return;
    const tmpl = { name: newTemplateName.trim(), systemPrompt, temperature, maxTokens, topP };
    const updated = [...templates, tmpl];
    setTemplates(updated);
    localStorage.setItem("playground-templates", JSON.stringify(updated));
    setNewTemplateName("");
  };

  const loadTemplate = (t: typeof templates[0]) => {
    setSystemPrompt(t.systemPrompt);
    if (t.temperature != null) setTemperature(t.temperature);
    if (t.maxTokens != null) setMaxTokens(t.maxTokens);
    if (t.topP != null) setTopP(t.topP);
    setShowTemplates(false);
  };

  const deleteTemplate = (idx: number) => {
    const updated = templates.filter((_, i) => i !== idx);
    setTemplates(updated);
    localStorage.setItem("playground-templates", JSON.stringify(updated));
  };

  const clearChat = () => {
    setMessages([]);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      compareMode ? sendCompare() : send();
    }
  };

  const toggleCompareModel = (modelId: string) => {
    setCompareModels(prev => {
      if (prev.includes(modelId)) return prev.filter(m => m !== modelId);
      if (prev.length >= 3) return prev; // max 3
      return [...prev, modelId];
    });
  };

  const paramStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
  };

  const valueLabelStyle: React.CSSProperties = {
    fontSize: 12, color: "var(--text-secondary)", minWidth: 36, textAlign: "right" as const,
  };

  const rangeStyle: React.CSSProperties = {
    flex: 1, cursor: "pointer", accentColor: "var(--accent)" as any,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 140px)", minHeight: 400 }}>
      {/* Top bar: model selector + compare toggle + params toggle + clear */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexShrink: 0, flexWrap: "wrap" }}>
        {!compareMode ? (
          <select
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            style={{ ...inputStyle, flex: 1, margin: 0, minWidth: 200, cursor: "pointer" }}
          >
            {models.map((m: any) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
        ) : (
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
              Compare ({compareModels.length}/3) — select models:
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxHeight: 80, overflowY: "auto" }}>
              {models.map((m: any) => (
                <button
                  key={m.id}
                  onClick={() => toggleCompareModel(m.id)}
                  style={{
                    ...filterBtn,
                    fontSize: 11, padding: "2px 8px",
                    background: compareModels.includes(m.id) ? "var(--accent)" : "var(--badge-bg)",
                    color: compareModels.includes(m.id) ? "#fff" : "var(--text-secondary)",
                  }}
                  title={m.id}
                >
                  {m.id.length > 25 ? m.id.slice(0, 25) + "…" : m.id}
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          onClick={() => { setCompareMode(!compareMode); setCompareModels([]); }}
          style={{
            ...smBtnStyle, whiteSpace: "nowrap",
            background: compareMode ? "var(--accent)" : "var(--badge-bg)",
            color: compareMode ? "#fff" : "var(--text-secondary)",
            fontWeight: 600,
          }}
        >
          {compareMode ? "✓ Compare" : "⇄ Compare"}
        </button>
        <button onClick={() => setShowParams(!showParams)} style={{ ...smBtnStyle, whiteSpace: "nowrap" }}>
          {showParams ? "▲ Params" : "▼ Params"}
        </button>
        <button onClick={clearChat} style={{ ...smBtnStyle, whiteSpace: "nowrap", color: messages.length ? "var(--danger)" : "var(--text-secondary)" }}>
          Clear
        </button>
      </div>

      {/* Params panel (collapsible) */}
      {showParams && (
        <div style={{ ...cardStyle, marginBottom: 12, flexShrink: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <label style={{ ...labelStyle, margin: 0 }}>System Prompt</label>
              <button onClick={() => setShowTemplates(!showTemplates)} style={{ ...smBtnStyle, fontSize: 11 }}>
                {showTemplates ? "Hide Templates" : "📋 Templates"}
              </button>
            </div>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              style={{ ...inputStyle, minHeight: 60, resize: "vertical", margin: 0 }}
              placeholder="System instructions..."
            />
            {showTemplates && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: "var(--surface-2)", border: "1px solid var(--border)" }}>
                {templates.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {templates.map((t, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                        <button onClick={() => loadTemplate(t)} style={{ ...smBtnStyle, flex: 1, textAlign: "left" }}>{t.name}</button>
                        <button onClick={() => deleteTemplate(i)} style={{ ...smBtnStyle, color: "var(--danger)" }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 4 }}>
                  <input placeholder="Template name..." value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)} style={{ ...inputStyle, margin: 0, flex: 1, fontSize: 12 }} />
                  <button onClick={saveTemplate} style={{ ...btnStyle, fontSize: 12, padding: "4px 12px" }}>Save Current</button>
                </div>
              </div>
            )}
          </div>
          <div>
            <div style={paramStyle}>
              <label style={{ ...labelStyle, margin: 0, minWidth: 100 }}>Temperature</label>
              <input type="range" min="0" max="2" step="0.1" value={temperature} onChange={e => setTemperature(Number(e.target.value))} style={rangeStyle} />
              <span style={valueLabelStyle}>{temperature.toFixed(1)}</span>
            </div>
            <div style={paramStyle}>
              <label style={{ ...labelStyle, margin: 0, minWidth: 100 }}>Max Tokens</label>
              <input type="number" min="1" max="128000" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} style={{ ...inputStyle, margin: 0, flex: 1 }} />
            </div>
            <div style={paramStyle}>
              <label style={{ ...labelStyle, margin: 0, minWidth: 100 }}>Top P</label>
              <input type="range" min="0" max="1" step="0.05" value={topP} onChange={e => setTopP(Number(e.target.value))} style={rangeStyle} />
              <span style={valueLabelStyle}>{topP.toFixed(2)}</span>
            </div>
            <div style={{ ...paramStyle, marginTop: 4 }}>
              <label style={{ ...labelStyle, margin: 0, minWidth: 100, cursor: "pointer" }}>
                <input type="checkbox" checked={stream} onChange={e => setStream(e.target.checked)} style={{ marginRight: 6, accentColor: "var(--accent)" as any }} />
                Stream
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 4, marginBottom: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--text-secondary)", padding: "40px 20px" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
            <div>Send a message to test the API</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {compareMode ? `Comparing ${compareModels.length} models` : `Model: ${selectedModel || "—"}`}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <PlaygroundBubble
            key={i}
            msg={m}
            index={i}
            sending={sending}
            onRegenerate={() => regenerate(i)}
            onEdit={() => startEdit(i)}
            onSaveEdit={saveEdit}
            onCancelEdit={() => setEditingIdx(null)}
            editing={editingIdx === i}
            editText={editText}
            onEditText={setEditText}
            onCopy={() => copyMessage(m.content)}
          />
        ))}
        {sending && messages.length > 0 && !messages[messages.length - 1].content && !messages[messages.length - 1].responses && (
          <div style={{ color: "var(--text-secondary)", fontSize: 13, padding: "4px 12px" }}>
            <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span> Waiting for response...
          </div>
        )}
      </div>

      {/* Input area */}
      <div style={{ ...cardStyle, flexShrink: 0, display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={compareMode ? "Type a message to send to all selected models... (Ctrl+Enter)" : "Type a message... (Ctrl+Enter to send)"}
          style={{ ...inputStyle, flex: 1, margin: 0, minHeight: 48, maxHeight: 200, resize: "vertical" }}
          disabled={sending}
        />
        <button
          onClick={compareMode ? sendCompare : send}
          disabled={sending || !input.trim() || (compareMode && compareModels.length < 2)}
          style={{ ...btnStyle, opacity: sending || !input.trim() || (compareMode && compareModels.length < 2) ? 0.5 : 1, whiteSpace: "nowrap", alignSelf: "stretch" }}
        >
          {sending ? "Sending..." : compareMode ? "Send to All" : "Send"}
        </button>
      </div>
    </div>
  );
}

function PlaygroundBubble({ msg, index, sending, onRegenerate, onEdit, onSaveEdit, onCancelEdit, editing, editText, onEditText, onCopy }: {
  msg: PlaygroundMessage;
  index: number;
  sending: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  editing: boolean;
  editText: string;
  onEditText: (text: string) => void;
  onCopy: () => void;
}) {
  const isUser = msg.role === "user";

  const containerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: isUser ? "flex-end" : "flex-start",
    animation: "slideIn 0.15s ease-out",
  };

  const bubbleStyle: React.CSSProperties = {
    maxWidth: "80%",
    padding: "10px 14px",
    borderRadius: 12,
    background: isUser ? "var(--accent)" : "var(--badge-bg)",
    color: isUser ? "#fff" : "var(--text)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 14,
    lineHeight: 1.5,
  };

  const errorStyle: React.CSSProperties = {
    ...bubbleStyle,
    background: "rgba(255,50,50,0.15)",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
  };

  const hoverBtnStyle: React.CSSProperties = {
    border: "none", background: "transparent", cursor: "pointer",
    fontSize: 11, color: "var(--text-secondary)", padding: "2px 6px", borderRadius: 4,
  };

  // ── Compare mode: multiple responses ──
  if (msg.responses) {
    return (
      <div style={{ ...containerStyle, flexDirection: "column", alignItems: "stretch" }}>
        {/* User message */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ ...bubbleStyle, maxWidth: "80%" }}>{msg.content}</div>
        </div>
        {/* Side-by-side responses */}
        <div style={{ display: "flex", gap: 8, marginTop: 8, overflowX: "auto" }}>
          {msg.responses.map((r, i) => (
            <div key={i} style={{
              flex: 1, minWidth: 250, maxWidth: 500,
              padding: 10, borderRadius: 8,
              background: r.error ? "rgba(255,50,50,0.1)" : "var(--badge-bg)",
              border: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", marginBottom: 6, wordBreak: "break-all" }}>
                {r.model}
                {r.latencyMs != null && <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}> · {r.latencyMs}ms</span>}
              </div>
              <div style={{ fontSize: 13, color: r.error ? "var(--danger)" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {r.content || (r.error ? "" : "…")}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 4, maxWidth: "80%" }}>
        {/* Edit mode for user messages */}
        {editing && isUser ? (
          <div style={{ maxWidth: "80%", display: "flex", flexDirection: "column", gap: 4 }}>
            <textarea
              value={editText}
              onChange={e => onEditText(e.target.value)}
              style={{ ...inputStyle, margin: 0, minHeight: 60, background: "var(--surface)" }}
              autoFocus
            />
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <button onClick={onCancelEdit} style={smBtnStyle}>Cancel</button>
              <button onClick={onSaveEdit} style={btnStyle}>Save & Resend</button>
            </div>
          </div>
        ) : (
          <>
            <div style={msg.error ? errorStyle : bubbleStyle}>
              {msg.content || (msg.error ? "" : "…")}
            </div>
            {/* Hover toolbar */}
            <div style={{ display: "flex", gap: 2, opacity: 0.7 }}>
              <button onClick={onCopy} style={hoverBtnStyle} title="Copy">⧉</button>
              {isUser && (
                <button onClick={onEdit} style={hoverBtnStyle} title="Edit">✎</button>
              )}
              {!isUser && !msg.error && msg.content && (
                <button onClick={onRegenerate} disabled={sending} style={{ ...hoverBtnStyle, opacity: sending ? 0.4 : 0.7 }} title="Regenerate">↻</button>
              )}
            </div>
            {!isUser && !msg.error && (
              <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-secondary)", padding: "0 4px", flexWrap: "wrap" }}>
                {msg.model && msg.model !== "auto" && <span>model: {msg.model}</span>}
                {msg.latencyMs != null && <span>{msg.latencyMs}ms</span>}
                {msg.tokensIn != null && <span>in: {msg.tokensIn}</span>}
                {msg.tokensOut != null && <span>out: {msg.tokensOut}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Logs ──

function Logs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [providerFilter, setProviderFilter] = useState("");
  const [providers, setProviders] = useState<any[]>([]);
  const pageSize = 50;

  useEffect(() => {
    api("/admin/providers").then(setProviders).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
      if (providerFilter) params.set("providerId", providerFilter);
      const data = await api(`/admin/logs?${params}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch { /* ignore */ }
  }, [page, providerFilter]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "var(--text)" }}>Request Logs ({total})</h2>
        <select
          value={providerFilter}
          onChange={e => { setProviderFilter(e.target.value); setPage(0); }}
          style={{ ...inputStyle, margin: 0, maxWidth: 200, cursor: "pointer" }}
        >
          <option value="">All Providers</option>
          {providers.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button onClick={load} style={smBtnStyle}>↻ Refresh</button>
      </div>

      {logs.length === 0 ? (
        <div style={{ textAlign: "center", color: "var(--text-secondary)", padding: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          No requests logged yet
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border)", textAlign: "left" }}>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>Time</th>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>Model</th>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>Provider</th>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>Tier</th>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)", textAlign: "right" }}>Tokens (in/out)</th>
                  <th style={{ padding: "8px 12px", color: "var(--text-secondary)", textAlign: "right" }}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => {
                  const provName = providers.find(p => p.id === log.providerId)?.name || `#${log.providerId}`;
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td style={{ padding: "6px 12px", color: "var(--text)", fontFamily: "monospace", fontSize: 12 }}>
                        {log.modelId}
                      </td>
                      <td style={{ padding: "6px 12px", color: "var(--text)" }}>{provName}</td>
                      <td style={{ padding: "6px 12px" }}>
                        <span style={{ ...badgeStyle, background: "var(--badge-bg)" }}>{log.tier}</span>
                      </td>
                      <td style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right", whiteSpace: "nowrap" }}>
                        {log.inputTokens} / {log.outputTokens}
                      </td>
                      <td style={{ padding: "6px 12px", color: "var(--text-secondary)", textAlign: "right", whiteSpace: "nowrap" }}>
                        {log.latencyMs}ms
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Page {page + 1} of {totalPages || 1} — Showing {logs.length} of {total}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ ...smBtnStyle, opacity: page === 0 ? 0.4 : 1 }}>
                ← Prev
              </button>
              <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={{ ...smBtnStyle, opacity: page >= totalPages - 1 ? 0.4 : 1 }}>
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Users ──

function Users() {
  const [users, setUsers] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "regular">("regular");
  const [error, setError] = useState("");
  const [pwModal, setPwModal] = useState<{ id: number; username: string } | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwError, setPwError] = useState("");

  const load = useCallback(async () => {
    try {
      setUsers(await api("/admin/users"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createUser = async () => {
    setError("");
    if (!newUsername.trim() || !newPassword) { setError("Username and password required"); return; }
    if (newPassword.length < 6) { setError("Password must be at least 6 characters"); return; }
    try {
      await api("/admin/users", {
        method: "POST",
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      setNewUsername(""); setNewPassword(""); setNewRole("regular"); setShowCreate(false);
      await load();
    } catch (e: any) {
      setError(e.message || "Failed to create user");
    }
  };

  const changeRole = async (id: number, role: "admin" | "regular") => {
    try {
      await api(`/admin/users/${id}/role`, { method: "PUT", body: JSON.stringify({ role }) });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const deleteUser = async (id: number, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      await api(`/admin/users/${id}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const submitPassword = async () => {
    if (!pwModal) return;
    setPwError("");
    if (pwValue.length < 6) { setPwError("Password must be at least 6 characters"); return; }
    try {
      await api(`/admin/users/${pwModal.id}/password`, { method: "PUT", body: JSON.stringify({ password: pwValue }) });
      setPwModal(null); setPwValue(""); setPwError("");
    } catch (e: any) {
      setPwError(e.message);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "var(--text)" }}>Users ({users.length})</h2>
        <button onClick={() => setShowCreate(!showCreate)} style={btnStyle}>+ Add User</button>
      </div>

      {error && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Create form */}
      {showCreate && (
        <div style={{ ...cardStyle, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 8, alignItems: "end" }}>
          <div>
            <label style={labelStyle}>Username</label>
            <input value={newUsername} onChange={e => setNewUsername(e.target.value)} style={{ ...inputStyle, margin: 0 }} placeholder="username" />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={{ ...inputStyle, margin: 0 }} placeholder="••••••" />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select value={newRole} onChange={e => setNewRole(e.target.value as any)} style={{ ...inputStyle, margin: 0, cursor: "pointer" }}>
              <option value="regular">Regular</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={createUser} style={btnStyle}>Create</button>
            <button onClick={() => { setShowCreate(false); setError(""); }} style={smBtnStyle}>Cancel</button>
          </div>
        </div>
      )}

      {/* User list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {users.map(u => (
          <div key={u.id} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: u.role === "admin" ? "var(--accent)" : "var(--badge-bg)",
              color: u.role === "admin" ? "#fff" : "var(--text-secondary)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 700, fontSize: 14, flexShrink: 0,
            }}>
              {u.username.charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: "var(--text)" }}>
                {u.username}
                {u.role === "admin" && (
                  <span style={{ ...badgeStyle, marginLeft: 8, background: "rgba(66,133,244,0.15)", color: "var(--accent)" }}>admin</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                ID: {u.id} · Created: {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <select
                value={u.role}
                onChange={e => changeRole(u.id, e.target.value as any)}
                style={{ ...smBtnStyle, cursor: "pointer", padding: "4px 8px" }}
              >
                <option value="regular">Regular</option>
                <option value="admin">Admin</option>
              </select>
              <button onClick={() => { setPwModal({ id: u.id, username: u.username }); setPwValue(""); setPwError(""); }} style={smBtnStyle}>
                Set Password
              </button>
              <button
                onClick={() => deleteUser(u.id, u.username)}
                style={{ ...smBtnStyle, color: "var(--danger)" }}
                disabled={u.username === "admin"}
                title={u.username === "admin" ? "Cannot delete primary admin" : "Delete user"}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Password modal */}
      {pwModal && (
        <div
          onClick={() => setPwModal(null)}
          style={{
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ ...cardStyle, width: 360, padding: 24 }}
          >
            <h3 style={{ margin: "0 0 8px", color: "var(--text)" }}>Set Password</h3>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
              Set new password for <strong>{pwModal.username}</strong>
            </div>
            <input
              type="password"
              value={pwValue}
              onChange={e => setPwValue(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submitPassword()}
              placeholder="New password"
              style={{ ...inputStyle, margin: "0 0 8px" }}
              autoFocus
            />
            {pwError && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 8 }}>{pwError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setPwModal(null)} style={smBtnStyle}>Cancel</button>
              <button onClick={submitPassword} style={btnStyle}>Update</button>
            </div>
          </div>
        </div>
      )}
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

  const navItems = [
    { key: "providers", icon: "🔌", label: "Providers" },
    { key: "playground", icon: "💬", label: "Playground" },
    { key: "tiers", icon: "📊", label: "Tiers" },
    { key: "stats", icon: "📈", label: "Stats" },
    { key: "logs", icon: "📋", label: "Logs" },
    { key: "users", icon: "👤", label: "Users" },
  ];

  const navBtnStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 16px", border: "none", borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text-secondary)",
    cursor: "pointer", fontSize: 14, fontWeight: active ? 600 : 400,
    textAlign: "left" as const, width: "100%",
  });

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", display: "flex", minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      {/* Sidebar */}
      <div className="tp-sidebar" style={{
        width: 200, flexShrink: 0, borderRight: "1px solid var(--border)",
        background: "var(--surface)", padding: 16, display: "flex", flexDirection: "column",
        position: "sticky", top: 0, height: "100vh",
      }}>
        <div style={{ marginBottom: 24, paddingLeft: 4 }}>
          <h1 style={{ color: "var(--text)", fontSize: 20, margin: 0 }}>token-pool</h1>
        </div>
        <div className="tp-nav-items" style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {navItems.map(item => (
            <button key={item.key} onClick={() => setTab(item.key)} style={navBtnStyle(tab === item.key)}>
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <button
            onClick={toggle}
            style={{ ...smBtnStyle, fontSize: 18, padding: "6px 12px", lineHeight: 1, textAlign: "center" }}
            title="Toggle dark mode"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button onClick={logout} style={{ ...btnStyle, fontSize: 13 }}>Logout</button>
        </div>
      </div>

      {/* Main content */}
      <div className="tp-main" style={{ flex: 1, padding: 20, overflow: "auto", minWidth: 0 }}>
        {tab === "providers" && <Providers />}
        {tab === "playground" && <Playground />}
        {tab === "tiers" && <Tiers />}
        {tab === "stats" && <Stats />}
        {tab === "logs" && <Logs />}
        {tab === "users" && <Users />}
      </div>
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
  boxShadow: "var(--shadow)",
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
