import {performance} from "node:perf_hooks";

// ---- Private messages queue ----
// Messages the bot writes to members in private (e.g. "the price of your
// points drops soon") go through the `dm_queue` collection:
//   {user_id, chat_id, source_id, kind, params, lang, created_at, send_after,
//    sent_at, claimed_at, attempts, last_error, skipped?}
// One row per (source_id, user_id): a unique index makes enqueuing
// idempotent, so re-running a fan-out, or two runs doing it at once, never
// queues a member twice for the same event.
//
// Telegram allows about 30 messages per second to different users; bulk
// sends above that get HTTP 429 with `retry_after`. The queue sends at most
// DM_RATE_PER_SEC (default 20, at most 25) messages per second, spaced
// evenly, and at most one second's worth per pass. A 429 pauses the whole
// queue for `retry_after` and puts the row back with `send_after`.
//
// A bot can only write to users who have started it. Those who have not, or
// who blocked it (403), or whose account is gone (400 "chat not found"), get
// `users.dm_blocked_at`: their rows are skipped, and later fan-outs leave
// them out, until they /start the bot again (clearBlocked). Other failures
// are retried with backoff and given up after DM_MAX_ATTEMPTS.
//
// Rows are claimed atomically, like the announcements outbox, so overlapping
// passes or processes never send one twice; a claim older than
// DM_CLAIM_TIMEOUT_MS belongs to a pass that died and is taken over.

export const DM_MAX_ATTEMPTS = 5;
const DM_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const DM_RETRY_BASE_MS = 30 * 1000; // 30 s, 1 min, 2 min, 4 min
const DM_MAX_RATE_PER_SEC = 25;
const DEFAULT_RETRY_AFTER_S = 5;
const INSERT_CHUNK = 500;

// Errors that no retry will fix for this user: they have not started the bot,
// blocked it, or their account no longer exists.
const UNREACHABLE = /chat not found|user not found|PEER_ID_INVALID|user is deactivated/i;

function classify(error) {
  const code = error?.code ?? error?.response?.error_code;
  const description = String(error?.description ?? error?.message ?? error);
  if (code === 429) {
    const retryAfter = Number(error?.parameters?.retry_after ?? error?.response?.parameters?.retry_after);
    return {kind: "rate_limited", retryAfterMs: (retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_S) * 1000, description};
  }
  if (code === 403 || (code === 400 && UNREACHABLE.test(description))) return {kind: "unreachable", description};
  // any other 4xx is a request Telegram will never accept (our bug)
  if (typeof code === "number" && code >= 400 && code < 500) return {kind: "rejected", description};
  return {kind: "transient", description}; // 5xx, network
}

function unwrap(result) {
  return result?.value !== undefined ? result.value : result;
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveNumber(value, fallback) {
  return Number(value) > 0 ? Number(value) : fallback;
}

// `render(row)` -> {text, extra} or null (malformed: given up);
// `isStale(row, now, cache)` -> a reason to skip the row instead of sending,
// or null; `cache` is a Map that lives for one pass.
export function createDmQueue({database, telegram, render, isStale = async () => null, env = process.env}) {
  const queue = database.collection("dm_queue");
  const users = database.collection("users");

  let ratePerSec = positiveNumber(env.DM_RATE_PER_SEC, 20);
  if (ratePerSec > DM_MAX_RATE_PER_SEC) {
    console.error(`DM_RATE_PER_SEC=${ratePerSec} is above Telegram's bulk limit, using ${DM_MAX_RATE_PER_SEC}`);
    ratePerSec = DM_MAX_RATE_PER_SEC;
  }
  const intervalMs = positiveNumber(env.DM_INTERVAL_MS, 1000);
  // one interval's worth of messages per pass
  const budget = Math.max(1, Math.floor((ratePerSec * intervalMs) / 1000));
  const spacingMs = 1000 / ratePerSec;

  queue.createIndex({source_id: 1, user_id: 1}, {unique: true}).catch(console.error);
  queue.createIndex({sent_at: 1, claimed_at: 1, send_after: 1}).catch(console.error);

  // Process-wide pacing: the earliest moment (performance.now()) the next
  // message may go out, and the moment a 429 lifts.
  let nextSlot = 0;
  let pausedUntil = null;

  async function pace(sleep) {
    const delay = nextSlot - performance.now();
    if (delay > 0) await sleep(delay);
    nextSlot = Math.max(performance.now(), nextSlot) + spacingMs;
  }

  // Queues `rows` ({user_id, chat_id, source_id, kind, params, lang});
  // resolves to how many were new. Duplicates are skipped silently.
  async function enqueue(rows, now = new Date()) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const docs = rows.slice(i, i + INSERT_CHUNK).map(row => ({
        ...row,
        created_at: now,
        send_after: now,
        sent_at: null,
        claimed_at: null,
        attempts: 0,
        last_error: null,
      }));
      try {
        await queue.insertMany(docs, {ordered: false});
        inserted += docs.length;
      } catch (error) {
        // an unordered insert reports every rejected document; only
        // "already queued" ones are expected
        const writeErrors = [].concat(error?.writeErrors ?? []);
        const duplicates = writeErrors.filter(e => e?.code === 11000).length;
        if (writeErrors.length === 0 || duplicates !== writeErrors.length) throw error;
        inserted += docs.length - duplicates;
      }
    }
    return inserted;
  }

  // The user cannot be written to until they start the bot again.
  function markBlocked(user_id, at = new Date()) {
    return users.updateOne({id: user_id}, {$set: {dm_blocked_at: at}}, {upsert: true});
  }
  function clearBlocked(user_id) {
    return users.updateOne({id: user_id, dm_blocked_at: {$ne: null}}, {$unset: {dm_blocked_at: ""}});
  }

  // One pass: sends up to `budget` due messages. Never rejects; resolves to
  // what it did, for logs and tests. `sleep` is injectable for tests.
  async function run(now = new Date(), {sleep = realSleep, shouldStop = () => false} = {}) {
    const done = {sent: 0, skipped: 0, failed: 0, paused: false};
    const started = performance.now();
    try {
      if (pausedUntil && pausedUntil > now) {
        done.paused = true;
        return done;
      }
      await queue.updateMany(
        {sent_at: null, claimed_at: {$lte: new Date(now.getTime() - DM_CLAIM_TIMEOUT_MS)}},
        {$set: {claimed_at: null}},
      );
      const due = await queue
        .find({sent_at: null, claimed_at: null, send_after: {$lte: now}, attempts: {$not: {$gte: DM_MAX_ATTEMPTS}}})
        .sort({send_after: 1})
        .limit(budget)
        .toArray();
      if (due.length === 0) return done;

      const ids = [...new Set(due.map(row => row.user_id))];
      const blocked = new Set(
        (await users.find({id: {$in: ids}, dm_blocked_at: {$ne: null}}).toArray()).map(doc => doc.id),
      );
      const cache = new Map();

      for (const queued of due) {
        if (shouldStop()) break;
        const row = unwrap(
          await queue.findOneAndUpdate({_id: queued._id, sent_at: null, claimed_at: null}, {$set: {claimed_at: now}}),
        );
        if (!row) continue; // another pass took it
        const where = `dm ${row._id} (${row.kind}) to ${row.user_id}`;
        try {
          const reason = blocked.has(row.user_id) ? "dm blocked" : await isStale(row, now, cache);
          if (reason) {
            await queue.updateOne({_id: row._id}, {$set: {sent_at: now, skipped: reason}});
            done.skipped++;
            continue;
          }
          const message = render(row);
          if (!message) {
            console.error(`${where}: unknown kind or malformed params, giving up`, row.params);
            await queue.updateOne(
              {_id: row._id},
              {$set: {claimed_at: null, attempts: DM_MAX_ATTEMPTS, last_error: "unknown kind or malformed params"}},
            );
            done.failed++;
            continue;
          }

          await pace(sleep);
          try {
            await telegram.sendMessage(row.user_id, message.text, message.extra);
          } catch (error) {
            const outcome = classify(error);
            if (outcome.kind === "rate_limited") {
              // Telegram's own instruction, not a failure of this message
              pausedUntil = new Date(now.getTime() + (performance.now() - started) + outcome.retryAfterMs);
              console.error(`${where}: rate limited, pausing private messages until ${pausedUntil.toISOString()}`);
              await queue.updateOne(
                {_id: row._id},
                {$set: {claimed_at: null, send_after: pausedUntil, last_error: outcome.description}},
              );
              done.paused = true;
              break;
            }
            if (outcome.kind === "unreachable") {
              console.log(`${where}: skipped, the user cannot be written to (${outcome.description})`);
              await queue.updateOne(
                {_id: row._id},
                {$set: {sent_at: now, skipped: "unreachable", last_error: outcome.description}},
              );
              await markBlocked(row.user_id, now);
              blocked.add(row.user_id);
              done.skipped++;
              continue;
            }
            const attempts = outcome.kind === "rejected" ? DM_MAX_ATTEMPTS : (row.attempts || 0) + 1;
            const giveUp = attempts >= DM_MAX_ATTEMPTS;
            console.error(`${where}: attempt ${(row.attempts || 0) + 1} failed${giveUp ? ", giving up" : ""}:`, outcome.description);
            await queue.updateOne(
              {_id: row._id},
              {
                $set: {
                  claimed_at: null,
                  attempts,
                  last_error: outcome.description,
                  send_after: new Date(now.getTime() + DM_RETRY_BASE_MS * 2 ** (attempts - 1)),
                },
              },
            );
            done.failed++;
            continue;
          }
          // if this write fails the claim expires and the user hears it
          // twice, which beats never
          await queue.updateOne({_id: row._id}, {$set: {sent_at: now}});
          done.sent++;
        } catch (error) {
          // the claim expires and a later pass retries
          console.error(`${where} failed:`, error);
        }
      }
      if (done.sent || done.skipped || done.failed) {
        console.log(`private messages: ${done.sent} sent, ${done.skipped} skipped, ${done.failed} failed`);
      }
    } catch (error) {
      console.error("private message queue failed:", error);
    }
    return done;
  }

  let timer = null;
  let running = null;
  let stopping = false;
  function start(everyMs = intervalMs) {
    if (timer) return;
    stopping = false;
    const tick = () => {
      if (running) return; // the previous pass is still going
      running = run(new Date(), {shouldStop: () => stopping})
        .catch(error => console.error("private message queue failed:", error))
        .finally(() => (running = null));
    };
    timer = setInterval(tick, everyMs);
    timer.unref();
    tick();
  }
  // The pass in progress stops before its next message.
  function stop() {
    stopping = true;
    clearInterval(timer);
    timer = null;
  }

  return {
    collection: queue,
    enqueue,
    markBlocked,
    clearBlocked,
    run,
    start,
    stop,
    limits: {ratePerSec, intervalMs, budget},
  };
}
