export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  appSecret: string;
  transcodeHw: "auto" | "nvenc" | "amf" | "qsv" | "cpu";
  modelsRefreshIntervalSec: number;
  adminPassword?: string;
}

const env = process.env;

function envInt(key: string, fallback: number): number {
  const v = env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function envStr(key: string, fallback: string): string {
  return env[key] ?? fallback;
}

export function loadConfig(): AppConfig {
  return {
    port: envInt("PORT", 8000),
    host: envStr("HOST", "0.0.0.0"),
    databaseUrl: envStr("DATABASE_URL", "data/router.db"),
    appSecret: envStr("APP_SECRET", ""),
    transcodeHw: (envStr("TRANSCODE_HW", "auto") as AppConfig["transcodeHw"]),
    modelsRefreshIntervalSec: envInt("MODELS_REFRESH_INTERVAL", 3600),
    adminPassword: env["ADMIN_PASSWORD"],
  };
}
