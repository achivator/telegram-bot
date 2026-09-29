// ---- Service subscription ----
// Accruing points is the paid part of Achivator; claiming points already
// earned never depends on it (the pool contract knows nothing about it).
// The chat creator (chats.creator) pays a monthly Telegram Stars
// subscription. A chat gets TRIAL_DAYS free from the moment it first sets a
// reward jetton, and GRACE_DAYS after the trial or the paid period ends, so a
// late renewal does not stop the rewards at once.
//
// Chat fields: trial_started_at (Date), paid_until (Date), subscription
// {payer_id, charge_id, recurring, stars, at}. The mini app creates the
// invoice; the bot validates and records the payment.
//
// Off unless SUBSCRIPTIONS_ENABLED=true: then every chat accrues, as before.

const DAY_MS = 24 * 60 * 60 * 1000;

function days(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 && value <= 365 ? value : fallback;
}

export const SUBSCRIPTION_PAYLOAD_PREFIX = "sub:";

export function subscriptionConfig() {
  return {
    enabled: process.env.SUBSCRIPTIONS_ENABLED === "true",
    trialDays: days("TRIAL_DAYS", 14),
    graceDays: days("GRACE_DAYS", 3),
  };
}

const time = value => (value ? new Date(value).getTime() : NaN);

// Where a chat stands at `now`. `accrues` says whether reactions and grants
// earn points; `ends_at` is when the current free or paid period ends and
// `grace_until` when accrual actually stops.
export function serviceState(chat, now = new Date(), config = subscriptionConfig()) {
  if (!config.enabled) return {state: "off", accrues: true, ends_at: null, grace_until: null};
  const trialEnd = time(chat?.trial_started_at) + config.trialDays * DAY_MS;
  const paidUntil = time(chat?.paid_until);
  const ends = Math.max(Number.isNaN(trialEnd) ? -Infinity : trialEnd, Number.isNaN(paidUntil) ? -Infinity : paidUntil);
  if (ends === -Infinity) return {state: "not_started", accrues: false, ends_at: null, grace_until: null};
  const graceUntil = ends + config.graceDays * DAY_MS;
  const at = now.getTime();
  const state =
    at < ends ? (paidUntil > at ? "paid" : "trial") : at < graceUntil ? "grace" : "expired";
  return {state, accrues: at < graceUntil, ends_at: new Date(ends), grace_until: new Date(graceUntil)};
}

// Invoice payload: "sub:<chat id>". Returns the chat id or null.
export function parseSubscriptionPayload(payload) {
  if (typeof payload !== "string" || !payload.startsWith(SUBSCRIPTION_PAYLOAD_PREFIX)) return null;
  const chatId = Number(payload.slice(SUBSCRIPTION_PAYLOAD_PREFIX.length));
  return Number.isSafeInteger(chatId) ? chatId : null;
}
