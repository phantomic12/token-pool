import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

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
        {error && <div style={{ color: "red" }}>{error}</div>}
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
        <h2 style={{ margin: 0 }}>Providers ({providers.length})</h2>
        <button onClick={() => setShowAdd(!showAdd)} style={btnStyle}>{showAdd ? "Cancel" : "Add Provider"}</button>
      </div>
      {/* Category filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("all")} style={{ ...filterBtn, background: filter === "all" ? "#444" : "#222", color: filter === "all" ? "#fff" : "#888" }}>All ({providers.length})</button>
        {CATEGORIES.map(c => {
          const count = providers.filter(p => p.type === c.key).length;
          if (count === 0) return null;
          return (
            <button key={c.key} onClick={() => setFilter(c.key)} style={{ ...filterBtn, background: filter === c.key ? c.color : "#222", color: filter === c.key ? "#000" : "#888" }}>
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
              <h3 style={{ margin: 0, fontSize: 14, color: "#aaa", textTransform: "uppercase", letterSpacing: 1 }}>{cat.label}</h3>
              <span style={{ fontSize: 12, color: "#666" }}>({items.length})</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
              {items.map(p => (
                <div key={p.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{p.name}</strong>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: p.enabled ? "#2d5" : "#d33", color: "#fff" }}>
                      {p.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "#888" }}>{p.baseUrl || "(no URL)"}</div>
                  <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
                    Wire: {p.wireFormat}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 8 }}>
                    <span style={badgeStyle}>RPM: {p.rpmLimit ?? "—"}</span>
                    <span style={badgeStyle}>RPD: {p.rpdLimit ?? "—"}</span>
                    <span style={badgeStyle}>TPM: {p.tpmLimit ?? "—"}</span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => toggleEnabled(p)} style={smBtnStyle}>{p.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => del(p.id)} style={{ ...smBtnStyle, color: "red" }}>Delete</button>
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
        <div style={{ marginTop: 8, padding: 8, background: "#f5f5f5", borderRadius: 4 }}>
          {keys.map(k => (
            <div key={k.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <span>{k.label} (pos {k.rrPosition})</span>
              <button onClick={() => del(k.id)} style={{ color: "red", border: "none", cursor: "pointer" }}>×</button>
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

function AddProvider({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [type, setType] = useState("free");
  const [wireFormat, setWireFormat] = useState("openai");

  const submit = async () => {
    await api("/admin/providers", { method: "POST", body: JSON.stringify({ name, baseUrl, type, wireFormat, enabled: true }) });
    setName(""); setBaseUrl(""); onDone();
  };

  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <input placeholder="name" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
      <input placeholder="base URL" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={inputStyle} />
      <div style={{ display: "flex", gap: 8 }}>
        <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}>
          <option value="free">Free Tier</option>
          <option value="paid">Paid</option>
          <option value="local">Local</option>
          <option value="subscription">Subscription</option>
        </select>
        <select value={wireFormat} onChange={e => setWireFormat(e.target.value)} style={inputStyle}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google</option>
        </select>
      </div>
      <button onClick={submit} style={btnStyle}>Create</button>
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
      <h2>Routing Tiers</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {tiers.map(t => (
          <div key={t.id} style={cardStyle}>
            <strong>{t.name}</strong>
            <div style={{ fontSize: 13, color: "#888" }}>{t.description}</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {models[t.name]?.length > 0 ? (
                models[t.name].map((m: any, i: number) => (
                  <div key={i}>{m.priority}. {m.model_id} (provider {m.provider_id})</div>
                ))
              ) : (
                <div style={{ color: "#aaa" }}>No models configured</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stats ──

function Stats() {
  const [stats, setStats] = useState<any>(null);

  const load = useCallback(async () => {
    setStats(await api("/admin/stats?days=30"));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!stats) return <div>Loading stats...</div>;

  const tierData = (stats.byTier || []).map((t: any) => ({ name: t.tier, value: t.count }));
  const providerData = (stats.byProvider || []).map((p: any) => ({ name: `Provider ${p.providerId}`, count: p.count }));
  const dailyData = (stats.daily || []).map((d: any) => ({ date: d.date, count: d.count, tokens: (d.inputTokens || 0) + (d.outputTokens || 0) }));

  const COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7300", "#e41d3d"];

  return (
    <div>
      <h2>Usage Stats (30 days)</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={cardStyle}>
          <h3>By Tier</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={tierData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                {tierData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={cardStyle}>
          <h3>By Provider</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={providerData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{ ...cardStyle, gridColumn: "1 / -1" }}>
          <h3>Daily Requests</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#82ca9d" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <a href="/v1/admin/stats/export?days=30" target="_blank">
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

  if (!logged) return <Login onLogin={() => setLogged(true)} />;

  const logout = () => {
    localStorage.removeItem("token");
    setLogged(false);
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1>token-pool</h1>
        <button onClick={logout} style={btnStyle}>Logout</button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, borderBottom: "2px solid #eee" }}>
        {[["providers", "Providers"], ["tiers", "Tiers"], ["stats", "Stats"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: "8px 16px",
              border: "none",
              background: tab === key ? "#333" : "transparent",
              color: tab === key ? "#fff" : "#333",
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

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "8px", margin: "8px 0",
  border: "1px solid #ddd", borderRadius: 4, boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px", border: "none", borderRadius: 4,
  background: "#333", color: "#fff", cursor: "pointer",
};

const smBtnStyle: React.CSSProperties = {
  padding: "4px 8px", margin: "0 4px 0 0", border: "1px solid #ddd",
  borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 12,
};

const cardStyle: React.CSSProperties = {
  padding: 16, border: "1px solid #e0e0e0", borderRadius: 8, background: "#fff",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-block", padding: "2px 6px", margin: "0 4px 2px 0",
  background: "#f0f0f0", borderRadius: 4, fontSize: 12,
};

const filterBtn: React.CSSProperties = {
  padding: "6px 12px", border: "none", borderRadius: 4,
  cursor: "pointer", fontSize: 13, fontWeight: 600,
};

createRoot(document.getElementById("root")!).render(<App />);
