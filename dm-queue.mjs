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
// queue for `retry_after` (createPause: shared by every process, and by the
// announcements) and puts the row back with `send_after`.
//
// A bot can only write to users who have started it. Those who have not, or
// who blocked it (403), or whose account is gone (400 "chat not found"), get
// `users.dm_blocked_at`: their rows are skipped, and later fan-outs leave
// them out, until they /start the bot again (clearBlocked). Other failures
// are retried with backoff and given up after DM_MAX_ATTEMPTS.
//
// Reminders are opt-out: a user who sent /notify off has
// `users.notify_off_at`, and their reminder rows (`optional`) are skipped
// until /notify on. The first message the queue sends a user says so; it is
// recorded as `users.first_dm_at`.
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

// What a failed send means: "rate_limited" (wait `retryAfterMs`), "migrated"
// (the group is now the supergroup `chatId`), "unreachable" (403, or a 400
// matching `unreachable`: no retry will get through), "rejected" (any other
// 4xx: a request Telegram will never accept) or "transient".
export function classifyTelegramError(error, unreachable = UNREACHABLE) {
  const code = error?.code ?? error?.response?.error_code;
  const description = String(error?.description ?? error?.message ?? error);
  const parameters = error?.parameters ?? error?.response?.parameters;
  if (code === 429) {
    const retryAfter = Number(parameters?.retry_after);
    return {kind: "rate_limited", retryAfterMs: (retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_S) * 1000, description};
  }
  if (code === 400 && parameters?.migrate_to_chat_id) {
    return {kind: "migrated", chatId: Number(parameters.migrate_to_chat_id), description};
  }
  if (code === 403 || (code === 400 && unreachable.test(description))) return {kind: "unreachable", description};
  // any other 4xx is a request Telegram will never accept (our bug)
  if (typeof code === "number" && code >= 400 && code < 500) return {kind: "rejected", description};
  return {kind: "transient", description}; // 5xx, network
}

function unwrap(result) {
  return result?.value !== undefined ? result.value : result;
}

// ---- Telegram's rate limit ----
// After a 429 nothing may be sent until `retry_after` has passed. The pause
// lives in the database, `bot_state` {_id: "telegram_pause", pause_until,
// reason}, and is read before sending: during a rolling deploy two
// containers run side by side, and a pause only one of them knew about would
// let the other go on at full rate. A process also keeps the pause it hit
// itself, in case storing it fails.
const PAUSE_ID = "telegram_pause";

export function createPause(database) {
  const state = database.collection("bot_state");
  let local = null;

  // The moment sending may resume, or null when it may go on now.
  async function until(now = new Date()) {
    const doc = await state.findOne({_id: PAUSE_ID});
    const stored = doc?.pause_until ? new Date(doc.pause_until) : null;
    const latest = [local, stored].filter(at => at && at > now).sort((a, b) => b - a)[0];
    return latest ?? null;
  }
  // $max: a shorter pause never cuts a longer one short
  async function set(at, reason = null) {
    if (!local || at > local) local = at;
    await state.updateOne({_id: PAUSE_ID}, {$max: {pause_until: at}, $set: {reason}}, {upsert: true});
  }

  return {until, set};
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveNumber(value, fallback) {
  return Number(value) > 0 ? Number(value) : fallback;
}

// `render(row, {firstDm})` -> {text, extra, hinted} or null (malformed:
// given up); `firstDm` is true while the user has never been sent a message
// from this queue (users.first_dm_at), and `hinted: true` records that this
// one told them how to opt out, which sets first_dm_at once it is sent.
// `isStale(row, now, cache)` -> a reason to skip the row instead of sending,
// or null; `cache` is a Map that lives for one pass.
// `optional(row)`: whether the row is a reminder the user can turn off with
// /notify off (users.notify_off_at); such rows are skipped, "notify off".
// `onOutcome(row, outcome)` hears what became of a row before it is marked:
// "sent", "unreachable", "opted_out" or "failed" (given up); a row dropped
// as stale is not reported. Its failures are logged, never retried.
// `pause` is createPause's, shared with whatever else sends.
export function createDmQueue({
  database,
  telegram,
  render,
  isStale = async () => null,
  optional = () => false,
  onOutcome = async () => {},
  pause = createPause(database),
  env = process.env,
  timers = {setTimeout, clearTimeout},
}) {
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
  // message may go out.
  let nextSlot = 0;

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

  async function report(row, outcome) {
    try {
      await onOutcome(row, outcome);
    } catch (error) {
      console.error(`dm ${row._id}: reporting ${outcome} failed:`, error);
    }
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
      if (await pause.until(now)) {
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
      const known = await users
        .find({id: {$in: ids}}, {projection: {id: 1, dm_blocked_at: 1, notify_off_at: 1, first_dm_at: 1}})
        .toArray();
      const blocked = new Set(known.filter(doc => doc.dm_blocked_at).map(doc => doc.id));
      const optedOut = new Set(known.filter(doc => doc.notify_off_at).map(doc => doc.id));
      const written = new Set(known.filter(doc => doc.first_dm_at).map(doc => doc.id));
      const cache = new Map();

      for (const queued of due) {
        if (shouldStop()) break;
        const row = unwrap(
          await queue.findOneAndUpdate({_id: queued._id, sent_at: null, claimed_at: null}, {$set: {claimed_at: now}}),
        );
        if (!row) continue; // another pass took it
        const where = `dm ${row._id} (${row.kind}) to ${row.user_id}`;
        try {
          const reason = blocked.has(row.user_id)
            ? "dm blocked"
            : optedOut.has(row.user_id) && optional(row)
            ? "notify off"
            : await isStale(row, now, cache);
          if (reason) {
            if (reason === "dm blocked") await report(row, "unreachable");
            if (reason === "notify off") await report(row, "opted_out");
            await queue.updateOne({_id: row._id}, {$set: {sent_at: now, skipped: reason}});
            done.skipped++;
            continue;
          }
          const message = render(row, {firstDm: !written.has(row.user_id)});
          if (!message) {
            console.error(`${where}: unknown kind or malformed params, giving up`, row.params);
            await report(row, "failed");
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
            const outcome = classifyTelegramError(error);
            if (outcome.kind === "rate_limited") {
              // Telegram's own instruction, not a failure of this message
              const pausedUntil = new Date(now.getTime() + (performance.now() - started) + outcome.retryAfterMs);
              console.error(`${where}: rate limited, pausing until ${pausedUntil.toISOString()}`);
              await pause
                .set(pausedUntil, outcome.description)
                .catch(failure => console.error("storing the rate limit pause failed:", failure));
              await queue.updateOne(
                {_id: row._id},
                {$set: {claimed_at: null, send_after: pausedUntil, last_error: outcome.description}},
              );
              done.paused = true;
              break;
            }
            if (outcome.kind === "unreachable") {
              console.log(`${where}: skipped, the user cannot be written to (${outcome.description})`);
              await report(row, "unreachable");
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
            if (giveUp) await report(row, "failed");
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
          // reported first: if marking the row fails, the claim expires and
          // the user hears it (and it is counted) twice, which beats never
          await report(row, "sent");
          await queue.updateOne({_id: row._id}, {$set: {sent_at: now}});
          done.sent++;
          if (message.hinted) {
            written.add(row.user_id);
            await users
              .updateOne({id: row.user_id}, {$min: {first_dm_at: now}}, {upsert: true})
              .catch(error => console.error("recording first_dm_at failed:", error));
          }
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

  // ---- The loop ----
  // A pass runs every `everyMs` while there is work. A pass that finds
  // nothing to do (or only Telegram's pause) waits twice as long as the last
  // one, up to DM_MAX_IDLE_MS (default 30 s, never below everyMs), so an idle
  // bot does not query the queue every second. Rows are queued by the
  // fan-outs, which call wake() in their process: the next pass then runs at
  // once (rows another process queued wait at most the idle cap).
  // The bot_state pause is still read by every pass (run()).
  // `timers` is injectable for tests.
  const maxIdleMs = Math.max(intervalMs, positiveNumber(env.DM_MAX_IDLE_MS, 30 * 1000));
  let timer = null;
  let running = null;
  let started = false;
  let stopping = false;
  let woken = false;
  let everyMs = intervalMs;
  let idleMs = 0; // the last idle wait, 0 after a pass that did something

  function schedule(delay) {
    timer = timers.setTimeout(tick, delay);
    timer?.unref?.();
  }
  function tick() {
    timer = null;
    if (stopping) return;
    woken = false;
    running = run(new Date(), {shouldStop: () => stopping})
      .then(done => {
        const busy = done && (done.sent || done.skipped || done.failed);
        idleMs = busy ? 0 : Math.min(Math.max(maxIdleMs, everyMs), idleMs ? idleMs * 2 : everyMs * 2);
      })
      .catch(error => console.error("private message queue failed:", error))
      .finally(() => {
        running = null;
        if (stopping) return;
        if (woken) idleMs = 0;
        schedule(woken ? 0 : idleMs || everyMs);
      });
  }
  function start(interval = intervalMs) {
    if (started) return;
    started = true;
    stopping = false;
    everyMs = interval;
    idleMs = 0;
    // a pass from before a stop() is still going: it schedules the next one
    if (running) woken = true;
    else tick();
  }
  // The pass in progress stops before its next message.
  function stop() {
    started = false;
    stopping = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }
  // New rows were queued: run a pass now instead of after the idle wait.
  function wake() {
    if (!started) return;
    if (running) {
      woken = true; // the pass in progress may have missed them
      return;
    }
    if (timer) timers.clearTimeout(timer);
    idleMs = 0;
    schedule(0);
  }

  return {
    collection: queue,
    enqueue,
    markBlocked,
    clearBlocked,
    run,
    start,
    stop,
    wake,
    limits: {ratePerSec, intervalMs, budget},
  };
}
