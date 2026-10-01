import {createHash} from "node:crypto";

// ---- Startup environment (standalone.mjs) ----
// In production the bot cannot run without its database, its token and the
// webhook domain. Grafana metrics are optional: postMetric() turns itself off
// without them, so their absence is only a warning. Exiting over it would show
// up on Coolify as a crash loop.

const REQUIRED_IN_PRODUCTION = ["MONGODB_URI", "ACHIVATOR_TOKEN", "WEBHOOK_URL"];
const METRICS = ["ACHIVATOR_GRAFANA_USER_ID", "ACHIVATOR_GRAFANA_TOKEN"];

// What Telegram accepts as a webhook's secret_token.
const SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

// {missing: names the bot cannot start without, invalid: names whose value
// the bot cannot use, warnings: lines to log}
export function checkEnv(env) {
  if (env.NODE_ENV !== "production") return {missing: [], invalid: [], warnings: []};
  const noMetrics = METRICS.filter(name => !env[name]);
  return {
    missing: REQUIRED_IN_PRODUCTION.filter(name => !env[name]),
    invalid: env.WEBHOOK_SECRET && !SECRET_TOKEN.test(env.WEBHOOK_SECRET) ? ["WEBHOOK_SECRET"] : [],
    warnings: noMetrics.length ? [`Metrics disabled, missing ENV var: ${noMetrics.join(", ")}`] : [],
  };
}

// ---- Webhook secret ----
// Telegram sends every webhook update with the X-Telegram-Bot-Api-Secret-Token
// header set to the secret_token given to setWebhook, and telegraf answers
// 403 to a request without it (or with another one). Without it anyone who
// learns the webhook URL could post forged updates, e.g. a supergroup
// "migrated from" someone else's group, which would attach that group's
// economy and TON pool to the forger's chat (index.mjs, the migration).
// WEBHOOK_SECRET when set, else derived from the bot token, so it stays the
// same across restarts and deploys without any setup.
export function webhookSecret(env) {
  if (env.WEBHOOK_SECRET) return env.WEBHOOK_SECRET;
  return createHash("sha256").update(`achivator webhook secret\n${env.ACHIVATOR_TOKEN ?? ""}`).digest("hex");
}

// telegraf's launch({webhook}) options for production.
export function webhookOptions(env) {
  return {
    domain: env.WEBHOOK_URL,
    port: parseInt(env.PORT || "3000", 10),
    secretToken: webhookSecret(env),
  };
}
