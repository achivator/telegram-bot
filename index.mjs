import * as dotenv from "dotenv";
import {Telegraf, session} from "telegraf";
import {channelPost, message} from "telegraf/filters";
import {mention} from "telegraf/format";
import {LANGUAGES, langFromCode, t} from "./i18n.mjs";
import {createDmQueue, DM_MAX_ATTEMPTS} from "./dm-queue.mjs";
import {decimalMul, decimalSub, isPositiveDecimal} from "./decimal.mjs";
import {parseSubscriptionPayload, serviceState, subscriptionConfig} from "./subscription.mjs";

dotenv.config();

const NFT_COLLECTION = "v1";
const MINI_APP_URL = "https://t.me/achivator_bot/app";
const ADD_TO_GROUP_URL = "https://t.me/achivator_bot?startgroup=true";

// Fire-and-forget: a metrics outage must never surface as an unhandled
// rejection (which terminates Node) or block an update handler.
function postMetric(body) {
  if (!process.env.ACHIVATOR_GRAFANA_USER_ID || !process.env.ACHIVATOR_GRAFANA_TOKEN) return Promise.resolve();
  return fetch("https://influx-prod-24-prod-eu-west-2.grafana.net/api/v1/push/influx/write", {
    method: "post",
    body,
    headers: {
      Authorization: `Bearer ${process.env.ACHIVATOR_GRAFANA_USER_ID}:${process.env.ACHIVATOR_GRAFANA_TOKEN}`,
      "Content-Type": "text/plain",
    },
  }).catch(error => console.error("metric push failed:", error.message));
}

// Returns the statistics document after the increment, so thresholds can be
// checked against the value this very update produced.
async function incrementStat(collection, chat_id, user_id, type) {
  postMetric(`messages,chat_id=${chat_id},user_id=${user_id},type=${type} value=1`);

  const result = await collection.findOneAndUpdate(
    {chat_id, user_id},
    {$inc: {[type]: 1}},
    {upsert: true, returnDocument: "after"},
  );
  return unwrapModifyResult(result);
}

// Driver v5 wraps findOneAnd* results in {value}; v6 returns the document.
function unwrapModifyResult(result) {
  return result?.value !== undefined ? result.value : result;
}

// Telegram sends ❤ without the U+FE0F variation selector, clients often type
// it with one; compare and store emoji without it.
function normalizeEmoji(emoji) {
  return String(emoji).replace(/\uFE0F/g, "");
}

function mentionUser(user, lang) {
  return mention(user.first_name || user.username || t(lang, "member"), user);
}

// Awards `achievement` to `user` (the sender of the update by default) once per
// chat. Called fire-and-forget from update handlers, so it must never reject:
// an unhandled rejection terminates Node.
async function giveAchievement(ctx, dbCollection, achievement, {user = ctx.from, message_id} = {}) {
  try {
    const chat_id = ctx.chat.id;
    const user_id = user.id;

    const existingAchievement = await dbCollection.findOne({
      chat_id,
      user_id,
      type: achievement,
      collection: NFT_COLLECTION,
    });

    if (existingAchievement) return;

    await dbCollection.insertOne({
      chat_id,
      user_id,
      type: achievement,
      date: Date.now(),
      message_id: message_id ?? ctx.message?.message_id ?? ctx.messageReaction?.message_id,
      collection: NFT_COLLECTION,
    });

    console.log(`User ${user_id} got achievement ${achievement} in chat ${chat_id}`);

    // the achievement name is also the medal's id, only the sentence is translated
    const lang = await ctx.state.lang();
    ctx
      .sendMessage(t(lang, "achievementUnlocked", mentionUser(user, lang), achievement, MINI_APP_URL))
      .then(botReply => setTimeout(() => ctx.deleteMessage(botReply.message_id).catch(console.error), 30000))
      .catch(console.error);

    // Send grafana metric to count achievements
    postMetric(`achievements,chat_id=${chat_id},user_id=${user_id},type=${achievement} value=1`);
  } catch (error) {
    console.error(`achievement ${achievement} failed:`, error);
  }
}

// True when a counter that just grew by `added` to `after` passed `threshold`.
// Reactions are counted several at a time, so an exact `=== 100` can be skipped.
function crossed(after, added, threshold) {
  return added > 0 && (after || 0) >= threshold && (after || 0) - added < threshold;
}

function isGroup(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

// Only people's messages in groups count: bots, anonymous admins and posts sent
// on behalf of a channel (both arrive from a bot account) have nobody to reward.
function isMemberMessage(ctx) {
  return Boolean(ctx.from) && !ctx.from.is_bot && isGroup(ctx);
}

export default function createBot(database, token, options) {
  const telegraf = new Telegraf(token, options);

  const achievements = database.collection("achievements");
  const statistics = database.collection("statistics");
  const messages = database.collection("messages");
  const chats = database.collection("chats");
  const rewards = database.collection("rewards");
  const grants = database.collection("grants");
  const users = database.collection("users");

  // ---- Jetton rewards ----
  // A chat rewards its members with jetton points once the creator has set a
  // jetton master (/jetton). The miniapp converts points into claimable
  // jetton amounts; the bot only accrues points.

  // Emoji as Telegram sends them in ReactionTypeEmoji, without U+FE0F. Paid
  // (⭐) and custom emoji reactions are other reaction types and never count.
  const POSITIVE_REACTIONS = new Set([
    "👍", "❤", "🔥", "❤‍🔥", "🎉", "😍", "🥰", "👏", "💯", "🤩", "😁", "🤣", "🙏", "🤝", "🏆",
    "👌", "⚡", "🫡", "😎", "🤗", "😇", "💘", "🍾", "🆒",
  ]);
  const CREATOR_MULTIPLIER = Number(process.env.CREATOR_MULTIPLIER || 10);
  const CHAT_CONFIG_TTL_MS = 5 * 60 * 1000;

  // chat_id -> {value, expiresAt}; delete a chat's entry after changing its
  // jetton, creator or language
  const chatConfigCache = new Map();

  async function getChatConfig(chat_id) {
    const cached = chatConfigCache.get(chat_id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const chat = await chats.findOne({id: chat_id});
    const value = {
      jetton_master: chat?.jetton_master || null,
      creator: chat?.creator ?? null,
      lang: LANGUAGES.includes(chat?.lang) ? chat.lang : null,
      trial_started_at: chat?.trial_started_at ?? null,
      paid_until: chat?.paid_until ?? null,
    };
    chatConfigCache.set(chat_id, {value, expiresAt: Date.now() + CHAT_CONFIG_TTL_MS});
    return value;
  }

  // ---- Subscription gate (subscription.mjs) ----
  // Whether the chat accrues points now. A chat with a reward jetton and no
  // trial yet starts its trial here: chats that set their jetton before
  // subscriptions were switched on get the full trial from that moment.
  async function chatService(chat_id, now = new Date()) {
    const config = await getChatConfig(chat_id);
    if (subscriptionConfig().enabled && config.jetton_master && !config.trial_started_at && !config.paid_until) {
      await startTrial(chat_id, now);
      chatConfigCache.delete(chat_id);
      return serviceState(await getChatConfig(chat_id), now);
    }
    return serviceState(config, now);
  }

  // Never restarts a trial: only a chat without one gets it.
  function startTrial(chat_id, now = new Date()) {
    if (!subscriptionConfig().enabled) return Promise.resolve();
    return chats.updateOne({id: chat_id, trial_started_at: null}, {$set: {trial_started_at: now}});
  }

  // ---- Languages ----
  // In a private chat the bot answers in the user's Telegram app language. A
  // group or channel reads one language, set by the creator or an admin with
  // /lang; until then each reply follows whoever triggered it (the member who
  // wrote, reacted or added the bot). Posts on behalf of a channel and
  // anonymous admins carry no language_code: English, unless the chat has one.
  async function langFor(ctx) {
    const userLang = langFromCode(ctx.from?.language_code);
    if (!ctx.chat || ctx.chat.type === "private") return userLang;
    // a reply in the wrong language beats no reply
    const config = await getChatConfig(ctx.chat.id).catch(error => {
      console.error("chat language lookup failed:", error);
      return null;
    });
    return config?.lang || userLang;
  }

  // ---- Anti-farming ----
  // Reactions are cheap to fake with throwaway accounts, so a reaction only
  // earns points when:
  //   - the reactor has written at least MIN_REACTOR_MESSAGES messages in the
  //     chat (fresh sock puppets earn nothing);
  //   - the reactor has not already given this receiver PAIR_DAILY_CAP
  //     rewarded reactions today (one friend cannot pump one account);
  //   - the receiver has not already earned RECEIVER_DAILY_CAP reaction
  //     points today in this chat (bounds any ring of puppets).
  // Every rewarded reaction is recorded, and a removal takes back exactly
  // what that reaction paid, so add/remove toggling can never mint points.
  const MIN_REACTOR_MESSAGES = Number(process.env.MIN_REACTOR_MESSAGES ?? 5);
  const PAIR_DAILY_CAP = Number(process.env.PAIR_DAILY_CAP ?? 5);
  const RECEIVER_DAILY_CAP = Number(process.env.RECEIVER_DAILY_CAP ?? 200);

  const reactionPoints = database.collection("reaction_points");
  const reactionBudget = database.collection("reaction_budget");
  reactionPoints
    .createIndex({chat_id: 1, message_id: 1, reactor_id: 1, emoji: 1}, {unique: true})
    .catch(console.error);
  // The mini app sums points younger than the chat's maturation period
  // (claim rules) per receiver; these keep that query indexed.
  reactionPoints.createIndex({chat_id: 1, receiver_id: 1, date: 1}).catch(console.error);
  grants.createIndex({chat_id: 1, user_id: 1, date: 1}).catch(console.error);
  // who wrote a reacted message, and how many messages a reactor has written
  messages.createIndex({chat_id: 1, message_id: 1}).catch(console.error);
  messages.createIndex({chat_id: 1, user_id: 1}).catch(console.error);
  // active members over the last 30 days: the mini app prices the subscription by them
  messages.createIndex({chat_id: 1, date: 1}).catch(console.error);
  // budgets only matter for the day they count
  reactionBudget.createIndex({created_at: 1}, {expireAfterSeconds: 3 * 86400}).catch(console.error);

  function utcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  // Atomically takes `amount` from a daily budget; false once it is used up.
  async function takeBudget(id, amount, cap) {
    try {
      await reactionBudget.updateOne(
        {_id: id, used: {$lte: cap - amount}},
        {$inc: {used: amount}, $setOnInsert: {created_at: new Date()}},
        {upsert: true},
      );
      return true;
    } catch (error) {
      if (error?.code === 11000) return false; // doc exists and is over the cap
      throw error;
    }
  }

  // Undoes a takeBudget whose reaction ended up unpaid.
  function returnBudget(id, amount) {
    return reactionBudget.updateOne({_id: id}, {$inc: {used: -amount}});
  }

  // Positive reactions on a member's message become points. Points for the
  // chat creator's messages are multiplied (CREATOR_MULTIPLIER) so a creator's
  // activity funds the pool faster. Self-reactions never count.
  // Every positive reaction logs its outcome: either the points it moved or
  // why it moved none, so "I reacted and nothing happened" is one log line.
  async function accrueReactionRewards(ctx, reactionsToAdd, reactionsToRemove, receiver) {
    const positiveAdd = reactionsToAdd.filter(reaction => POSITIVE_REACTIONS.has(normalizeEmoji(reaction)));
    const positiveRemove = reactionsToRemove.filter(reaction => POSITIVE_REACTIONS.has(normalizeEmoji(reaction)));
    const chat_id = ctx.chat.id;
    const reactor_id = ctx.from.id;
    const noReward = reason =>
      console.log(`no reward: ${reason} (chat ${chat_id}, message ${receiver?.message_id}, from ${reactor_id})`);

    if (positiveAdd.length === 0 && positiveRemove.length === 0) {
      if (reactionsToAdd.length > 0) noReward(`not a positive reaction: ${reactionsToAdd.join(" ")}`);
      return;
    }
    if (!receiver) return;
    if (receiver.user_id === reactor_id) {
      noReward("self-reaction");
      return;
    }

    const key = {chat_id, message_id: receiver.message_id, reactor_id};
    let delta = 0;

    // Removals first: only reactions that were actually paid are taken back.
    for (const emoji of positiveRemove) {
      const paid = await reactionPoints.findOneAndDelete({...key, emoji: normalizeEmoji(emoji)});
      const record = paid?.value !== undefined ? paid.value : paid; // driver v4 vs v5 result shape
      if (record?.points) delta -= record.points;
    }
    if (positiveRemove.length > 0 && delta === 0) noReward(`removed ${positiveRemove.join(" ")} had not been paid`);

    if (positiveAdd.length > 0) {
      const config = await getChatConfig(chat_id);
      // any message type counts: a member who only posts stickers or voice
      // messages is as real as one who types
      const written = config.jetton_master
        ? await messages.countDocuments({chat_id, user_id: reactor_id}, {limit: MIN_REACTOR_MESSAGES})
        : 0;
      const service = config.jetton_master ? await chatService(chat_id) : null;
      if (!config.jetton_master) {
        noReward("no reward jetton in this chat, the creator runs /jetton <master address>");
      } else if (!service.accrues) {
        noReward(`subscription ${service.state}, points are paused`);
      } else if (written < MIN_REACTOR_MESSAGES) {
        noReward(`reactor has ${written}/${MIN_REACTOR_MESSAGES} messages in the chat`);
      } else {
        const isCreatorMessage = config.creator !== null && receiver.user_id === config.creator;
        const points = isCreatorMessage ? CREATOR_MULTIPLIER : 1;
        const day = utcDay();
        const pairBudget = `pair:${chat_id}:${reactor_id}:${receiver.user_id}:${day}`;
        const receiverBudget = `recv:${chat_id}:${receiver.user_id}:${day}`;
        // Both budgets are taken before paying; a reaction that ends up unpaid
        // gives back what it took, so a cap on one side never eats the other.
        for (const emoji of positiveAdd) {
          if (!(await takeBudget(pairBudget, 1, PAIR_DAILY_CAP))) {
            noReward(`daily cap: ${PAIR_DAILY_CAP} paid reactions from this reactor to ${receiver.user_id} today`);
            break;
          }
          if (!(await takeBudget(receiverBudget, points, RECEIVER_DAILY_CAP))) {
            await returnBudget(pairBudget, 1);
            noReward(`daily cap: ${receiver.user_id} earned ${RECEIVER_DAILY_CAP} reaction points today`);
            break;
          }
          try {
            await reactionPoints.insertOne({...key, emoji: normalizeEmoji(emoji), receiver_id: receiver.user_id, points, date: new Date()});
            delta += points;
          } catch (error) {
            if (error?.code !== 11000) throw error;
            await returnBudget(pairBudget, 1);
            await returnBudget(receiverBudget, points);
            noReward(`${emoji} already paid (redelivered update)`);
          }
        }
      }
    }

    if (delta === 0) return;
    const query = {chat_id, user_id: receiver.user_id};
    if (delta > 0) {
      await rewards.updateOne(query, {$inc: {points: delta}}, {upsert: true});
    } else {
      await rewards.updateOne(query, {$inc: {points: delta}});
    }
    console.log(`reward ${delta > 0 ? "+" : ""}${delta} points to ${receiver.user_id} in chat ${chat_id} from ${reactor_id}`);
  }

  function isTonAddress(value) {
    return (
      /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(value) ||
      /^-?[0-9]:[0-9a-fA-F]{64}$/.test(value)
    );
  }

  // ---- Known users ----
  // Telegram's Bot API cannot look a user up by @username, so the bot keeps
  // the usernames of the people it sees (messages, reactions, commands) to
  // resolve `/reward @username`. A username belongs to one account at a time:
  // whoever had it before is cleared when someone else shows up with it.
  // It also keeps the language of each user's Telegram app (`lang`, the last
  // language_code seen), for the private messages it sends them.
  const USER_REFRESH_MS = 24 * 60 * 60 * 1000;
  const MAX_CACHED_USERS = 50000;
  // user id -> {key, at}: skips the write while name and username are unchanged
  const seenUsers = new Map();

  users.createIndex({id: 1}, {unique: true}).catch(console.error);
  users.createIndex({username: 1}).catch(console.error);

  async function rememberUser(user) {
    const username = user.username ? user.username.toLowerCase() : null;
    // some updates carry no language_code: keep the one seen before
    const lang = user.language_code ? langFromCode(user.language_code) : null;
    const key = `${username}|${user.first_name || ""}|${lang}`;
    const cached = seenUsers.get(user.id);
    if (cached?.key === key && Date.now() - cached.at < USER_REFRESH_MS) return;

    const fields = {username, first_name: user.first_name || null, updated_at: new Date()};
    if (lang) fields.lang = lang;
    await users.updateOne({id: user.id}, {$set: fields}, {upsert: true});
    if (username && cached?.key !== key) {
      await users.updateMany({username, id: {$ne: user.id}}, {$set: {username: null}});
    }
    if (seenUsers.size >= MAX_CACHED_USERS) seenUsers.clear();
    seenUsers.set(user.id, {key, at: Date.now()});
  }

  // The member of this chat who goes by `@username` (any case), or why not.
  const MEMBER_STATUSES = new Set(["creator", "administrator", "member", "restricted"]);
  async function findMemberByUsername(ctx, username) {
    const known = await users.findOne({username: username.toLowerCase()});
    if (!known) return {error: "rewardUnknownUsername"};
    const member = await ctx.telegram.getChatMember(ctx.chat.id, known.id).catch(() => null);
    if (!member?.user || !MEMBER_STATUSES.has(member.status) || member.is_member === false) {
      return {error: "rewardCannotResolve"};
    }
    return {user: member.user};
  }

  // ---- Manual grants ----
  // Points also appear without a reaction: an admin (a human or another bot
  // with Bot-to-Bot Communication Mode, e.g. a channel publisher that knows who
  // submitted a meme) awards them for an action. Every grant leaves an audit
  // document, because that is the only way to explain a disputed reward later.
  const ADMIN_STATUSES = new Set(["creator", "administrator"]);
  const MAX_GRANT_POINTS = Number(process.env.REWARD_MAX_POINTS || 1000);

  // One grant per Telegram message: polling can redeliver an update after a
  // restart, and a bot-to-bot loop must not be able to mint points twice.
  grants
    .createIndex(
      {chat_id: 1, source_message_id: 1},
      {unique: true, partialFilterExpression: {source_message_id: {$type: "number"}}},
    )
    .catch(console.error);

  async function applyGrant(grant) {
    const doc = {
      chat_id: grant.chat_id,
      user_id: grant.user_id,
      points: grant.points,
      reason: grant.reason || null,
      source: grant.source,
      granted_by: grant.granted_by,
      source_message_id: grant.source_message_id ?? null,
      date: Date.now(),
    };

    try {
      const {insertedId} = await grants.insertOne(doc);
      doc._id = insertedId;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return {grant: null, duplicate: true};
    }

    await rewards.updateOne(
      {chat_id: doc.chat_id, user_id: doc.user_id},
      {$inc: {points: doc.points}},
      {upsert: true},
    );
    return {grant: doc, duplicate: false};
  }

  // Channels and anonymous admin posts hide the author, so there is nobody whose
  // admin rights could be checked. `deniedKey` is the reply for a non-admin.
  async function requireAdmin(ctx, lang, deniedKey) {
    const member = ctx.from ? await ctx.getChatMember(ctx.from.id).catch(() => null) : null;
    if (!member) return {ok: false, error: t(lang, "cannotSeeSender")};
    if (!ADMIN_STATUSES.has(member.status)) return {ok: false, error: t(lang, deniedKey)};
    return {ok: true, member};
  }

  async function handleReward(ctx) {
    const lang = await ctx.state.lang();
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      await ctx.reply(t(lang, "rewardWhere"));
      return;
    }

    const granter = await requireAdmin(ctx, lang, "rewardAdminsOnly");
    if (!granter.ok) {
      await ctx.reply(granter.error);
      return;
    }

    const config = await getChatConfig(ctx.chat.id);
    if (!config.jetton_master) {
      await ctx.reply(t(lang, "rewardNoJetton"));
      return;
    }
    if (!(await chatService(ctx.chat.id)).accrues) {
      await ctx.reply(t(lang, "subscriptionInactive"));
      return;
    }

    const msg = ctx.message || ctx.channelPost;
    const text = msg.text || "";
    const tokens = text.split(/\s+/).slice(1).filter(Boolean);
    const replyTo = msg.reply_to_message;
    // A mention of a member without a username arrives as a text_mention
    // entity that carries the user; its text is their name, spaces and all.
    const firstArg = text.match(/^\S*\s*/)[0].length;
    const textMention = msg.entities?.find(e => e.type === "text_mention" && e.offset === firstArg && e.user);

    let target = null;
    let args = tokens;

    if (replyTo) {
      if (!replyTo.from || replyTo.from.is_bot) {
        await ctx.reply(t(lang, "rewardNoAuthor"));
        return;
      }
      target = {id: replyTo.from.id, name: replyTo.from.first_name || replyTo.from.username || String(replyTo.from.id)};
    } else if (textMention) {
      target = {id: textMention.user.id, name: textMention.user.first_name || String(textMention.user.id)};
      args = text.slice(textMention.offset + textMention.length).split(/\s+/).filter(Boolean);
    } else {
      const first = tokens[0];
      args = tokens.slice(1);
      if (first?.startsWith("@")) {
        const found = await findMemberByUsername(ctx, first.slice(1));
        if (found.error) {
          await ctx.reply(t(lang, found.error, first));
          return;
        }
        target = {id: found.user.id, name: found.user.first_name || first.slice(1)};
      } else if (/^\d+$/.test(first || "")) {
        target = {id: Number(first), name: first};
      }
    }

    const points = Number(args[0]);
    if (!target || !Number.isInteger(points) || points < 1 || points > MAX_GRANT_POINTS) {
      await ctx.reply(t(lang, "rewardUsage", MAX_GRANT_POINTS));
      return;
    }

    // channels are not auto-registered by the message handler
    await chats.updateOne(
      {id: ctx.chat.id},
      {$setOnInsert: {id: ctx.chat.id, title: ctx.chat.title || null}},
      {upsert: true},
    );

    const {grant, duplicate} = await applyGrant({
      chat_id: ctx.chat.id,
      user_id: target.id,
      points,
      reason: args.slice(1).join(" ").slice(0, 200) || null,
      source: ctx.from.is_bot ? "bot-command" : "admin-command",
      granted_by: ctx.from.id,
      source_message_id: msg.message_id,
    });

    if (duplicate) return; // same message already granted, stay silent

    console.log(
      `grant ${grant.points} points to ${grant.user_id} in chat ${grant.chat_id} by ${grant.granted_by}` +
        (ctx.from.is_bot ? " (bot)" : "") +
        (grant.reason ? `: ${grant.reason}` : ""),
    );

    await ctx.reply(t(lang, "rewardGranted", grant.points, target.name, grant.reason), {
      reply_to_message_id: replyTo?.message_id,
    });
  }

  async function handleJetton(ctx) {
    const lang = await ctx.state.lang();
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      await ctx.reply(t(lang, "jettonWhere"));
      return;
    }

    const member = ctx.from ? await ctx.getChatMember(ctx.from.id).catch(() => null) : null;
    if (member?.status !== "creator") {
      await ctx.reply(t(lang, ctx.from ? "jettonCreatorOnly" : "jettonCannotSeeSender"));
      return;
    }

    const arg = ((ctx.message || ctx.channelPost).text || "").split(/\s+/)[1];
    if (!arg) {
      const chat = await chats.findOne({id: ctx.chat.id});
      await ctx.reply(chat?.jetton_master ? t(lang, "jettonCurrent", chat.jetton_master) : t(lang, "jettonNotSet"));
      return;
    }

    if (!isTonAddress(arg)) {
      await ctx.reply(t(lang, "jettonInvalid"));
      return;
    }

    await handOverSubscription(ctx.chat.id, ctx.from.id);
    await chats.updateOne(
      {id: ctx.chat.id},
      {$set: {jetton_master: arg, creator: ctx.from.id, title: ctx.chat.title}},
      {upsert: true},
    );
    // points start here, and so does the free trial
    await startTrial(ctx.chat.id);
    chatConfigCache.delete(ctx.chat.id);

    await ctx.reply(t(lang, "jettonSet", arg));
  }

  // /lang shows the chat's language, /lang ru|en changes it (creator and
  // admins), /lang auto removes it: each reply then follows whoever triggered
  // it. The reply to a change is already in the new language. A channel post
  // hides its author, but only the channel's admins can post there, so it may
  // change the language (not so for /reward, which records who granted).
  async function handleLang(ctx) {
    const lang = await ctx.state.lang();
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      await ctx.reply(t(lang, "langPrivate"));
      return;
    }

    const arg = ((ctx.message || ctx.channelPost).text || "").split(/\s+/)[1]?.toLowerCase();
    if (!arg) {
      const config = await getChatConfig(ctx.chat.id);
      const current = config.lang ? t(lang, "langCurrent", t(config.lang, "languageName")) : t(lang, "langNotSet");
      await ctx.reply(`${current}\n${t(lang, "langUsage")}`);
      return;
    }

    if (!ctx.channelPost) {
      const admin = await requireAdmin(ctx, lang, "langAdminsOnly");
      if (!admin.ok) {
        await ctx.reply(admin.error);
        return;
      }
    }

    if (arg !== "auto" && !LANGUAGES.includes(arg)) {
      await ctx.reply(t(lang, "langUnknown", arg.slice(0, 20)));
      return;
    }

    if (arg === "auto") {
      await chats.updateOne({id: ctx.chat.id}, {$unset: {lang: ""}});
    } else {
      await chats.updateOne(
        {id: ctx.chat.id},
        {$set: {lang: arg}, $setOnInsert: {title: ctx.chat.title || null}},
        {upsert: true},
      );
    }
    chatConfigCache.delete(ctx.chat.id);
    console.log(`chat ${ctx.chat.id} language set to ${arg} by ${ctx.from?.id ?? "a channel post"}`);

    if (arg === "auto") {
      await ctx.reply(t(langFromCode(ctx.from?.language_code), "langAuto"));
      return;
    }
    await ctx.reply(t(arg, "langSet", t(arg, "languageName")));
  }

  // ---- /start and /help ----
  // A private chat gets a short introduction with buttons. The mini app button
  // is a plain link to its t.me address rather than a `web_app` button: a
  // web_app button needs the app's own HTTPS address, which lives in the mini
  // app's BotFather settings, and the t.me link opens the same app the same
  // way everywhere else the bot links to it.
  //
  // In a group the bot stays brief. Telegram's "Add to group" flow sends
  // `/start@achivator_bot true` right after the bot joins, when it has just
  // greeted the group (my_chat_member), so a setup hint then would repeat the
  // greeting; for a group where the bot is already an admin the automatic
  // /start needs no answer at all. A member who types /start or /help gets one
  // line: the setup hint, or where the guide is.
  const GREETING_QUIET_MS = 60 * 1000;
  const greetedAt = new Map(); // chat_id -> ms of the last greeting

  function rememberGreeting(chat_id) {
    const now = Date.now();
    for (const [id, at] of greetedAt) if (now - at > GREETING_QUIET_MS) greetedAt.delete(id);
    greetedAt.set(chat_id, now);
  }

  async function handleStart(ctx) {
    const lang = await ctx.state.lang();
    if (ctx.chat?.type === "private") {
      // the user can be written to again (see the private messages queue)
      await dms.clearBlocked(ctx.from.id).catch(error => console.error("clearing dm_blocked_at failed:", error));
      // a /start payload from a deep link carries nothing the bot acts on yet
      await ctx.reply(t(lang, "welcome"), {
        reply_markup: {
          inline_keyboard: [
            [{text: t(lang, "buttonOpenApp"), url: MINI_APP_URL}],
            [{text: t(lang, "buttonAddToGroup"), url: ADD_TO_GROUP_URL}],
            [{text: t(lang, "buttonSetupGuide"), url: t(lang, "setupGuideUrl")}],
          ],
        },
      });
      return;
    }
    if (!isGroup(ctx)) return;

    const noPreview = {link_preview_options: {is_disabled: true}};
    const me = await ctx.getChatMember(ctx.botInfo.id).catch(() => null);
    if (me?.status === "administrator") {
      if (ctx.command === "start" && ctx.payload) return; // automatic, from "Add to group"
      await ctx.reply(t(lang, "startGroupReady", t(lang, "setupGuideUrl")), noPreview);
      return;
    }
    if (Date.now() - (greetedAt.get(ctx.chat.id) ?? 0) < GREETING_QUIET_MS) return;
    await ctx.reply(t(lang, "startGroupSetup", t(lang, "setupGuideUrl")), noPreview);
  }

  // Command menus: English by default, Russian for Russian Telegram apps; a
  // private chat lists /start and /help, groups list the chat commands. Runs
  // once per bot start; a failure only leaves the old menu in place.
  for (const lang of LANGUAGES) {
    // "reward" is described by the "commandReward" text
    const describe = command => ({
      command,
      description: t(lang, `command${command[0].toUpperCase()}${command.slice(1)}`),
    });
    const chatCommands = ["verify", "jetton", "reward", "lang"].map(describe);
    const menus = [
      [chatCommands, {type: "default"}],
      [["start", "help"].map(describe), {type: "all_private_chats"}],
      [[...chatCommands, describe("help")], {type: "all_group_chats"}],
    ];
    for (const [commands, scope] of menus) {
      const extra = lang === "en" ? {scope} : {scope, language_code: lang};
      telegraf.telegram.setMyCommands(commands, extra).catch(console.error);
    }
  }

  // Every reply of an update goes out in one language, resolved on first use:
  // `await ctx.state.lang()`.
  telegraf.use((ctx, next) => {
    let lang;
    ctx.state.lang = () => (lang ??= langFor(ctx));
    return next();
  });

  // Bots (including anonymous admins and channel posts) have no username to
  // reward by. A failed write only costs a later `/reward @username`.
  telegraf.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await rememberUser(ctx.from).catch(error => console.error("remembering user failed:", error));
    }
    return next();
  });

  telegraf.command("reward", handleReward);
  telegraf.command("lang", handleLang);
  telegraf.command(["start", "help"], handleStart);

  // A channel post is not a `message`, so Telegraf's command middleware never
  // sees commands typed inside a channel; dispatch them here.
  telegraf.on(channelPost("text"), async (ctx, next) => {
    const match = (ctx.channelPost.text || "").match(/^\/(\w+)(?:@(\w+))?/);
    if (!match) return next();
    const me = ctx.me || (await ctx.telegram.getMe().catch(() => null))?.username;
    if (match[2] && match[2].toLowerCase() !== String(me).toLowerCase()) return next();
    if (match[1] === "reward") return handleReward(ctx);
    if (match[1] === "jetton") return handleJetton(ctx);
    if (match[1] === "lang") return handleLang(ctx);
    return next();
  });

  telegraf.use(session());

  telegraf.command("migrate", async ctx => {
    if (ctx.from.id !== 246513585) return;

    // Migrate all achievements from statistics to the new collection achievements
    const cursor = statistics.find({chat: {$exists: true}});
    while (await cursor.hasNext()) {
      const item = await cursor.next();
      if (item.chat) {
        await database.collection("chats").insertOne(item.chat, {upsert: true});
      }
    }
    await ctx.reply(t(await ctx.state.lang(), "migrationCompleted"));
  });

  telegraf.command("verify", async ctx => {
    const lang = await ctx.state.lang();
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup") {
      await ctx.reply(t(lang, "verifyWhere"));
      return;
    }
    const member = await ctx.getChatMember(ctx.from.id).catch(() => null);
    if (!member) {
      await ctx.reply(t(lang, "verifyCannotCheck"));
      return;
    }
    if (member.status !== "creator") {
      await ctx.reply(t(lang, "verifyNotCreator", t(lang, "memberStatus", member.status)));
      return;
    }
    await handOverSubscription(ctx.chat.id, member.user.id);
    await chats.updateOne({id: ctx.chat.id}, {$set: {creator: member.user.id}}, {upsert: true});
    chatConfigCache.delete(ctx.chat.id);
    await ctx.reply(t(lang, "verified", t(lang, "memberStatus", member.status)));
  });

  telegraf.command("jetton", handleJetton);

  telegraf.on("my_chat_member", async (ctx, next) => {
    console.log("my_chat_member", ctx.update);

    const status = ctx.update.my_chat_member.new_chat_member?.status;

    // if bot was added to a new chat, announce itself and suggest granting admin rights so that it could read messages.
    // Until the chat has a language, it greets in the language of whoever added it.
    // In a private chat "member" means the user unblocked the bot: nothing to say.
    if (status === "member" && isGroup(ctx)) {
      rememberGreeting(ctx.chat.id);
      await ctx.reply(t(await ctx.state.lang(), "greeting"));
    }

    // In a private chat "member" means the user started or unblocked the bot
    // and "kicked" that they blocked it: whether private messages reach them.
    if (ctx.chat?.type === "private" && ctx.from) {
      const logFailure = error => console.error("updating dm_blocked_at failed:", error);
      if (status === "member") await dms.clearBlocked(ctx.from.id).catch(logFailure);
      if (status === "kicked") await dms.markBlocked(ctx.from.id).catch(logFailure);
    }

    // Check if the bot was granted admin rights
    if (status === "administrator") {
      await ctx.reply(t(await ctx.state.lang(), "adminThanks"));
    }

    next();
  });

  // Counter -> achievement, for reactions given by the reactor and received by
  // the author of the reacted message.
  const GIVEN_REACTION_ACHIEVEMENTS = {"🤡": "sad clown", "❤": "spread the love", "👍": "likes for everyone", "🔥": "fire starter", "💩": "poop master"};
  const RECEIVED_REACTION_ACHIEVEMENTS = {"👍": "liked", "🔥": "on fire", "❤": "loved", "🤡": "clown", "💩": "poop"};
  const REACTION_ACHIEVEMENT_THRESHOLD = 100;

  async function countReactions(chat_id, user_id, field, added, removed) {
    const inc = {};
    for (const emoji of added) inc[`${field}.${emoji}`] = (inc[`${field}.${emoji}`] || 0) + 1;
    for (const emoji of removed) inc[`${field}.${emoji}`] = (inc[`${field}.${emoji}`] || 0) - 1;
    if (field === "reactionsGiven") inc.reactions = added.length - removed.length;
    const result = await statistics.findOneAndUpdate(
      {chat_id, user_id},
      {$inc: inc},
      {upsert: true, returnDocument: "after"},
    );
    return unwrapModifyResult(result);
  }

  // Reactions need the bot to be a chat admin and "message_reaction" in
  // allowed_updates (standalone.mjs); Telegram sends neither by default.
  telegraf.on("message_reaction", async (ctx, next) => {
    console.log(ctx.update, ctx.from);
    // Anonymous reactions (channels, anonymous admins) come without a user and
    // only as message_reaction_count: there is nobody to credit or charge.
    if (!ctx.from) return next();

    // We only care about native emoji reactions
    const emojiOf = reactions =>
      reactions.filter(reaction => reaction.type === "emoji").map(reaction => normalizeEmoji(reaction.emoji));
    const newReactions = emojiOf(ctx.messageReaction.new_reaction);
    const oldReactions = emojiOf(ctx.messageReaction.old_reaction);

    const reactionsToAdd = newReactions.filter(reaction => !oldReactions.includes(reaction));
    const reactionsToRemove = oldReactions.filter(reaction => !newReactions.includes(reaction));
    if (reactionsToAdd.length === 0 && reactionsToRemove.length === 0) return next();

    console.log({reactionsToAdd, reactionsToRemove});

    const chat_id = ctx.chat.id;
    const message_id = ctx.messageReaction.message_id;

    // keep separate reactions count for each chat
    const reactor = await countReactions(chat_id, ctx.from.id, "reactionsGiven", reactionsToAdd, reactionsToRemove);

    if (crossed(reactor?.reactions, reactionsToAdd.length, REACTION_ACHIEVEMENT_THRESHOLD)) {
      giveAchievement(ctx, achievements, "reactive", {message_id});
    }
    for (const emoji of reactionsToAdd) {
      const achievement = GIVEN_REACTION_ACHIEVEMENTS[emoji];
      if (achievement && reactor?.reactionsGiven?.[emoji] === REACTION_ACHIEVEMENT_THRESHOLD) {
        giveAchievement(ctx, achievements, achievement, {message_id});
      }
    }

    const receiver = await messages.findOne({chat_id, message_id});
    console.log({chat_id, message_id, receiver});
    if (!receiver) {
      // written before the bot recorded it (before it was an admin, while it
      // was down, a non-text message before rewards shipped), by a bot, or on
      // behalf of a channel: Telegram does not say who wrote it
      if (reactionsToAdd.some(emoji => POSITIVE_REACTIONS.has(emoji))) {
        console.log(`no reward: unknown author of message ${message_id} (chat ${chat_id}, from ${ctx.from.id})`);
      }
      return next();
    }

    const author = await countReactions(chat_id, receiver.user_id, "reactionsReceived", reactionsToAdd, reactionsToRemove);

    // Received-reaction achievements belong to the author of the message, not
    // to whoever happened to react. Self-reactions do not count.
    if (receiver.user_id !== ctx.from.id) {
      let authorUser = null;
      for (const emoji of reactionsToAdd) {
        const achievement = RECEIVED_REACTION_ACHIEVEMENTS[emoji];
        if (achievement && author?.reactionsReceived?.[emoji] === REACTION_ACHIEVEMENT_THRESHOLD) {
          authorUser ??= await ctx
            .getChatMember(receiver.user_id)
            .then(member => member.user)
            .catch(() => ({id: receiver.user_id})); // mentionUser names them "member"
          giveAchievement(ctx, achievements, achievement, {user: authorUser, message_id});
        }
      }
    }

    await accrueReactionRewards(ctx, reactionsToAdd, reactionsToRemove, receiver);

    return next();
  });

  telegraf.on("message_reaction_count", async (ctx, next) => {
    // represents reaction changes on a message with anonymous reactions.

    console.log("message_reaction_count", ctx.update);

    next();
  });

  // Content types a member writes; service messages (joins, pins, topic edits)
  // are not something anyone reacts to or should count as activity.
  const CONTENT_TYPES = [
    "text", "photo", "video", "animation", "sticker", "voice", "video_note", "audio", "document",
    "poll", "dice", "location", "venue", "contact", "story", "paid_media",
  ];

  // Every member message is recorded, whatever its type: a reaction can only
  // be paid when the bot knows who wrote the message, and memes, stickers and
  // voice messages collect reactions just like text.
  telegraf.on("message", async (ctx, next) => {
    if (!isMemberMessage(ctx) || !CONTENT_TYPES.some(type => type in ctx.message)) return next();

    // upsert: a redelivered update must not record the message twice
    await messages.updateOne(
      {chat_id: ctx.chat.id, message_id: ctx.message.message_id},
      {$setOnInsert: {user_id: ctx.from.id, date: ctx.message.date}},
      {upsert: true},
    );
    // keep track of all chats
    await chats.updateOne(
      {id: ctx.chat.id},
      {$setOnInsert: {id: ctx.chat.id, title: ctx.chat.title}},
      {upsert: true},
    );

    return next();
  });

  telegraf.on(message("video_note"), async (ctx, next) => {
    if (!isMemberMessage(ctx)) return next();
    await incrementStat(statistics, ctx.chat.id, ctx.from.id, "video_note");
    giveAchievement(ctx, achievements, "telescope");

    return next();
  });

  telegraf.on(message("voice"), async (ctx, next) => {
    if (!isMemberMessage(ctx)) return next();
    await incrementStat(statistics, ctx.chat.id, ctx.from.id, "voice");
    giveAchievement(ctx, achievements, "voicy");

    return next();
  });

  telegraf.on(message("sticker"), async (ctx, next) => {
    if (!isMemberMessage(ctx)) return next();
    await incrementStat(statistics, ctx.chat.id, ctx.from.id, "sticker");
    giveAchievement(ctx, achievements, "sticker");

    return next();
  });

  telegraf.on(message("text"), async (ctx, next) => {
    if (!isMemberMessage(ctx)) return next();

    // keep separate messages count for each chat; read back atomically so
    // concurrent messages cannot both (or neither) see the threshold
    const chatUser = await incrementStat(statistics, ctx.chat.id, ctx.from.id, "messages");

    if (chatUser?.messages === 100) {
      giveAchievement(ctx, achievements, "talkative");
    }
    if (chatUser?.messages === 10) {
      giveAchievement(ctx, achievements, "newbie");
    }

    // detect if user posted code snippet
    if (
      ctx.message.entities?.some(entity => entity.type === "code") ||
      ctx.message.entities?.some(entity => entity.type === "pre")
    ) {
      giveAchievement(ctx, achievements, "programmer");
    }

    // detect if user posted exactly at 00:00:00 from ctx.message.date
    const date = new Date(ctx.message.date * 1000);
    if (date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0) {
      giveAchievement(ctx, achievements, "night owl");
    }

    // give Santa achievement for posting excactly on Christmas eve
    if (date.getMonth() === 11 && date.getDate() === 24) {
      giveAchievement(ctx, achievements, "Santa");
    }

    if (ctx.message.text?.toLowerCase().match(/\!{3,}/)) {
      giveAchievement(ctx, achievements, "exclamator");
    }

    if (ctx.message.text?.toLowerCase().match(/\b9\d{3}\b/)) {
      giveAchievement(ctx, achievements, "over 9000");
    }

    next();
  });

  // ---- Subscription payments (Telegram Stars) ----
  // The mini app creates the invoice (payload "sub:<chat id>", a 30-day
  // Stars subscription); Telegram asks the bot to confirm it
  // (pre_checkout_query) and then reports each payment, renewals included,
  // as a successful_payment message in the payer's private chat. Every
  // payment is logged once in `payments`, keyed by its charge id.
  const payments = database.collection("payments");
  payments.createIndex({charge_id: 1}, {unique: true}).catch(console.error);
  payments.createIndex({chat_id: 1, at: 1}).catch(console.error);
  // chats with a reward jetton: the ones the hourly subscription pass reads
  chats.createIndex({jetton_master: 1}, {sparse: true}).catch(console.error);

  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const REMIND_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;

  async function userLang(user_id, fallback) {
    const doc = await users.findOne({id: user_id}).catch(() => null);
    return LANGUAGES.includes(doc?.lang) ? doc.lang : fallback;
  }

  // Best effort: the user may never have started the bot in private.
  async function notifyUser(user_id, key, params, fallbackLang = "en") {
    const lang = await userLang(user_id, fallbackLang);
    await telegraf.telegram
      .sendMessage(user_id, t(lang, key, params), {
        reply_markup: {inline_keyboard: [[{text: t(lang, "buttonOpenApp"), url: MINI_APP_URL}]]},
      })
      .catch(error => console.error(`${key} to ${user_id} failed:`, error?.message || error));
  }

  // The chat has a new creator: the previous payer's monthly renewal stops
  // (Telegram charges whoever subscribed), what they paid stays with the chat
  // until paid_until, and the new creator subscribes from their own account.
  async function handOverSubscription(chat_id, newCreator) {
    try {
      const chat = await chats.findOne({id: chat_id});
      const sub = chat?.subscription;
      if (!sub?.recurring || sub.payer_id === newCreator) return;
      await cancelRenewal(chat, "creator changed");
      await notifyUser(sub.payer_id, "subscriptionHandedOver", {title: chat.title, until: chat.paid_until}, await chatLang(chat_id));
    } catch (error) {
      console.error(`chat ${chat_id}: subscription handover failed:`, error);
    }
  }

  async function cancelRenewal(chat, reason) {
    const sub = chat.subscription;
    try {
      await telegraf.telegram.callApi("editUserStarSubscription", {
        user_id: sub.payer_id,
        telegram_payment_charge_id: sub.charge_id,
        is_canceled: true,
      });
    } catch (error) {
      console.error(`chat ${chat.id}: cancelling the renewal of ${sub.payer_id} failed:`, error?.message || error);
    }
    await chats.updateOne(
      {id: chat.id, "subscription.charge_id": sub.charge_id},
      {$set: {"subscription.recurring": false, "subscription.cancelled_at": new Date(), "subscription.cancel_reason": reason}},
    );
    console.log(`chat ${chat.id}: renewal by ${sub.payer_id} cancelled (${reason})`);
  }

  telegraf.on("pre_checkout_query", async ctx => {
    const query = ctx.preCheckoutQuery;
    const lang = await ctx.state.lang();
    const chat_id = parseSubscriptionPayload(query.invoice_payload);
    if (chat_id === null || query.currency !== "XTR") {
      await ctx.answerPreCheckoutQuery(false, t(lang, "subscriptionPayFailed"));
      return;
    }
    const chat = await chats.findOne({id: chat_id});
    // the stored creator can be stale (ownership transfer): ask Telegram
    const member = chat?.creator === query.from.id
      ? await ctx.telegram.getChatMember(chat_id, query.from.id).catch(() => null)
      : null;
    if (!chat?.jetton_master || member?.status !== "creator") {
      console.log(`chat ${chat_id}: subscription payment by ${query.from.id} refused, not the creator`);
      await ctx.answerPreCheckoutQuery(false, t(lang, "subscriptionNotCreator"));
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  telegraf.on(message("successful_payment"), async ctx => {
    const payment = ctx.message.successful_payment;
    const chat_id = parseSubscriptionPayload(payment.invoice_payload);
    if (chat_id === null) return;
    const now = new Date();
    const expires = payment.subscription_expiration_date
      ? new Date(payment.subscription_expiration_date * 1000)
      : new Date(now.getTime() + MONTH_MS);
    const record = {
      charge_id: payment.telegram_payment_charge_id,
      chat_id,
      payer_id: ctx.from.id,
      stars: payment.total_amount,
      currency: payment.currency,
      recurring: Boolean(payment.is_recurring),
      first_recurring: Boolean(payment.is_first_recurring),
      expires_at: expires,
      at: now,
    };
    try {
      await payments.insertOne(record);
    } catch (error) {
      if (error?.code === 11000) return; // redelivered update, already recorded
      throw error;
    }

    const chat = await chats.findOne({id: chat_id});
    const previous = chat?.subscription;
    // a renewal keeps the subscription's first charge id: the one Telegram
    // knows the subscription by when the bot cancels it
    const sameSubscription =
      previous && previous.payer_id === record.payer_id && previous.recurring && !record.first_recurring;
    if (previous?.recurring && previous.payer_id !== record.payer_id) await cancelRenewal(chat, "another payer subscribed");
    const paidUntil = new Date(Math.max(expires.getTime(), new Date(chat?.paid_until ?? 0).getTime()));
    await chats.updateOne(
      {id: chat_id},
      {
        $set: {
          paid_until: paidUntil,
          subscription: {
            payer_id: record.payer_id,
            charge_id: sameSubscription ? previous.charge_id : record.charge_id,
            recurring: record.recurring,
            stars: record.stars,
            at: now,
          },
        },
      },
    );
    chatConfigCache.delete(chat_id);
    console.log(`chat ${chat_id}: ${record.stars} stars from ${record.payer_id}, paid until ${paidUntil.toISOString()}`);

    const lang = await ctx.state.lang();
    await ctx
      .reply(t(lang, "subscriptionPaid", {title: chat?.title, until: paidUntil, recurring: record.recurring}))
      .catch(console.error);
    if (chat?.sub_stop_announced_for) {
      await chats.updateOne({id: chat_id}, {$unset: {sub_stop_announced_for: ""}});
      await telegraf.telegram
        .sendMessage(chat_id, t(await chatLang(chat_id), "subscriptionResumed"))
        .catch(error => console.error(`chat ${chat_id}: resumed announcement failed:`, error?.message || error));
    }
  });

  // Hourly with the announcements: remind the creator three days before a
  // trial or a non-renewing subscription ends, and tell the chat once when
  // points stop, so nobody reacts for points in vain. Each notice is claimed
  // for the period end it is about, so it goes out once per period.
  async function runSubscriptions(now) {
    if (!subscriptionConfig().enabled) return 0;
    let notices = 0;
    const withJetton = await chats.find({jetton_master: {$ne: null}}).toArray();
    for (const chat of withJetton) {
      try {
        if (!chat.trial_started_at && !chat.paid_until) {
          await startTrial(chat.id, now);
          chatConfigCache.delete(chat.id);
          continue;
        }
        const service = serviceState(chat, now);
        if (!service.ends_at) continue;
        const period = service.ends_at.toISOString();
        const lang = await chatLang(chat.id);

        const renews = service.state === "paid" && chat.subscription?.recurring;
        const ending = (service.state === "trial" || service.state === "paid") && !renews &&
          service.ends_at.getTime() - now.getTime() <= REMIND_BEFORE_MS;
        if (ending && chat.creator && chat.sub_reminded_for !== period) {
          const claimed = unwrapModifyResult(
            await chats.findOneAndUpdate({id: chat.id, sub_reminded_for: {$ne: period}}, {$set: {sub_reminded_for: period}}),
          );
          if (claimed) {
            await notifyUser(chat.creator, "subscriptionEnding", {title: chat.title, until: service.ends_at, trial: service.state === "trial"}, lang);
            notices++;
          }
        }

        if (service.state === "expired" && chat.sub_stop_announced_for !== period) {
          const claimed = unwrapModifyResult(
            await chats.findOneAndUpdate({id: chat.id, sub_stop_announced_for: {$ne: period}}, {$set: {sub_stop_announced_for: period}}),
          );
          if (!claimed) continue;
          await telegraf.telegram
            .sendMessage(chat.id, t(lang, "subscriptionStopped"))
            .catch(error => console.error(`chat ${chat.id}: stop announcement failed:`, error?.message || error));
          if (chat.creator) await notifyUser(chat.creator, "subscriptionEndedCreator", {title: chat.title}, lang);
          console.log(`chat ${chat.id}: points paused, subscription ${service.state}`);
          notices++;
        }
      } catch (error) {
        console.error(`chat ${chat.id}: subscription pass failed:`, error);
      }
    }
    return notices;
  }

  // ---- Point price announcements ----
  // The chat creator changes the price of a point in the mini app. An increase
  // applies at once; a decrease is scheduled (chats.point_price_pending) so
  // members can still claim at the old price. The mini app queues what the
  // chat should hear in the `announcements` outbox:
  //   {chat_id, type, params, created_at, sent_at: null, claimed_at: null, attempts: 0}
  // with type "price_decrease_scheduled" {from, to, symbol, effective_at},
  // "price_decrease_cancelled" {from, to, symbol}, "price_increased"
  // {from, to, symbol, cancelled_pending} or "price_decreased" {from, to,
  // symbol}. The bot sends those, applies decreases that are due and
  // announces them itself; the mini app queues "price_decreased" only when it
  // applied a due decrease before the bot did (a new price saved after
  // effective_at). Prices are decimal
  // strings; a chat without point_price uses the platform default, which the
  // bot does not know. The bot caches nothing price-related (getChatConfig),
  // so an applied decrease invalidates no cache.
  //
  // Every step claims its work atomically, so overlapping runs (a slow tick,
  // a second process) never send an announcement or apply a decrease twice.
  // Runs on a timer started by standalone.mjs: `bot.announcements.start()`.
  const announcements = database.collection("announcements");
  const ANNOUNCE_INTERVAL_MS =
    Number(process.env.ANNOUNCE_INTERVAL_MS) > 0 ? Number(process.env.ANNOUNCE_INTERVAL_MS) : 60 * 1000;
  const ANNOUNCE_MAX_ATTEMPTS = 5;
  // a claim this old belongs to a run that died between claiming and sending
  const ANNOUNCE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
  const ANNOUNCE_BATCH = 50;
  const PRICE_MESSAGES = {
    price_decrease_scheduled: "priceDecreaseScheduled",
    price_decrease_cancelled: "priceDecreaseCancelled",
    price_increased: "priceIncreased",
    price_decreased: "priceDecreased",
  };

  announcements.createIndex({sent_at: 1, created_at: 1}).catch(console.error);
  // sent rows whose private messages are not queued yet; the cancelled
  // decrease's announcement
  announcements.createIndex({fanout_due: 1}, {sparse: true}).catch(console.error);
  announcements.createIndex({chat_id: 1, type: 1, created_at: 1}).catch(console.error);
  chats.createIndex({"point_price_pending.effective_at": 1}, {sparse: true}).catch(console.error);

  // No member triggers an announcement: the chat's language, else English.
  async function chatLang(chat_id) {
    const config = await getChatConfig(chat_id).catch(error => {
      console.error("chat language lookup failed:", error);
      return null;
    });
    return config?.lang || "en";
  }

  const isPrice = value => (typeof value === "string" && value !== "") || Number.isFinite(value);

  // {text, extra} for sendMessage, or null for an unknown type or bad params.
  function priceMessage(lang, type, params) {
    const key = PRICE_MESSAGES[type];
    if (!key || !isPrice(params?.from) || !isPrice(params?.to)) return null;
    if (type !== "price_decrease_scheduled") return {text: t(lang, key, params), extra: {}};
    if (Number.isNaN(new Date(params.effective_at ?? NaN).getTime())) return null;
    return {
      text: t(lang, key, params),
      extra: {reply_markup: {inline_keyboard: [[{text: t(lang, "buttonOpenApp"), url: MINI_APP_URL}]]}},
    };
  }

  async function drainOutbox(now) {
    let sent = 0;
    // after a failure the chat's later announcements wait, so it never hears
    // them out of order (e.g. "cancelled" before "will drop"); the same goes
    // for its members' private messages
    const held = new Set();
    await fanOutMissed(now, held);

    await announcements.updateMany(
      {sent_at: null, claimed_at: {$lte: new Date(now.getTime() - ANNOUNCE_CLAIM_TIMEOUT_MS)}},
      {$set: {claimed_at: null}},
    );
    // `$not` also matches a row without `attempts`
    const queued = await announcements
      .find({sent_at: null, claimed_at: null, attempts: {$not: {$gte: ANNOUNCE_MAX_ATTEMPTS}}})
      .sort({created_at: 1})
      .limit(ANNOUNCE_BATCH)
      .toArray();

    for (const queuedRow of queued) {
      if (held.has(queuedRow.chat_id)) continue;
      try {
        const row = unwrapModifyResult(
          await announcements.findOneAndUpdate(
            {_id: queuedRow._id, sent_at: null, claimed_at: null},
            {$set: {claimed_at: now}},
          ),
        );
        if (!row) {
          held.add(queuedRow.chat_id); // another run took it; the chat's later ones are its to send
          continue;
        }
        const where = `announcement ${row._id} (${row.type}) to chat ${row.chat_id}`;

        const lang = await chatLang(row.chat_id);
        const message = priceMessage(lang, row.type, row.params);
        if (!message) {
          console.error(`${where}: unknown type or malformed params, giving up`, row.params);
          await announcements.updateOne(
            {_id: row._id},
            {$set: {claimed_at: null, attempts: ANNOUNCE_MAX_ATTEMPTS, last_error: "unknown type or malformed params"}},
          );
          continue;
        }
        // a decrease that already happened (the bot was down) is announced by
        // applyDueDecreases; "will drop" for a past moment would only confuse
        if (row.type === "price_decrease_scheduled" && new Date(row.params.effective_at) <= now) {
          console.log(`${where}: skipped, the decrease is already due`);
          await announcements.updateOne({_id: row._id}, {$set: {sent_at: now, skipped: "already due"}});
          continue;
        }

        try {
          await telegraf.telegram.sendMessage(row.chat_id, message.text, message.extra);
        } catch (error) {
          held.add(row.chat_id);
          const attempts = (row.attempts || 0) + 1;
          const giveUp = attempts >= ANNOUNCE_MAX_ATTEMPTS;
          console.error(`${where}: attempt ${attempts} failed${giveUp ? ", giving up" : ""}:`, error?.message || error);
          await announcements.updateOne(
            {_id: row._id},
            {$set: {claimed_at: null, last_error: String(error?.message || error)}, $inc: {attempts: 1}},
          );
          continue;
        }
        // if this write fails the claim expires and the chat hears it twice,
        // which beats never. `fanout_due` is set in the same write, so a
        // process that dies right after it still leaves the members' private
        // messages to queue (fanOutMissed).
        const fansOut = FAN_OUT_TYPES.has(row.type);
        await announcements.updateOne({_id: row._id}, {$set: fansOut ? {sent_at: now, fanout_due: true} : {sent_at: now}});
        console.log(`${where}: sent`);
        sent++;
        if (fansOut && !(await completeFanOut(row, now))) held.add(row.chat_id);
      } catch (error) {
        // the claim expires and a later run retries
        held.add(queuedRow.chat_id);
        console.error(`announcement ${queuedRow._id} failed:`, error);
      }
    }
    return sent;
  }

  // ---- Private reminders about a price decrease ----
  // When the chat hears that the price of a point will drop, every member
  // with unclaimed points there also gets a private message (the DM queue,
  // dm-queue.mjs): how many points they have and roughly what they are worth
  // at the current price. When the decrease is cancelled, those who got (or
  // were about to get) that message hear it is cancelled. The queue rows of a
  // scheduled decrease carry its announcement's _id as `source_id`.
  //
  // A sent announcement row gets `fanout_due: true` in the same write as
  // `sent_at`; queuing the messages clears it and sets `fanned_out_at`. Rows
  // still due (the process died in between, or queuing failed) are fanned
  // out at the start of the next pass, before the chat's later
  // announcements. Queuing twice is harmless: dm_queue is unique on
  // {source_id, user_id}.
  const FAN_OUT_TYPES = new Set(["price_decrease_scheduled", "price_decrease_cancelled"]);
  const USER_LOOKUP_CHUNK = 1000;

  const dms = createDmQueue({database, telegram: telegraf.telegram, render: renderDm, isStale: staleDm});

  function renderDm(row) {
    const params = row.params;
    if (!isPrice(params?.from)) return null;
    if (row.kind === "price_decrease_cancelled") return {text: t(row.lang, "dmPriceDecreaseCancelled", params), extra: {}};
    if (row.kind !== "price_decrease_scheduled") return null;
    if (!isPrice(params.to) || !params.points || !params.estimate) return null;
    if (Number.isNaN(new Date(params.effective_at ?? NaN).getTime())) return null;
    return {
      text: t(row.lang, "dmPriceDecreaseScheduled", params),
      extra: {reply_markup: {inline_keyboard: [[{text: t(row.lang, "buttonOpenApp"), url: MINI_APP_URL}]]}},
    };
  }

  // The chat's point_price_pending while it is still the decrease `params`
  // announced (not cancelled, replaced or applied), else null.
  function currentPending(chat, params, now) {
    const pending = chat?.point_price_pending;
    const effective = new Date(params?.effective_at ?? NaN).getTime();
    if (!pending || !(effective > now.getTime())) return null;
    if (new Date(pending.effective_at).getTime() !== effective || String(pending.price) !== String(params.to)) return null;
    return pending;
  }

  // A reminder waiting in the queue (a 429, retries, a long queue) is dropped
  // once its decrease is no longer ahead.
  async function staleDm(row, now, cache) {
    if (row.kind !== "price_decrease_scheduled") return null;
    if (!cache.has(row.chat_id)) cache.set(row.chat_id, chats.findOne({id: row.chat_id}));
    return currentPending(await cache.get(row.chat_id), row.params, now) ? null : "decrease no longer pending";
  }

  // user id -> {lang, blocked} for the members to write to: the language of
  // their Telegram app as last seen, else the chat's, else English.
  async function recipientsInfo(chat_id, userIds) {
    const fallback = await chatLang(chat_id);
    const known = new Map();
    for (let i = 0; i < userIds.length; i += USER_LOOKUP_CHUNK) {
      const docs = await users.find({id: {$in: userIds.slice(i, i + USER_LOOKUP_CHUNK)}}).toArray();
      for (const doc of docs) known.set(doc.id, doc);
    }
    return id => {
      const doc = known.get(id);
      return {lang: LANGUAGES.includes(doc?.lang) ? doc.lang : fallback, blocked: Boolean(doc?.dm_blocked_at)};
    };
  }

  async function fanOutScheduled(row, now) {
    const chat = await chats.findOne({id: row.chat_id});
    // cancelled or replaced before the members could be told (e.g. both
    // announcements were queued while the bot was down): tell nobody
    if (!currentPending(chat, row.params, now)) return 0;
    if (decimalMul(1, row.params.from) === null) {
      console.error(`announcement ${row._id}: price ${row.params.from} is not a decimal, no private messages`);
      return 0;
    }

    const holders = (
      await rewards
        .find({chat_id: row.chat_id, points: {$gt: 0}}, {projection: {user_id: 1, points: 1, claimed_points: 1}})
        .toArray()
    )
      .map(doc => ({user_id: doc.user_id, points: decimalSub(doc.points, doc.claimed_points || 0)}))
      .filter(holder => isPositiveDecimal(holder.points));
    if (holders.length === 0) return 0;

    const info = await recipientsInfo(row.chat_id, holders.map(holder => holder.user_id));
    const {from, to, symbol = null, effective_at} = row.params;
    const queued = holders
      .filter(holder => !info(holder.user_id).blocked)
      .map(holder => ({
        user_id: holder.user_id,
        chat_id: row.chat_id,
        source_id: row._id,
        kind: row.type,
        params: {
          chat_title: chat.title || null,
          from,
          to,
          symbol,
          effective_at: new Date(effective_at),
          points: holder.points,
          estimate: decimalMul(holder.points, from),
        },
        lang: info(holder.user_id).lang,
      }));
    return dms.enqueue(queued, now);
  }

  // Only the members who got, or are getting, the reminder of the decrease
  // this cancels: the chat's latest "will drop" announcement before it.
  // Reminders still waiting in the queue are dropped instead.
  async function fanOutCancelled(row, now) {
    const [scheduled] = await announcements
      .find({chat_id: row.chat_id, type: "price_decrease_scheduled", created_at: {$lte: row.created_at}})
      .sort({created_at: -1})
      .limit(1)
      .toArray();
    // never announced, or already cancelled once: its reminders are not about this
    if (!scheduled?.sent_at || scheduled.skipped) return 0;
    if (scheduled.dm_cancelled_by != null && String(scheduled.dm_cancelled_by) !== String(row._id)) return 0;
    await announcements.updateOne({_id: scheduled._id}, {$set: {dm_cancelled_by: row._id}});

    await dms.collection.updateMany(
      {source_id: scheduled._id, sent_at: null, claimed_at: null, attempts: {$not: {$gte: DM_MAX_ATTEMPTS}}},
      {$set: {sent_at: now, skipped: "cancelled"}},
    );
    const reminded = (await dms.collection.find({source_id: scheduled._id}).toArray())
      // delivered, or being sent right now
      .filter(dm => (dm.sent_at && !dm.skipped) || (!dm.sent_at && dm.claimed_at))
      .map(dm => dm.user_id);
    if (reminded.length === 0) return 0;

    const chat = await chats.findOne({id: row.chat_id});
    const info = await recipientsInfo(row.chat_id, reminded);
    const {from, to = null, symbol = null} = row.params;
    const queued = reminded
      .filter(user_id => !info(user_id).blocked)
      .map(user_id => ({
        user_id,
        chat_id: row.chat_id,
        source_id: row._id,
        kind: row.type,
        params: {chat_title: chat?.title || null, from, to, symbol},
        lang: info(user_id).lang,
      }));
    return dms.enqueue(queued, now);
  }

  // Queues the private messages of a sent announcement and marks it done;
  // false (logged) when that failed and a later pass must retry.
  async function completeFanOut(row, now) {
    try {
      const queued =
        row.type === "price_decrease_scheduled" ? await fanOutScheduled(row, now) : await fanOutCancelled(row, now);
      await announcements.updateOne({_id: row._id}, {$set: {fanned_out_at: now}, $unset: {fanout_due: ""}});
      if (queued > 0) console.log(`announcement ${row._id} (${row.type}): ${queued} private messages queued`);
      return true;
    } catch (error) {
      console.error(`announcement ${row._id} (${row.type}): queuing private messages failed:`, error);
      return false;
    }
  }

  // Sent announcements whose private messages were never queued, oldest
  // first; a chat whose fan-out fails is held for the rest of the pass.
  async function fanOutMissed(now, held) {
    const missed = await announcements.find({fanout_due: true}).sort({created_at: 1}).limit(ANNOUNCE_BATCH).toArray();
    for (const row of missed) {
      if (held.has(row.chat_id) || !(await completeFanOut(row, now))) held.add(row.chat_id);
    }
  }

  // A scheduled decrease takes effect at `effective_at`. It is applied only if
  // it is still the one read here: the mini app may have cancelled or
  // replaced it (a new requested_at) in the meantime.
  async function applyDueDecreases(now) {
    let applied = 0;
    const due = await chats
      .find({"point_price_pending.effective_at": {$lte: now}})
      .limit(ANNOUNCE_BATCH)
      .toArray();
    for (const chat of due) {
      try {
        const pending = chat.point_price_pending;
        if (!pending.requested_at || !isPrice(pending.price)) {
          console.error(`chat ${chat.id}: malformed point_price_pending, not applied`, pending);
          continue;
        }
        const update = {
          $unset: {point_price_pending: ""},
          $push: {point_price_history: {old: pending.from, new: pending.price, at: pending.effective_at, by: pending.by}},
        };
        if (pending.to_default) update.$unset.point_price = "";
        else update.$set = {point_price: pending.price};
        const result = await chats.findOneAndUpdate(
          {id: chat.id, "point_price_pending.requested_at": pending.requested_at},
          update,
        );
        if (!unwrapModifyResult(result)) continue; // cancelled, replaced or applied meanwhile
        applied++;
        console.log(
          `chat ${chat.id}: point price decreased ${pending.from} -> ${pending.price}` +
            (pending.to_default ? " (platform default)" : ""),
        );

        const params = {from: pending.from, to: pending.price, symbol: pending.symbol ?? null};
        const message = priceMessage(await chatLang(chat.id), "price_decreased", params);
        if (!message) {
          console.error(`chat ${chat.id}: price decrease not announced, malformed point_price_pending`, pending);
          continue;
        }
        await telegraf.telegram
          .sendMessage(chat.id, message.text, message.extra)
          .catch(error => console.error(`chat ${chat.id}: price decrease announcement failed:`, error?.message || error));
      } catch (error) {
        console.error(`chat ${chat.id}: applying the price decrease failed:`, error);
      }
    }
    return applied;
  }

  // One pass: send queued announcements, then apply due decreases. Never
  // rejects; resolves to what it did, for logs and tests.
  async function runAnnouncements(now = new Date()) {
    const done = {sent: 0, applied: 0, subscriptions: 0};
    try {
      done.sent = await drainOutbox(now);
    } catch (error) {
      console.error("announcement outbox failed:", error);
    }
    try {
      done.applied = await applyDueDecreases(now);
    } catch (error) {
      console.error("applying due price decreases failed:", error);
    }
    // hourly: reminders are days apart
    if (now.getTime() - lastSubscriptionPass >= SUBSCRIPTION_PASS_MS) {
      lastSubscriptionPass = now.getTime();
      try {
        done.subscriptions = await runSubscriptions(now);
      } catch (error) {
        console.error("subscription pass failed:", error);
      }
    }
    return done;
  }

  const SUBSCRIPTION_PASS_MS = 60 * 60 * 1000;
  let lastSubscriptionPass = -Infinity;

  let announceTimer = null;
  let announceRun = null;
  function startAnnouncements(intervalMs = ANNOUNCE_INTERVAL_MS) {
    if (announceTimer) return;
    const tick = () => {
      if (announceRun) return; // the previous pass is still going
      announceRun = runAnnouncements()
        .catch(error => console.error("announcements failed:", error))
        .finally(() => (announceRun = null));
    };
    announceTimer = setInterval(tick, intervalMs);
    announceTimer.unref();
    tick();
  }
  function stopAnnouncements() {
    clearInterval(announceTimer);
    announceTimer = null;
  }
  telegraf.announcements = {run: runAnnouncements, start: startAnnouncements, stop: stopAnnouncements};
  // the hourly subscription pass on its own, for tests
  telegraf.subscriptions = {run: runSubscriptions};
  // The private messages queue, on its own timer (DM_INTERVAL_MS) started by
  // standalone.mjs: `bot.dms.start()`.
  telegraf.dms = {run: dms.run, start: dms.start, stop: dms.stop, limits: dms.limits};

  telegraf.catch(console.error);

  return telegraf;
}
