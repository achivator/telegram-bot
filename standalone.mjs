import dotenv from "dotenv";
import createBot from "./index.mjs";
import { checkEnv, webhookOptions } from "./env.mjs";
import { MongoClient } from "mongodb";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";
const isTelegramTestEnvironment = process.env.TELEGRAM_TEST_ENV === "true";

const { missing: missingEnv, invalid: invalidEnv, warnings } = checkEnv(process.env);
for (const warning of warnings) console.warn(warning);

if (missingEnv.length > 0) {
  console.error("Missing ENV var:", missingEnv.join(", "));
  process.exit(1);
}
if (invalidEnv.length > 0) {
  console.error("Invalid ENV var (WEBHOOK_SECRET: 1-256 of A-Z a-z 0-9 _ -):", invalidEnv.join(", "));
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

// The webhook only takes updates that carry its secret token (env.mjs):
// telegraf answers 403 to any other request.
const botOptions = isProduction
  ? {
      webhook: webhookOptions(process.env),
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
// DM_RATE_PER_SEC per second, checked every DM_INTERVAL_MS while there is
// work and up to every DM_MAX_IDLE_MS while there is none.
bot.dms.start();

// Enable graceful stop
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    bot.announcements.stop();
    bot.dms.stop();
    try {
      bot.stop(signal);
    } catch {
      // "Bot is not running!": the signal came before launch finished (e.g.
      // a Coolify restart during startup). Nothing is in flight yet, and
      // launch would otherwise go on to start the bot.
      process.exit(0);
    }
  });
}
