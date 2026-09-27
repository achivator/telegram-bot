import * as dotenv from "dotenv";
import {Telegraf, session} from "telegraf";
import {channelPost, message} from "telegraf/filters";
import {mention, fmt, bold, link} from "telegraf/format";

dotenv.config();

const NFT_COLLECTION = "v1";

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

function mentionUser(user) {
  return mention(user.first_name || user.username || "member", user);
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

    ctx
      .sendMessage(
        fmt`Hey, ${mentionUser(user)}! New achievement unlocked: ${bold(achievement)}! Check it out in ${link(
          "the mini app",
          "https://t.me/achivator_bot/app",
        )} by @achivator_bot 🎉`,
      )
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

  const chatConfigCache = new Map(); // chat_id -> {value, expiresAt}

  async function getChatRewardConfig(chat_id) {
    const cached = chatConfigCache.get(chat_id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const chat = await chats.findOne({id: chat_id});
    const value = {jetton_master: chat?.jetton_master || null, creator: chat?.creator ?? null};
    chatConfigCache.set(chat_id, {value, expiresAt: Date.now() + CHAT_CONFIG_TTL_MS});
    return value;
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
      const config = await getChatRewardConfig(chat_id);
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
        for (const emoji of positiveAdd) {
          if (!(await takeBudget(`pair:${chat_id}:${reactor_id}:${receiver.user_id}:${day}`, 1, PAIR_DAILY_CAP))) {
            noReward(`daily cap: ${PAIR_DAILY_CAP} paid reactions from this reactor to ${receiver.user_id} today`);
            break;
          }
          if (!(await takeBudget(`recv:${chat_id}:${receiver.user_id}:${day}`, points, RECEIVER_DAILY_CAP))) {
            noReward(`daily cap: ${receiver.user_id} earned ${RECEIVER_DAILY_CAP} reaction points today`);
            break;
          }
          try {
            await reactionPoints.insertOne({...key, emoji: normalizeEmoji(emoji), receiver_id: receiver.user_id, points, date: new Date()});
            delta += points;
          } catch (error) {
            if (error?.code !== 11000) throw error;
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

  const REWARD_USAGE =
    "Grant points to a member:\n" +
    "• as a reply: /reward <points> [reason]\n" +
    "• by mention or id: /reward <@username or user id> <points> [reason]\n" +
    `Points: 1…${MAX_GRANT_POINTS}. Only the creator and admins (including admin bots) can grant.`;

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
  // admin rights could be checked.
  async function requireGranter(ctx) {
    if (!ctx.from) {
      return {
        ok: false,
        error:
          "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
          "Post as yourself, or run the command in the linked discussion group.",
      };
    }
    const member = ctx.from ? await ctx.getChatMember(ctx.from.id).catch(() => null) : null;
    if (!member) {
      return {
        ok: false,
        error:
          "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
          "Post as yourself, or run the command in the linked discussion group.",
      };
    }
    if (!ADMIN_STATUSES.has(member.status)) {
      return {ok: false, error: "Only the chat creator and admins can grant rewards (I must be an admin to check)."};
    }
    return {ok: true, member};
  }

  async function handleReward(ctx) {
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      await ctx.reply("Run /reward in a group or channel where I am an admin.");
      return;
    }

    const granter = await requireGranter(ctx);
    if (!granter.ok) {
      await ctx.reply(granter.error);
      return;
    }

    const config = await getChatRewardConfig(ctx.chat.id);
    if (!config.jetton_master) {
      await ctx.reply("This chat has no reward jetton yet. The creator should run /jetton <master address> first.");
      return;
    }

    const msg = ctx.message || ctx.channelPost;
    const tokens = (msg.text || "").split(/\s+/).slice(1).filter(Boolean);
    const replyTo = msg.reply_to_message;

    let target = null;
    let args = tokens;

    if (replyTo) {
      if (!replyTo.from || replyTo.from.is_bot) {
        await ctx.reply(
          "That message has no author I can reward (a bot or an anonymous channel post).\n" +
            "Grant by id instead: /reward <user id> <points> [reason]",
        );
        return;
      }
      target = {id: replyTo.from.id, name: replyTo.from.first_name || replyTo.from.username || String(replyTo.from.id)};
    } else {
      const first = tokens[0];
      args = tokens.slice(1);
      if (first?.startsWith("@")) {
        const found = await ctx.telegram.getChatMember(ctx.chat.id, first.slice(1)).catch(() => null);
        if (!found?.user) {
          await ctx.reply(`I cannot resolve ${first}: they must be a member of this chat.`);
          return;
        }
        target = {id: found.user.id, name: found.user.first_name || first.slice(1)};
      } else if (/^\d+$/.test(first || "")) {
        target = {id: Number(first), name: first};
      }
    }

    const points = Number(args[0]);
    if (!target || !Number.isInteger(points) || points < 1 || points > MAX_GRANT_POINTS) {
      await ctx.reply(REWARD_USAGE);
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

    await ctx.reply(
      `+${grant.points} points to ${target.name}` +
        (grant.reason ? ` — ${grant.reason}` : "") +
        "\nThey can claim them as jetton in the mini app once they mature.",
      {reply_to_message_id: replyTo?.message_id},
    );
  }

  async function handleJetton(ctx) {
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      ctx.reply("Run this command in a group or channel.");
      return;
    }

    const member = ctx.from ? await ctx.getChatMember(ctx.from.id).catch(() => null) : null;
    if (member?.status !== "creator") {
      ctx.reply(
        ctx.from
          ? "Only the chat creator can set the reward jetton."
          : "I cannot see who sent this (a post on behalf of the channel). Post as yourself to run /jetton.",
      );
      return;
    }

    const arg = ((ctx.message || ctx.channelPost).text || "").split(/\s+/)[1];
    if (!arg) {
      const chat = await chats.findOne({id: ctx.chat.id});
      ctx.reply(
        chat?.jetton_master
          ? `Current reward jetton: ${chat.jetton_master}\n\n` +
              `Members earn points for positive reactions and claim them as jettons in the mini app.\n` +
              `To change the jetton: /jetton <master address>`
          : `No reward jetton set for this chat yet.\n\n` +
              `To enable rewards: /jetton <jetton master address>\n` +
              `You will need the jettons in your wallet to top up the pool later.`,
      );
      return;
    }

    if (!isTonAddress(arg)) {
      ctx.reply("That does not look like a TON jetton master address (EQ... / UQ... / 0:...).");
      return;
    }

    await chats.updateOne(
      {id: ctx.chat.id},
      {$set: {jetton_master: arg, creator: ctx.from.id, title: ctx.chat.title}},
      {upsert: true},
    );
    chatConfigCache.delete(ctx.chat.id);

    ctx.reply(
      `Reward jetton set: ${arg}\n\n` +
        `Next steps:\n` +
        `1. Open the mini app and activate the chat pool (one-time, 0.3 TON).\n` +
        `2. Top up the pool with your jettons.\n` +
        `Members will then earn points for positive reactions and claim them as jettons.`,
    );
  }

  telegraf.telegram
    .setMyCommands([
      {command: "verify", description: "Verify creator status"},
      {command: "jetton", description: "Set the reward jetton for this chat (creators)"},
      {command: "reward", description: "Grant points to a member (admins)"},
    ])
    .catch(console.error);

  telegraf.command("reward", handleReward);

  // A channel post is not a `message`, so Telegraf's command middleware never
  // sees commands typed inside a channel; dispatch them here.
  telegraf.on(channelPost("text"), async (ctx, next) => {
    const match = (ctx.channelPost.text || "").match(/^\/(\w+)(?:@(\w+))?/);
    if (!match) return next();
    const me = ctx.me || (await ctx.telegram.getMe().catch(() => null))?.username;
    if (match[2] && match[2].toLowerCase() !== String(me).toLowerCase()) return next();
    if (match[1] === "reward") return handleReward(ctx);
    if (match[1] === "jetton") return handleJetton(ctx);
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
    ctx.reply("Migration completed");
  });

  telegraf.command("verify", async ctx => {
    const type = ctx.chat?.type;
    if (type !== "group" && type !== "supergroup") {
      await ctx.reply("Run /verify in the group you created.");
      return;
    }
    const member = await ctx.getChatMember(ctx.from.id).catch(() => null);
    if (!member) {
      await ctx.reply("I cannot check your status here. Make sure I am an admin of this chat.");
      return;
    }
    if (member.status !== "creator") {
      await ctx.reply(`You are ${member.status}, but only chat creators can verify the bot.`);
      return;
    }
    await chats.updateOne({id: ctx.chat.id}, {$set: {creator: member.user.id}}, {upsert: true});
    chatConfigCache.delete(ctx.chat.id);
    await ctx.reply(
      `Verified. You are ${member.status}. 
You can now set Jetton for this chat and access other settings.`,
    );
  });

  telegraf.command("jetton", handleJetton);

  telegraf.on("my_chat_member", async (ctx, next) => {
    console.log("my_chat_member", ctx.update);

    const status = ctx.update.my_chat_member.new_chat_member?.status;

    // if bot was added to a new chat, announce itself and suggest granting admin rights so that it could read messages.
    if (status === "member") {
      ctx.reply(
        `Hello! I'm the Achivator Bot. I'm here to help you track and reward achievements in your chat. 
To get started, make sure to 1) grant me admin rights so that I could read messages and reactions, 
and 2) Verify as the chat creator /verify@achivator_bot.
I don't store full message texts, just statistics, and I'm open source! 
You can find the source code at https://github.com/seniorsoftwarevlogger/achivator`,
      );
    }

    // Check if the bot was granted admin rights
    if (status === "administrator") {
      ctx.reply(
        "Thank you for granting me admin rights! I will now be able to track messages and reactions 🙌\n" +
          "To reward members with jettons for positive reactions, the chat creator runs /jetton <jetton master address>.",
      );
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
            .catch(() => ({id: receiver.user_id, first_name: "member"}));
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
