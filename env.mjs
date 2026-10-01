// ---- Startup environment (standalone.mjs) ----
// In production the bot cannot run without its database, its token and the
// webhook domain. Grafana metrics are optional: postMetric() turns itself off
// without them, so their absence is only a warning. Exiting over it would show
// up on Coolify as a crash loop.

const REQUIRED_IN_PRODUCTION = ["MONGODB_URI", "ACHIVATOR_TOKEN", "WEBHOOK_URL"];
const METRICS = ["ACHIVATOR_GRAFANA_USER_ID", "ACHIVATOR_GRAFANA_TOKEN"];

// {missing: names the bot cannot start without, warnings: lines to log}
export function checkEnv(env) {
  if (env.NODE_ENV !== "production") return {missing: [], warnings: []};
  const noMetrics = METRICS.filter(name => !env[name]);
  return {
    missing: REQUIRED_IN_PRODUCTION.filter(name => !env[name]),
    warnings: noMetrics.length ? [`Metrics disabled, missing ENV var: ${noMetrics.join(", ")}`] : [],
  };
}
