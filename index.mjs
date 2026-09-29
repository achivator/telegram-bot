import * as dotenv from "dotenv";
import {Telegraf, session} from "telegraf";
import {channelPost, message} from "telegraf/filters";
import {mention} from "telegraf/format";
import {LANGUAGES, langFromCode, t} from "./i18n.mjs";

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
    };
    chatConfigCache.set(chat_id, {value, expiresAt: Date.now() + CHAT_CONFIG_TTL_MS});
    return value;
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
      if (!config.jetton_master) {
        noReward("no reward jetton in this chat, the creator runs /jetton <master address>");
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

    const msg = ctx.message || ctx.channelPost;
    const tokens = (msg.text || "").split(/\s+/).slice(1).filter(Boolean);
    const replyTo = msg.reply_to_message;

    let target = null;
    let args = tokens;

    if (replyTo) {
      if (!replyTo.from || replyTo.from.is_bot) {
        await ctx.reply(t(lang, "rewardNoAuthor"));
        return;
      }
      target = {id: replyTo.from.id, name: replyTo.from.first_name || replyTo.from.username || String(replyTo.from.id)};
    } else {
      const first = tokens[0];
      args = tokens.slice(1);
      if (first?.startsWith("@")) {
        const found = await ctx.telegram.getChatMember(ctx.chat.id, first.slice(1)).catch(() => null);
        if (!found?.user) {
          await ctx.reply(t(lang, "rewardCannotResolve", first));
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

    await chats.updateOne(
      {id: ctx.chat.id},
      {$set: {jetton_master: arg, creator: ctx.from.id, title: ctx.chat.title}},
      {upsert: true},
    );
    chatConfigCache.delete(ctx.chat.id);

    await ctx.reply(t(lang, "jettonSet", arg));
  }

  // /lang shows the chat's language, /lang ru|en changes it (creator and
  // admins). The reply to a change is already in the new language.
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

    const admin = await requireAdmin(ctx, lang, "langAdminsOnly");
    if (!admin.ok) {
      await ctx.reply(admin.error);
      return;
    }

    if (!LANGUAGES.includes(arg)) {
      await ctx.reply(t(lang, "langUnknown", arg.slice(0, 20)));
      return;
    }

    await chats.updateOne(
      {id: ctx.chat.id},
      {$set: {lang: arg}, $setOnInsert: {title: ctx.chat.title || null}},
      {upsert: true},
    );
    chatConfigCache.delete(ctx.chat.id);
    console.log(`chat ${ctx.chat.id} language set to ${arg} by ${ctx.from.id}`);

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
    if (status === "member") {
      rememberGreeting(ctx.chat.id);
      await ctx.reply(t(await ctx.state.lang(), "greeting"));
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

  telegraf.catch(console.error);

  return telegraf;
}
