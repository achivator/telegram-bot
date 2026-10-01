import {decimalSub, isPositiveDecimal} from "./decimal.mjs";

// ---- What a price decrease reminder tells a member ----
// Mirrors the mini app's lot pricing (src/lib/lot-pricing.js, claim-rules.js),
// which pays the points:
//   - a point (a reaction_points or grants doc, "a lot") earned at `e` is
//     claimable once e <= now - maturation, the chat's claim setting;
//   - a decrease taking effect at `d` protects the lots earned at e with
//     e < d < e + M, M being the maturation in force at `d`: the pending
//     decrease's maturation_days snapshot, or the chat's setting for one
//     scheduled before snapshots existed. Protected lots keep the price in
//     force before the drop, so they need no reminder;
//   - claims use the oldest points first (rewards.claimed_points), and points
//     no lot explains are the oldest of all, so the unclaimed points are the
//     newest ones.
// Everything here is pure: callers read the documents and pass `now`.

export const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MATURATION_DAYS = 30;

function validDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MATURATION_DAYS;
}

// The mini app's default (its MATURATION_DAYS, 3 unless set): set the same
// value for the bot.
export function defaultMaturationDays(env = process.env) {
  const n = Number(env.MATURATION_DAYS ?? 3);
  return validDays(n) ? n : 3;
}

// The chat's maturation setting, as claimSettingsOf() reads it: settings that
// do not validate as a whole fall back to the defaults.
export function chatMaturationDays(chat, env = process.env) {
  const raw = chat?.claim_settings || {};
  const maturation = raw.maturation_days ?? defaultMaturationDays(env);
  const days = raw.claim_days ?? [];
  const pausedUntil = raw.paused_until ?? null;
  const valid =
    validDays(maturation) &&
    Array.isArray(days) &&
    days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) &&
    (pausedUntil === null || (Number.isSafeInteger(pausedUntil) && pausedUntil > 0));
  return valid ? maturation : defaultMaturationDays(env);
}

// The maturation that decides which lots a pending decrease protects: its
// own snapshot, else the chat's setting.
export function decreaseMaturationDays(pending, chat, env = process.env) {
  const snapshot = pending?.maturation_days;
  return Number.isInteger(snapshot) && snapshot >= 0 ? snapshot : chatMaturationDays(chat, env);
}

function toMs(at) {
  if (at instanceof Date) return at.getTime();
  if (typeof at === "number") return at;
  return NaN;
}

// Lots earned after `since(...)` are the only ones a reminder needs to see:
// the earliest of "still maturing now" and "still maturing at the decrease".
export function lotWindowStart({now, effectiveAt, maturationDays, decreaseDays}) {
  return Math.min(toMs(now) - maturationDays * DAY_MS, toMs(effectiveAt) - decreaseDays * DAY_MS);
}

// From one member's recent lots [{points, at: Date | epoch ms}]:
//   maturingNow         points not claimable yet (earned after now - maturation)
//   maturingAtDecrease  points still maturing when the decrease takes effect,
//                       which keep the current price
// Lots without a positive whole amount or a date are ignored, as the mini
// app's normalizeLots() does.
export function maturingPoints(lots, {now, effectiveAt, maturationDays, decreaseDays}) {
  const nowCutoff = toMs(now) - maturationDays * DAY_MS;
  const decreaseCutoff = toMs(effectiveAt) - decreaseDays * DAY_MS;
  let maturingNow = 0;
  let maturingAtDecrease = 0;
  for (const lot of lots || []) {
    const at = toMs(lot?.at);
    if (!Number.isFinite(at) || !Number.isSafeInteger(lot?.points) || lot.points <= 0) continue;
    if (at > nowCutoff) maturingNow += lot.points;
    if (at > decreaseCutoff) maturingAtDecrease += lot.points;
  }
  return {maturingNow, maturingAtDecrease};
}

// min(a, b) for decimals, as a decimal string
function decimalMin(a, b) {
  return isPositiveDecimal(decimalSub(a, b)) ? decimalSub(b, 0) : decimalSub(a, 0);
}

// Splits a member's `unclaimed` points (a decimal string) for the reminder,
// newest points being the maturing ones:
//   claimable  claimable now: claim them before the decrease or lose value
//   maturing   not claimable yet, but claimable before the decrease: the
//              same, as soon as they mature
//   protected  still maturing at the decrease: they keep the current price
//   atRisk     claimable + maturing; no reminder when it is "0"
// All decimal strings; null when `unclaimed` is not a decimal.
export function splitUnclaimed({unclaimed, maturingNow = 0, maturingAtDecrease = 0}) {
  if (decimalSub(unclaimed, 0) === null) return null;
  const total = isPositiveDecimal(unclaimed) ? decimalSub(unclaimed, 0) : "0";
  const kept = decimalMin(total, maturingAtDecrease);
  const atRisk = decimalSub(total, kept);
  const claimable = decimalSub(total, decimalMin(total, Math.max(maturingNow, maturingAtDecrease)));
  return {claimable, maturing: decimalSub(atRisk, claimable), protected: kept, atRisk};
}
