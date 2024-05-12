import dotenv from "dotenv";
import createBot from "./index.mjs";
import { MongoClient } from "mongodb";

const isProduction = process.env.NODE_ENV === "production";

dotenv.config();

const missingEnv = [
  "MONGODB_URI",
  "ACHIVATOR_GRAFANA_USER_ID",
  "ACHIVATOR_GRAFANA_TOKEN",
  "ACHIVATOR_TOKEN",
  "WEBHOOK_URL",
].filter((e) => !process.env[e]);

if (isProduction && missingEnv.length > 0) {
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

bot.launch(botOptions);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
