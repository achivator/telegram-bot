import dotenv from "dotenv";
import createBot from "./index.mjs";
import { checkEnv } from "./env.mjs";
import { MongoClient } from "mongodb";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const isTelegramTestEnvironment = process.env.TELEGRAM_TEST_ENV === "true";

const { missing: missingEnv, warnings } = checkEnv(process.env);
for (const warning of warnings) console.warn(warning);

if (missingEnv.length > 0) {
  console.error("Missing ENV var:", missingEnv.join(", "));
  process.exit(1);
}

// Main ========================================================================
const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();

const database = mongo.db("achivator_bot");

const bot = createBot(database, process.env.ACHIVATOR_TOKEN, {
  telegram: {
    webhookReply: isProduction,
    testEnv: isTelegramTestEnvironment,
  },
});

const botOptions = isProduction
  ? {
      webhook: {
        domain: process.env.WEBHOOK_URL,
        port: parseInt(process.env.PORT || "3000", 10),
      },
    }
  : {
      polling: { timeout: 30, limit: 10 },
    };

// Telegram leaves reactions out of the default update set: without listing
// them here the bot never sees a reaction, so it can pay no reaction points.
// pre_checkout_query confirms a subscription payment in Stars (the bot must
// answer it within 10 seconds or the payment fails).
// The list is also stored by setWebhook and replaces what was set before.
const allowedUpdates = [
  "message",
  "channel_post",
  "my_chat_member",
  "message_reaction",
  "message_reaction_count",
  "pre_checkout_query",
];

bot.launch({ ...botOptions, allowedUpdates });

// Point price announcements queued by the mini app, and scheduled price
// decreases that fall due (ANNOUNCE_INTERVAL_MS).
bot.announcements.start();
// Private messages to members (price decrease reminders), at most
// DM_RATE_PER_SEC per second, checked every DM_INTERVAL_MS.
bot.dms.start();

// Enable graceful stop
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    bot.announcements.stop();
    bot.dms.stop();
    bot.stop(signal);
  });
}
