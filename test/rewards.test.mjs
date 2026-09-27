// Smoke test: drives real Telegram updates through createBot with an
// in-memory stand-in for the handful of MongoDB operations the bot uses.
import assert from "node:assert/strict";
import {Telegram} from "telegraf";

const sent = [];
Telegram.prototype.callApi = async function (method, payload) {
  if (method === "getChatMember") return {status: "member", user: {id: payload.user_id, first_name: `U${payload.user_id}`}};
  if (method === "sendMessage") { sent.push(payload); return {message_id: 1}; }
  return true;
};

const get = (doc, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
const set = (doc, path, v) => { const ks = path.split("."); let o = doc; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = v; };
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) =>
  v && typeof v === "object" && "$lte" in v ? get(doc, k) <= v.$lte : get(doc, k) === v);
const dup = () => Object.assign(new Error("E11000"), {code: 11000});

class Coll {
  constructor() { this.docs = []; this.uniques = []; this.n = 0; }
  async createIndex(keys, opts = {}) { if (opts.unique && !opts.partialFilterExpression) this.uniques.push(Object.keys(keys)); }
  checkUnique(doc) {
    for (const d of this.docs) {
      if (d !== doc && d._id === doc._id) throw dup();
      for (const keys of this.uniques) if (d !== doc && keys.every(k => get(d, k) === get(doc, k))) throw dup();
    }
  }
  async findOne(f) { return this.docs.find(d => matches(d, f)) ?? null; }
  async insertOne(doc) { doc._id ??= ++this.n; this.checkUnique(doc); this.docs.push(doc); return {insertedId: doc._id}; }
  apply(doc, u, inserting) {
    for (const [k, v] of Object.entries(u.$inc || {})) set(doc, k, (get(doc, k) || 0) + v);
    for (const [k, v] of Object.entries(u.$set || {})) set(doc, k, v);
    if (inserting) for (const [k, v] of Object.entries(u.$setOnInsert || {})) set(doc, k, v);
  }
  async upsertOrUpdate(f, u, opts = {}) {
    let doc = this.docs.find(d => matches(d, f));
    if (doc) { this.apply(doc, u, false); return doc; }
    if (!opts.upsert) return null;
    doc = {};
    for (const [k, v] of Object.entries(f)) if (!(v && typeof v === "object")) set(doc, k, v);
    this.apply(doc, u, true);
    await this.insertOne(doc);
    return doc;
  }
  async updateOne(f, u, opts) { await this.upsertOrUpdate(f, u, opts); return {}; }
  async findOneAndUpdate(f, u, opts) { return {value: structuredClone(await this.upsertOrUpdate(f, u, opts))}; }
  async findOneAndDelete(f) { const i = this.docs.findIndex(d => matches(d, f)); return {value: i < 0 ? null : this.docs.splice(i, 1)[0]}; }
  async countDocuments(f, {limit} = {}) { const n = this.docs.filter(d => matches(d, f)).length; return limit ? Math.min(n, limit) : n; }
}
const cols = new Map();
const database = {collection: name => (cols.has(name) ? cols.get(name) : cols.set(name, new Coll()).get(name))};

// the bot explains every unpaid positive reaction in the log
const logs = [];
const originalLog = console.log;
console.log = (...args) => { if (typeof args[0] === "string") logs.push(args[0]); };
const lastNoReward = () => logs.filter(line => line.startsWith("no reward:")).at(-1);

const {default: createBot} = await import("../index.mjs");
const bot = createBot(database, "1:x");
bot.botInfo = {id: 999, is_bot: true, username: "achivator_bot", first_name: "A"};

const CHAT = {id: -100, type: "supergroup", title: "T"};
const CREATOR = 1, REACTOR = 2, AUTHOR = 3, NEWCOMER = 4;
const user = id => ({id, is_bot: false, first_name: `U${id}`});
let updateId = 0, msgId = 0;
const send = async (from, content) => {
  const message_id = ++msgId;
  await bot.handleUpdate({update_id: ++updateId, message: {message_id, date: 1700000000, chat: CHAT, from, ...content}});
  return message_id;
};
const react = (from, message_id, oldR, newR) => bot.handleUpdate({update_id: ++updateId, message_reaction: {
  chat: CHAT, message_id, user: from, date: 1700000000,
  old_reaction: oldR.map(e => (typeof e === "string" ? {type: "emoji", emoji: e} : e)),
  new_reaction: newR.map(e => (typeof e === "string" ? {type: "emoji", emoji: e} : e)),
}});
const points = id => cols.get("rewards").docs.find(d => d.chat_id === CHAT.id && d.user_id === id)?.points ?? 0;
const achievementsOf = id => cols.get("achievements").docs.filter(d => d.user_id === id).map(d => d.type);

await database.collection("chats").insertOne({id: CHAT.id, jetton_master: "EQ" + "a".repeat(46), creator: CREATOR});

// Reactor becomes eligible with mixed message types (only 2 of them text).
await send(user(REACTOR), {sticker: {file_id: "s"}});
await send(user(REACTOR), {photo: [{file_id: "p"}], caption: "meme"});
await send(user(REACTOR), {voice: {file_id: "v"}});
await send(user(REACTOR), {text: "hi"});
// service messages and bots are not activity
await send(user(REACTOR), {new_chat_members: [user(REACTOR)]});
await send({id: 777, is_bot: true, first_name: "Bot"}, {text: "spam"});
assert.equal(await cols.get("messages").countDocuments({chat_id: CHAT.id, user_id: REACTOR}), 4);
assert.equal(cols.get("messages").docs.length, 4);

// A photo by the author: reaction from a 4-message reactor pays nothing yet.
const photo = await send(user(AUTHOR), {photo: [{file_id: "x"}]});
await react(user(REACTOR), photo, [], ["👍"]);
assert.equal(points(AUTHOR), 0, "reactor below 5 messages must not pay");
assert.match(lastNoReward(), /reactor has 4\/5 messages/);
await react(user(REACTOR), photo, ["👍"], []);

await send(user(REACTOR), {text: "fifth"});
await react(user(REACTOR), photo, [], ["👍"]);
assert.equal(points(AUTHOR), 1, "reaction on a photo pays");
await react(user(REACTOR), photo, ["👍"], ["👍", "❤‍🔥", {type: "paid"}]);
assert.equal(points(AUTHOR), 2, "❤‍🔥 pays, paid star is ignored");
await react(user(REACTOR), photo, ["👍", "❤‍🔥"], ["❤‍🔥"]);
assert.equal(points(AUTHOR), 1, "removing 👍 takes its point back");
await react(user(REACTOR), photo, [], ["🤡"]);
assert.match(lastNoReward(), /not a positive reaction: 🤡/);
await react(user(REACTOR), photo, ["🤡"], []);

// Self-reactions and newcomers never pay.
const own = await send(user(REACTOR), {text: "own"});
await react(user(REACTOR), own, [], ["🔥"]);
assert.equal(points(REACTOR), 0);
assert.match(lastNoReward(), /self-reaction/);
await react(user(REACTOR), 424242, [], ["🔥"]);
assert.match(lastNoReward(), /unknown author of message 424242/);
await send(user(NEWCOMER), {text: "hello"});
await react(user(NEWCOMER), photo, [], ["🔥"]);
assert.equal(points(AUTHOR), 1);

// Creator's messages pay CREATOR_MULTIPLIER.
const post = await send(user(CREATOR), {text: "announcement"});
await react(user(REACTOR), post, [], ["🎉"]);
assert.equal(points(CREATOR), 10);

// Received-reaction achievements go to the author, ❤ matches with or without U+FE0F.
await database.collection("statistics").updateOne({chat_id: CHAT.id, user_id: AUTHOR}, {$set: {"reactionsReceived.❤": 99, "reactionsReceived.👍": 99}});
await react(user(REACTOR), photo, ["❤‍🔥"], ["❤‍🔥", "❤️", "👍"]);
assert.deepEqual(achievementsOf(AUTHOR).sort(), ["liked", "loved"]);
assert.deepEqual(achievementsOf(REACTOR), ["sticker", "voicy"], "the reactor must not get the author's achievements");
assert.ok(sent.some(m => m.text.includes("U3") && m.text.includes("loved")), "announcement mentions the author");

// Given-reactions total crossing 100 by several at once still awards "reactive".
await database.collection("statistics").updateOne({chat_id: CHAT.id, user_id: NEWCOMER}, {$set: {reactions: 98}});
await react(user(NEWCOMER), post, [], ["👍", "🔥", "🤩"]);
assert.ok(achievementsOf(NEWCOMER).includes("reactive"));

// newbie at exactly the 10th text message
for (let i = 0; i < 9; i++) await send(user(AUTHOR), {text: `m${i}`});
assert.ok(!achievementsOf(AUTHOR).includes("newbie"));
await send(user(AUTHOR), {text: "tenth"});
assert.ok(achievementsOf(AUTHOR).includes("newbie"));

// Pair cap: one reactor pays one receiver PAIR_DAILY_CAP (5) reactions a day.
for (let i = 0; i < 6; i++) {
  const m = await send(user(AUTHOR), {text: `cap${i}`});
  await react(user(REACTOR), m, [], ["🔥"]);
}
assert.match(lastNoReward(), /daily cap: 5 paid reactions from this reactor/);

// No jetton configured: nothing pays, and the log says why.
const OTHER = {id: -200, type: "supergroup", title: "O"};
for (let i = 0; i < 5; i++) {
  await bot.handleUpdate({update_id: ++updateId, message: {message_id: 9000 + i, date: 1, chat: OTHER, from: user(REACTOR), text: "x"}});
}
await bot.handleUpdate({update_id: ++updateId, message: {message_id: 9100, date: 1, chat: OTHER, from: user(AUTHOR), text: "y"}});
await bot.handleUpdate({update_id: ++updateId, message_reaction: {chat: OTHER, message_id: 9100, user: user(REACTOR), date: 1, old_reaction: [], new_reaction: [{type: "emoji", emoji: "👍"}]}});
assert.match(lastNoReward(), /no reward jetton in this chat/);

// Redelivered message update is recorded once.
await bot.handleUpdate({update_id: ++updateId, message: {message_id: photo, date: 1, chat: CHAT, from: user(AUTHOR), photo: []}});
assert.equal(cols.get("messages").docs.filter(d => d.message_id === photo).length, 1);

console.log = originalLog;
console.log("ALL OK");
// pending achievement clean-up timers would keep the process alive for 30 s
process.exit(0);
