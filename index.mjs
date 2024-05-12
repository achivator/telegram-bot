import * as dotenv from "dotenv";
import {Telegraf, session} from "telegraf";
import {message} from "telegraf/filters";
import {mention, fmt, bold, link} from "telegraf/format";
import fetch from "node-fetch";

dotenv.config();

const NFT_COLLECTION = "v1";

function postMetric(body) {
  return fetch.default("https://influx-prod-24-prod-eu-west-2.grafana.net/api/v1/push/influx/write", {
    method: "post",
    body,
    headers: {
      Authorization: `Bearer ${process.env.ACHIVATOR_GRAFANA_USER_ID}:${process.env.ACHIVATOR_GRAFANA_TOKEN}`,
      "Content-Type": "text/plain",
    },
  });
}

function incrementStat(collection, chat_id, user_id, item_id, type) {
  postMetric(`messages,chat_id=${chat_id},user_id=${user_id},type=${type} value=1`);

  return collection.updateOne({chat_id, user_id}, {$inc: {[type]: 1}}, {upsert: true});
}

function mentionUser(user) {
  return mention(user.first_name, user);
}

async function giveAchievement(ctx, dbCollection, achievement) {
  const chat_id = ctx.chat.id;
  const user_id = ctx.from.id;

  const existingAchievement = await dbCollection.findOne({
    chat_id,
    user_id,
    type: achievement,
    collection: NFT_COLLECTION,
  });

  if (existingAchievement) return;

  const message_id = ctx.message?.message_id || ctx.message_reaction?.message_id;

  await dbCollection.insertOne(
    {
      chat_id,
      user_id,
      type: achievement,
      date: Date.now(),
      message_id,
      collection: NFT_COLLECTION,
    },
    {upsert: true},
  );

  console.log(`User ${ctx.from.id} got achievement ${achievement} in chat ${ctx.chat.id}`);

  ctx
    .sendMessage(
      fmt`Hey, ${mentionUser(ctx.from)}! New achievement unlocked: ${bold(achievement)}! Check it out in ${link(
        "the mini app",
        "https://t.me/achivator_bot/app",
      )} by @achivator_bot 🎉`,
    )
    .then(botReply => setTimeout(() => ctx.deleteMessage(botReply.message_id).catch(console.error), 30000));

  // ctx.telegram
  //   .sendMessage(ctx.from.id, fmt`New achievement: ${bold(achievement)} in ${ctx.chat.title}!`)
  //   .catch(console.error);

  // Send grafana metric to count achievements
  postMetric(`achievements,chat_id=${chat_id},user_id=${user_id},type=${achievement} value=1`);
}

export default function createBot(database, token, options) {
  const telegraf = new Telegraf(token, options);

  const achievements = database.collection("achievements");
  const statistics = database.collection("statistics");
  const messages = database.collection("messages");
  const chats = database.collection("chats");

  telegraf.telegram.setMyCommands([{command: "verify", description: "Verify creator status"}]).catch(console.error);

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
    await ctx.getChatMember(ctx.from.id).then(member => {
      console.log(member);

      if (member.status === "creator") {
        ctx.reply(
          `Verified. You are ${member.status}. 
You can now set Jetton for this chat and access other settings.`,
        );
        return chats.updateOne({id: ctx.chat.id}, {$set: {creator: member.user.id}}, {upsert: true});
      } else {
        ctx.reply(`You are ${member.status}, but only chat creators can verify the bot.`);
      }

      return Promise.resolve();
    });
  });

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
      ctx.reply("Thank you for granting me admin rights! I will now be able to track messages and reactions 🙌");
    }

    next();
  });

  telegraf.on("message_reaction", async (ctx, next) => {
    console.log(ctx.update, ctx.from);
    if (!ctx.from) return; // only handle reactions from users

    // Preparing the reactions to be added and removed
    // We only care about native emoji reactions
    const newReactions = ctx.update.message_reaction.new_reaction
      .filter(reaction => reaction.type == "emoji")
      .map(reaction => reaction.emoji);
    const oldReactions = ctx.update.message_reaction.old_reaction
      .filter(reaction => reaction.type == "emoji")
      .map(reaction => reaction.emoji);

    // If new reactions are not in the old reactions, they are added
    const reactionsToAdd = newReactions.filter(reaction => !oldReactions.includes(reaction));

    // If old reactions are not in the new reactions, they are removed
    const reactionsToRemove = oldReactions.filter(reaction => !newReactions.includes(reaction));

    console.log({reactionsToAdd, reactionsToRemove});

    // keep separate reactions count for each chat
    if (reactionsToAdd.length > 0) {
      await statistics.updateOne(
        {chat_id: ctx.chat.id, user_id: ctx.from.id},
        {
          $inc: {
            reactions: reactionsToAdd.length,
            ...Object.fromEntries(reactionsToAdd.map(reaction => [`reactionsGiven.${reaction}`, 1])),
          },
        },
        {upsert: true},
      );
    }
    if (reactionsToRemove.length > 0) {
      await statistics.updateOne(
        {chat_id: ctx.chat.id, user_id: ctx.from.id},
        {
          $inc: {
            reactions: -reactionsToRemove.length,
            ...Object.fromEntries(reactionsToRemove.map(reaction => [`reactionsGiven.${reaction}`, -1])),
          },
        },
        {upsert: true},
      );
    }

    const receiver = await database
      .collection("messages")
      .findOne({chat_id: ctx.chat.id, message_id: ctx.update.message_reaction.message_id});

    console.log({chat_id: ctx.chat.id, message_id: ctx.update.message_reaction.message_id, receiver});

    if (receiver) {
      if (reactionsToAdd.length > 0) {
        await statistics.updateOne(
          {chat_id: ctx.chat.id, user_id: receiver.user_id},
          {$inc: Object.fromEntries(reactionsToAdd.map(reaction => [`reactionsReceived.${reaction}`, 1]))},
          {upsert: true},
        );
      }
      if (reactionsToRemove.length > 0) {
        await statistics.updateOne(
          {chat_id: ctx.chat.id, user_id: receiver.user_id},
          {$inc: Object.fromEntries(reactionsToRemove.map(reaction => [`reactionsReceived.${reaction}`, -1]))},
          {upsert: true},
        );
      }
    }

    next();
  });

  telegraf.on("message_reaction", async (ctx, next) => {
    const userQuery = {chat_id: ctx.chat.id, user_id: ctx.from.id};
    const chatUser =
      (await statistics.findOne(userQuery)) ||
      (await statistics.insertOne(userQuery, {messages: 0, reactions: 0, reactionsGiven: {}}));

    if (!chatUser) return;

    if (chatUser.reactions === 100) {
      giveAchievement(ctx, achievements, "reactive");
    }

    // received reactions
    if (chatUser.reactionsReceived?.["👍"] === 100) {
      giveAchievement(ctx, achievements, "liked");
    }
    if (chatUser.reactionsReceived?.["🔥"] === 100) {
      giveAchievement(ctx, achievements, "on fire");
    }
    if (chatUser.reactionsReceived?.["❤️"] === 100) {
      giveAchievement(ctx, achievements, "loved");
    }
    if (chatUser.reactionsReceived?.["🤡"] === 100) {
      giveAchievement(ctx, achievements, "clown");
    }
    if (chatUser.reactionsReceived?.["💩"] === 100) {
      giveAchievement(ctx, achievements, "poop");
    }

    // given reactions
    if (chatUser.reactionsGiven?.["🤡"] === 100) {
      giveAchievement(ctx, achievements, "sad clown");
    }
    if (chatUser.reactionsGiven?.["❤️"] === 100) {
      giveAchievement(ctx, achievements, "spread the love");
    }
    if (chatUser.reactionsGiven?.["👍"] === 100) {
      giveAchievement(ctx, achievements, "likes for everyone");
    }
    if (chatUser.reactionsGiven?.["🔥"] === 100) {
      giveAchievement(ctx, achievements, "fire starter");
    }
    if (chatUser.reactionsGiven?.["💩"] === 100) {
      giveAchievement(ctx, achievements, "poop master");
    }
  });

  telegraf.on("message_reaction_count", async (ctx, next) => {
    // represents reaction changes on a message with anonymous reactions.

    console.log("message_reaction_count", ctx.update);

    next();
  });

  telegraf.on(message("video_note"), async (ctx, next) => {
    console.log("video_note", ctx.update);
    incrementStat(statistics, ctx.chat.id, ctx.from.id, ctx.message?.message_id, "video_note");
    giveAchievement(ctx, achievements, "telescope");

    next();
  });

  telegraf.on(message("voice"), async (ctx, next) => {
    console.log("voice", ctx.update);
    incrementStat(statistics, ctx.chat.id, ctx.from.id, ctx.message?.message_id, "voice");
    giveAchievement(ctx, achievements, "voicy");

    next();
  });

  telegraf.on(message("sticker"), async (ctx, next) => {
    console.log("sticker", ctx.update);
    incrementStat(statistics, ctx.chat.id, ctx.from.id, ctx.message?.message_id, "sticker");
    giveAchievement(ctx, achievements, "sticker");

    next();
  });

  telegraf.on(message("text"), async (ctx, next) => {
    if (!ctx.from) return; // only handle messages from users
    if (ctx.from?.is_bot) return; // Filter out messages sent by the bots
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return; // Filter out messages sent to the bot privately

    console.log(ctx.message);

    // keep track of all messages to award reactions
    await messages.insertOne({
      chat_id: ctx.chat.id,
      user_id: ctx.from.id,
      message_id: ctx.message.message_id,
      date: ctx.message.date,
    });
    // keep track of all chats
    if (!(await chats.findOne({id: ctx.chat.id}))) {
      await chats.insertOne({id: ctx.chat.id, title: ctx.chat.title}, {upsert: true});
    }

    // keep separate messages count for each chat
    const userQuery = {chat_id: ctx.chat.id, user_id: ctx.from.id};
    const chatUser =
      (await statistics.findOne(userQuery)) ||
      (await statistics.insertOne(userQuery, {messages: 0, reactions: 0, reactionsGiven: {}}));

    incrementStat(statistics, ctx.chat.id, ctx.from.id, ctx.message?.message_id, "messages");

    // detect if user reached 100 messages
    if (chatUser && chatUser.messages === 100) {
      giveAchievement(ctx, achievements, "talkative");
    }
    if (chatUser && chatUser.messages === 10) {
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
