import React, { useState, useEffect, useCallback } from "react";
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

function Providers() {
  const [providers, setProviders] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setProviders(await api("/admin/providers"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (p: any) => {
    await api(`/admin/providers/${p.id}`, { method: "PUT", body: JSON.stringify({ ...p, enabled: !p.enabled }) });
    load();
  };

  const del = async (id: number) => {
    if (!confirm("Delete provider?")) return;
    await api(`/admin/providers/${id}`, { method: "DELETE" });
    load();
  };

  const filtered = filter === "all" ? providers : providers.filter(p => p.type === filter);
  const byCategory: Record<string, any[]> = {};
  for (const p of filtered) {
    const cat = p.type || "free";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--text)" }}>Providers ({providers.length})</h2>
        <button onClick={() => setShowAdd(!showAdd)} style={btnStyle}>{showAdd ? "Cancel" : "Add Provider"}</button>
      </div>
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
      {showAdd && <AddProvider onDone={load} />}
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
              {items.map(p => (
                <div key={p.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong style={{ color: "var(--text)" }}>{p.name}</strong>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: p.enabled ? "var(--success)" : "var(--danger)", color: "#fff" }}>
                      {p.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{p.baseUrl || "(no URL)"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
                    Wire: {p.wireFormat}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 8 }}>
                    <span style={badgeStyle}>RPM: {p.rpmLimit ?? "—"}</span>
                    <span style={badgeStyle}>RPD: {p.rpdLimit ?? "—"}</span>
                    <span style={badgeStyle}>TPM: {p.tpmLimit ?? "—"}</span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => toggleEnabled(p)} style={smBtnStyle}>{p.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => del(p.id)} style={{ ...smBtnStyle, color: "var(--danger)" }}>Delete</button>
                    <KeysButton providerId={p.id} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KeysButton({ providerId }: { providerId: number }) {
  const [show, setShow] = useState(false);
  const [keys, setKeys] = useState<any[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");

  const load = async () => {
    setKeys(await api(`/admin/providers/${providerId}/keys`));
  };

  const add = async () => {
    await api(`/admin/providers/${providerId}/keys`, {
      method: "POST",
      body: JSON.stringify({ apiKey, label: label || "key" }),
    });
    setApiKey(""); setLabel(""); load();
  };

  const del = async (id: number) => {
    await api(`/admin/providers/${providerId}/keys/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <>
      <button onClick={() => { setShow(!show); if (!show) load(); }} style={smBtnStyle}>Keys</button>
      {show && (
        <div style={{ marginTop: 8, padding: 8, background: "var(--badge-bg)", borderRadius: 4 }}>
          {keys.map(k => (
            <div key={k.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4, color: "var(--text)" }}>
              <span>{k.label} (pos {k.rrPosition})</span>
              <button onClick={() => del(k.id)} style={{ color: "var(--danger)", border: "none", cursor: "pointer" }}>×</button>
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <input placeholder="label" value={label} onChange={e => setLabel(e.target.value)} style={inputStyle} />
            <input placeholder="API key" value={apiKey} onChange={e => setApiKey(e.target.value)} style={inputStyle} />
            <button onClick={add} style={smBtnStyle}>Add Key</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Provider presets ──
// User picks a known provider, everything auto-fills. Can still customize.
const PROVIDER_PRESETS: { name: string; baseUrl: string; type: string; wireFormat: string; rpm?: number | null; rpd?: number | null; tpm?: number | null; tpd?: number | null; keyHint?: string }[] = [
  // Free
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", type: "free", wireFormat: "openai", rpm: 20, rpd: 1000, keyHint: "sk-or-..." },
  { name: "Google AI Studio", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", type: "free", wireFormat: "openai", rpm: 15, rpd: 1500, tpm: 250000, keyHint: "AIza..." },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", type: "free", wireFormat: "openai", rpm: 30, rpd: 1000, tpm: 12000, keyHint: "gsk_..." },
  { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", type: "free", wireFormat: "openai", rpm: 30, rpd: 14400, tpm: 60000, keyHint: "csk-..." },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", type: "free", wireFormat: "openai", rpm: 1, tpm: 500000, keyHint: "API key" },
  { name: "GitHub Models", baseUrl: "https://models.inference.ai.azure.com", type: "free", wireFormat: "openai", keyHint: "ghp_..." },
  { name: "Cohere", baseUrl: "https://api.cohere.ai/v1", type: "free", wireFormat: "openai", rpm: 20, tpd: 1000, keyHint: "API key" },
  { name: "HuggingFace", baseUrl: "https://api-inference.huggingface.co", type: "free", wireFormat: "openai", keyHint: "hf_..." },
  { name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", type: "free", wireFormat: "openai", rpm: 40, keyHint: "nvapi-..." },
  { name: "SambaNova", baseUrl: "https://api.sambanova.ai/v1", type: "free", wireFormat: "openai", keyHint: "API key" },
  // Paid
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com", type: "paid", wireFormat: "anthropic", keyHint: "sk-ant-..." },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "xAI", baseUrl: "https://api.x.ai/v1", type: "paid", wireFormat: "openai", keyHint: "xai-..." },
  { name: "MiniMax", baseUrl: "https://api.minimax.io/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Qwen / Alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Moonshot / Kimi", baseUrl: "https://api.moonshot.ai/v1", type: "paid", wireFormat: "openai", keyHint: "sk-..." },
  { name: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4", type: "paid", wireFormat: "openai", keyHint: "API key" },
  { name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", type: "paid", wireFormat: "openai", keyHint: "fw_..." },
  // Local
  { name: "Ollama", baseUrl: "http://localhost:11434/v1", type: "local", wireFormat: "openai" },
  { name: "llama.cpp", baseUrl: "http://localhost:8080/v1", type: "local", wireFormat: "openai" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1", type: "local", wireFormat: "openai" },
  { name: "Custom", baseUrl: "", type: "free", wireFormat: "openai" },
];

function AddProvider({ onDone }: { onDone: () => void }) {
  const [presetIdx, setPresetIdx] = useState(0);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [type, setType] = useState("free");
  const [wireFormat, setWireFormat] = useState("openai");
  const [rpm, setRpm] = useState("");
  const [rpd, setRpd] = useState("");
  const [tpm, setTpm] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");

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
    setApiKey("");
    setError("");
  };

  const submit = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!baseUrl.trim() && type !== "local") { setError("Base URL is required"); return; }
    try {
      const body: any = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        type,
        wireFormat,
        rpmLimit: rpm ? Number(rpm) : null,
        rpdLimit: rpd ? Number(rpd) : null,
        tpmLimit: tpm ? Number(tpm) : null,
        enabled: true,
      };
      const res = await api("/admin/providers", { method: "POST", body: JSON.stringify(body) });
      const providerId = res.id;
      // If API key provided, add it immediately
      if (apiKey.trim() && providerId) {
        await api(`/admin/providers/${providerId}/keys`, {
          method: "POST",
          body: JSON.stringify({ apiKey: apiKey.trim(), label: "default" }),
        });
      }
      // Reset
      setPresetIdx(0);
      setName(""); setBaseUrl(""); setApiKey("");
      onDone();
    } catch (e: any) {
      setError(e.message || "Failed to create provider");
    }
  };

  const preset = PROVIDER_PRESETS[presetIdx];
  const isCustom = preset.name === "Custom";

  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>Provider template</label>
        <select
          value={presetIdx}
          onChange={e => selectPreset(Number(e.target.value))}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          {PROVIDER_PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.name} {p.type !== "free" && p.type !== "local" ? `(${p.type})` : p.type === "local" ? "(local)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle}>Name</label>
          <input placeholder="provider name" value={name} onChange={e => setName(e.target.value)} style={inputStyle} disabled={!isCustom && preset.name !== "Custom"} />
        </div>
        <div>
          <label style={labelStyle}>Base URL</label>
          <input placeholder="https://..." value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={inputStyle} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
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
          <label style={labelStyle}>Wire Format</label>
          <select value={wireFormat} onChange={e => setWireFormat(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>RPM Limit</label>
          <input placeholder="—" value={rpm} onChange={e => setRpm(e.target.value)} style={inputStyle} type="number" />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle}>RPD Limit</label>
          <input placeholder="—" value={rpd} onChange={e => setRpd(e.target.value)} style={inputStyle} type="number" />
        </div>
        <div>
          <label style={labelStyle}>TPM Limit</label>
          <input placeholder="—" value={tpm} onChange={e => setTpm(e.target.value)} style={inputStyle} type="number" />
        </div>
      </div>

      {type !== "local" && (
        <div>
          <label style={labelStyle}>API Key {preset.keyHint && <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>hint: {preset.keyHint}</span>}</label>
          <input placeholder="paste API key (optional, can add later)" value={apiKey} onChange={e => setApiKey(e.target.value)} style={inputStyle} type="password" />
        </div>
      )}

      {error && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={submit} style={btnStyle}>Create Provider</button>
        <button onClick={() => selectPreset(0)} style={{ ...btnStyle, background: "var(--badge-bg)", color: "var(--text)" }}>Reset</button>
      </div>
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
        {[["providers", "Providers"], ["tiers", "Tiers"], ["stats", "Stats"]].map(([key, label]) => (
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
            {label}
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
