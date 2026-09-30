// Smoke test: drives real Telegram updates through createBot with an
// in-memory stand-in for the handful of MongoDB operations the bot uses.
import assert from "node:assert/strict";
import {Telegram} from "telegraf";

const sent = [];
const commandMenus = [];
// chat member status by user id ("member" when unset); "error" makes the
// lookup fail, as it does for an anonymous admin
const statuses = new Map();
// sendMessage to these chats fails, as it does once the bot is removed
const failingChats = new Set();
const sendAttempts = [];
// private messages to these users fail with the error the function returns
const dmFailures = new Map();
Telegram.prototype.callApi = async function (method, payload) {
  if (method === "getChatMember") {
    const status = statuses.get(payload.user_id) ?? "member";
    if (status === "error") throw new Error("Bad Request: user not found");
    return {status, user: {id: payload.user_id, first_name: `U${payload.user_id}`}};
  }
  if (method === "sendMessage") {
    sendAttempts.push(payload.chat_id);
    if (failingChats.has(payload.chat_id)) throw new Error("Forbidden: bot was kicked from the group chat");
    if (dmFailures.has(payload.chat_id)) throw dmFailures.get(payload.chat_id)();
    sent.push(payload);
    return {message_id: 1};
  }
  if (method === "setMyCommands") commandMenus.push(payload);
  return true;
};

const get = (doc, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
const set = (doc, path, v) => { const ks = path.split("."); let o = doc; for (const k of ks.slice(0, -1)) o = o[k] ??= {}; o[ks.at(-1)] = v; };
// Mongo semantics the bot relies on: null matches a missing field, dates
// compare by value, comparisons never match a missing field.
const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const OPS = {
  $lt: (x, v) => x != null && x < v,
  $gt: (x, v) => x != null && x > v,
  $in: (x, v) => v.some(y => same(x, y)),
  $lte: (x, v) => x != null && x <= v,
  $gte: (x, v) => x != null && x >= v,
  $ne: (x, v) => !same(x ?? null, v),
  $not: (x, v) => !test(x, v),
};
const isOps = v => v && typeof v === "object" && !(v instanceof Date) && Object.keys(v).every(k => k in OPS);
const test = (x, v) =>
  isOps(v) ? Object.entries(v).every(([op, arg]) => OPS[op](x, arg)) : v === null ? x == null : same(x, v);
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => test(get(doc, k), v));
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
  find(f) {
    let docs = this.docs.filter(d => matches(d, f)).map(d => structuredClone(d));
    const cursor = {
      sort(spec) { const [[k, dir]] = Object.entries(spec); docs.sort((a, b) => (get(a, k) < get(b, k) ? -dir : get(a, k) > get(b, k) ? dir : 0)); return cursor; },
      limit(n) { docs = docs.slice(0, n); return cursor; },
      async toArray() { return docs; },
    };
    return cursor;
  }
  async insertOne(doc) { doc._id ??= ++this.n; this.checkUnique(doc); this.docs.push(doc); return {insertedId: doc._id}; }
  // unordered: inserts what it can, then reports the duplicates like the driver
  async insertMany(docs) {
    const writeErrors = [];
    for (const doc of docs) await this.insertOne(doc).catch(error => writeErrors.push(error));
    if (writeErrors.length) throw Object.assign(new Error("E11000"), {code: 11000, writeErrors});
    return {insertedCount: docs.length};
  }
  apply(doc, u, inserting) {
    for (const [k, v] of Object.entries(u.$inc || {})) set(doc, k, (get(doc, k) || 0) + v);
    for (const [k, v] of Object.entries(u.$set || {})) set(doc, k, v);
    for (const k of Object.keys(u.$unset || {})) { const ks = k.split("."); const o = get(doc, ks.slice(0, -1).join(".")) ?? (ks.length === 1 ? doc : undefined); if (o) delete o[ks.at(-1)]; }
    for (const [k, v] of Object.entries(u.$push || {})) set(doc, k, [...(get(doc, k) || []), v]);
    for (const [k, v] of Object.entries(u.$max || {})) if (get(doc, k) == null || get(doc, k) < v) set(doc, k, v);
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
  async updateMany(f, u) { const hit = this.docs.filter(d => matches(d, f)); for (const d of hit) this.apply(d, u, false); return {modifiedCount: hit.length}; }
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

// A reaction stopped by the receiver's daily cap keeps the pair budget intact,
// and a redelivered update gives back what it took.
const day = new Date().toISOString().slice(0, 10);
const budget = id => cols.get("reaction_budget").docs.find(d => d._id === id)?.used ?? 0;
const RICH = 5;
await database.collection("reaction_budget").insertOne({_id: `recv:${CHAT.id}:${RICH}:${day}`, used: 200});
const rich = await send(user(RICH), {text: "popular"});
await react(user(REACTOR), rich, [], ["👍"]);
assert.match(lastNoReward(), /earned 200 reaction points today/);
assert.equal(budget(`pair:${CHAT.id}:${REACTOR}:${RICH}:${day}`), 0, "receiver cap must not spend the pair budget");

const again = await send(user(NEWCOMER), {text: "again"});
const redelivered = {update_id: ++updateId, message_reaction: {chat: CHAT, message_id: again, user: user(REACTOR), date: 1,
  old_reaction: [], new_reaction: [{type: "emoji", emoji: "👍"}]}};
await bot.handleUpdate(redelivered);
await bot.handleUpdate(structuredClone(redelivered));
assert.match(lastNoReward(), /already paid/);
assert.equal(points(NEWCOMER), 1);
assert.equal(budget(`pair:${CHAT.id}:${REACTOR}:${NEWCOMER}:${day}`), 1, "a redelivery must not spend the pair budget");
assert.equal(budget(`recv:${CHAT.id}:${NEWCOMER}:${day}`), 1, "a redelivery must not spend the receiver budget");

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

// ---- Languages ----
const {t, langFromCode} = await import("../i18n.mjs");
assert.deepEqual(["ru", "ru-RU", "RU", "uk", "be", "kk", "en-US", "de", undefined, ""].map(langFromCode),
  ["ru", "ru", "ru", "en", "en", "en", "en", "en", "en", "en"]);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const lastText = chat_id => sent.filter(m => m.chat_id === chat_id).at(-1)?.text;
const speaker = (id, language_code) => ({...user(id), language_code});
const inChat = (chat, from, content) =>
  bot.handleUpdate({update_id: ++updateId, message: {message_id: ++msgId, date: 1, chat, from, ...content}});
const command = text => ({text, entities: [{type: "bot_command", offset: 0, length: text.split(" ")[0].length}]});

// Command menus: English by default and Russian; private chats list /start
// and /help, groups the chat commands (with /lang) and /help.
assert.deepEqual(commandMenus.map(menu => `${menu.language_code ?? "en"}:${menu.scope.type}`),
  ["en:default", "en:all_private_chats", "en:all_group_chats", "ru:default", "ru:all_private_chats", "ru:all_group_chats"]);
const menu = (lang, type) => commandMenus.find(m => (m.language_code ?? "en") === lang && m.scope.type === type).commands;
assert.deepEqual(menu("en", "default").slice(0, 3), [
  {command: "verify", description: "Verify creator status"},
  {command: "jetton", description: "Set the reward jetton for this chat (creators)"},
  {command: "reward", description: "Grant points to a member (admins)"},
]);
assert.deepEqual(menu("en", "all_private_chats").map(c => c.command), ["start", "help"]);
assert.deepEqual(menu("en", "all_group_chats").map(c => c.command), ["verify", "jetton", "reward", "lang", "help"]);
assert.deepEqual(menu("ru", "all_group_chats").map(c => c.command), ["verify", "jetton", "reward", "lang", "help"]);
assert.match(menu("ru", "default")[0].description, /создатель/);
assert.equal(menu("ru", "all_private_chats")[1].description, "Инструкция по настройке");
assert.ok(commandMenus.every(m => m.commands.every(c => c.description && !c.description.startsWith("command"))));

// Until a group has a language, an announcement follows the member who triggered it.
const MIXED = {id: -300, type: "supergroup", title: "Mixed"};
await inChat(MIXED, speaker(11, "ru"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /^Поздравляем, U11! Новое достижение: sticker!/);
await inChat(MIXED, speaker(12, "en-US"), {sticker: {file_id: "s"}});
await settle();
assert.equal(lastText(MIXED.id), "Hey, U12! New achievement unlocked: sticker! Check it out in the mini app by @achivator_bot 🎉");
const bolded = sent.at(-1).entities.find(e => e.type === "bold");
assert.equal(sent.at(-1).text.slice(bolded.offset, bolded.offset + bolded.length), "sticker");
await inChat(MIXED, speaker(13, "uk"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /New achievement unlocked/, "Ukrainian clients get English");
await inChat(MIXED, user(14), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /New achievement unlocked/, "no language_code means English");

// Anyone can see the language, only the creator and admins change it.
await inChat(MIXED, speaker(12, "en"), command("/lang"));
assert.equal(lastText(MIXED.id), `${t("en", "langNotSet")}\n${t("en", "langUsage")}`);
await inChat(MIXED, speaker(11, "ru"), command("/lang en"));
assert.equal(lastText(MIXED.id), t("ru", "langAdminsOnly"));
const ANONYMOUS = {id: 1087968824, is_bot: true, first_name: "Group"};
statuses.set(ANONYMOUS.id, "error");
await inChat(MIXED, ANONYMOUS, command("/lang@achivator_bot ru"));
assert.equal(
  lastText(MIXED.id),
  "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
    "Post as yourself, or run the command in the linked discussion group.",
);
assert.equal((await database.collection("chats").findOne({id: MIXED.id}))?.lang, undefined);

// An admin sets Russian: from now on even English speakers get Russian here,
// although the chat's language was cached as unset a moment ago.
const ADMIN = 15;
statuses.set(ADMIN, "administrator");
await inChat(MIXED, speaker(ADMIN, "en"), command("/lang de"));
assert.equal(lastText(MIXED.id), `I don't speak "de" yet. Available: /lang ru, /lang en or /lang auto`);
await inChat(MIXED, speaker(ADMIN, "en"), command("/lang RU"));
assert.equal(lastText(MIXED.id), "Язык чата: русский. Теперь я пишу здесь по-русски.");
assert.equal((await database.collection("chats").findOne({id: MIXED.id})).lang, "ru");
await inChat(MIXED, speaker(16, "en"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /^Поздравляем, U16!/);
await inChat(MIXED, speaker(ADMIN, "en"), command("/reward 5"));
assert.match(lastText(MIXED.id), /^В этом чате ещё не задан жетон/);
await inChat(MIXED, speaker(12, "en"), command("/lang"));
assert.equal(lastText(MIXED.id),
  "Язык чата: русский.\nИзменить (создатель и администраторы): /lang ru, /lang en или /lang auto — по языку приложения каждого участника");
await inChat(MIXED, speaker(ADMIN, "ru"), command("/lang en"));
assert.equal(lastText(MIXED.id), "Chat language set: English. I will write here in English.");
await inChat(MIXED, speaker(17, "ru"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /New achievement unlocked/);
// /lang auto (admins only) removes the language: replies follow whoever
// triggered them again, the confirmation included.
await inChat(MIXED, speaker(11, "ru"), command("/lang auto"));
assert.equal(lastText(MIXED.id), "Only the chat creator and admins can change the chat language (I must be an admin to check).");
await inChat(MIXED, speaker(ADMIN, "ru"), command("/lang AUTO"));
assert.equal(lastText(MIXED.id), "Язык чата сброшен: я отвечаю каждому на языке его приложения Telegram.");
assert.equal((await database.collection("chats").findOne({id: MIXED.id})).lang, undefined);
await inChat(MIXED, speaker(18, "ru"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /^Поздравляем, U18!/);
await inChat(MIXED, speaker(12, "en"), command("/lang"));
assert.equal(lastText(MIXED.id), `${t("en", "langNotSet")}\n${t("en", "langUsage")}`);

// A reward confirmation in a Russian group, with Russian plurals.
statuses.set(CREATOR, "creator");
await send(user(CREATOR), command("/lang ru"));
const meme = await send(user(AUTHOR), {text: "meme"});
await send(user(CREATOR), {...command("/reward 5 мем"), reply_to_message: {message_id: meme, date: 1, chat: CHAT, from: user(AUTHOR), text: "meme"}});
assert.equal(lastText(CHAT.id), "U3: +5 баллов — мем\nИх можно будет забрать жетонами в мини-приложении, когда пройдёт срок созревания.");
// grants are dated in epoch ms, reactions with a Date (what the mini app's lot
// valuation and maturation expect)
assert.ok(cols.get("grants").docs.length > 0);
assert.ok(cols.get("grants").docs.every(d => Number.isSafeInteger(d.date)));
assert.ok(cols.get("reaction_points").docs.length > 0);
assert.ok(cols.get("reaction_points").docs.every(d => d.date instanceof Date));
assert.deepEqual([1, 2, 5, 11, 21, 22, 112].map(n => t("ru", "rewardGranted", n, "X").split("\n")[0]),
  ["X: +1 балл", "X: +2 балла", "X: +5 баллов", "X: +11 баллов", "X: +21 балл", "X: +22 балла", "X: +112 баллов"]);
assert.equal(t("en", "rewardGranted", 5, "U3", null),
  "+5 points to U3\nThey can claim them as jetton in the mini app once they mature.");

// /reward @username: resolved through the users the bot has seen, any case,
// and only while they are members of the chat.
const MEME_LORD = {id: 61, is_bot: false, first_name: "Meme", username: "MemeLord"};
await send(MEME_LORD, {text: "a meme"});
await send(user(CREATOR), command("/reward @memelord 7 мем"));
assert.equal(lastText(CHAT.id), "U61: +7 баллов — мем\nИх можно будет забрать жетонами в мини-приложении, когда пройдёт срок созревания.");
assert.equal(points(61), 7);
assert.deepEqual(
  (({id, username, first_name}) => ({id, username, first_name}))(await database.collection("users").findOne({id: 61})),
  {id: 61, username: "memelord", first_name: "Meme"});
await send(user(CREATOR), command("/reward @nobody_here 3"));
assert.equal(lastText(CHAT.id), "Я ещё не видел @nobody_here в этом чате — ответьте на его сообщение: /reward <баллы> [причина]");
assert.equal(t("en", "rewardUnknownUsername", "@x"),
  "I haven't seen @x in this chat yet — reply to their message instead: /reward <points> [reason]");
await react({id: 62, is_bot: false, first_name: "Gone", username: "gone"}, photo, [], ["🤡"]);
statuses.set(62, "left");
await send(user(CREATOR), command("/reward @Gone 3"));
assert.equal(lastText(CHAT.id), "Не могу найти @Gone: пользователь должен быть участником этого чата.");
assert.equal(points(62), 0);
statuses.delete(62);
// the username moves to another account: it now resolves to the new owner
await send({id: 63, is_bot: false, first_name: "Heir", username: "memelord"}, {text: "mine now"});
await send(user(CREATOR), command("/reward @MemeLord 2"));
assert.equal(points(63), 2);
assert.equal(points(61), 7);
assert.equal((await database.collection("users").findOne({id: 61})).username, null);
// A member without a username is mentioned by name: a text_mention entity
// that carries the user. The name may have spaces; only a mention in the
// target's place picks the target.
const IVAN = {id: 64, is_bot: false, first_name: "Ivan", last_name: "Petrov"};
const mentionCommand = (text, name, user) => ({text, entities: [
  {type: "bot_command", offset: 0, length: text.split(" ")[0].length},
  {type: "text_mention", offset: text.indexOf(name), length: name.length, user},
]});
await send(user(CREATOR), mentionCommand("/reward Ivan Petrov 4 мем", "Ivan Petrov", IVAN));
assert.equal(lastText(CHAT.id), "Ivan: +4 балла — мем\nИх можно будет забрать жетонами в мини-приложении, когда пройдёт срок созревания.");
assert.equal(points(IVAN.id), 4);
await send(user(CREATOR), mentionCommand("/reward 3 за Ivan Petrov", "Ivan Petrov", IVAN));
assert.match(lastText(CHAT.id), /^Начислить баллы участнику:/);
assert.equal(points(IVAN.id), 4);
statuses.delete(CREATOR);

// Private chats follow the user's Telegram app.
const DM = id => ({id, type: "private", first_name: `U${id}`});
await inChat(DM(21), speaker(21, "ru"), command("/reward 5"));
assert.equal(lastText(21), "Выполните /reward в группе или канале, где я администратор.");
await inChat(DM(22), speaker(22, "en"), command("/reward 5"));
assert.equal(lastText(22), "Run /reward in a group or channel where I am an admin.");
await inChat(DM(21), speaker(21, "ru-RU"), command("/lang ru"));
assert.match(lastText(21), /^В личном чате я пишу на языке вашего приложения Telegram/);
for (const code of ["uk", "be", "kk"]) {
  await inChat(DM(21), speaker(21, code), command("/lang ru"));
  assert.match(lastText(21), /^In a private chat I use the language of your Telegram app/, `${code} gets English`);
}

// The bot greets a new group in the language of whoever added it; the English
// replies quoted by the mini app setup guide keep their exact wording.
const botStatus = (chat, from, status) => bot.handleUpdate({update_id: ++updateId, my_chat_member: {chat, from, date: 1,
  old_chat_member: {user: bot.botInfo, status: "left"}, new_chat_member: {user: bot.botInfo, status}}});
const NEW_EN = {id: -400, type: "group", title: "New"}, NEW_RU = {id: -401, type: "group", title: "Новая"};
await botStatus(NEW_EN, speaker(31, "en"), "member");
assert.equal(lastText(NEW_EN.id),
  "Hello! I'm the Achivator Bot. I'm here to help you track and reward achievements in your chat. \n" +
  "To get started, make sure to 1) grant me admin rights so that I could read messages and reactions, \n" +
  "and 2) Verify as the chat creator /verify@achivator_bot.\n" +
  "I don't store full message texts, just statistics, and I'm open source! \n" +
  "You can find the source code at https://github.com/seniorsoftwarevlogger/achivator");
await botStatus(NEW_EN, speaker(31, "en"), "administrator");
assert.equal(lastText(NEW_EN.id),
  "Thank you for granting me admin rights! I will now be able to track messages and reactions 🙌\n" +
  "To reward members with jettons for positive reactions, the chat creator runs /jetton <jetton master address>.");
await botStatus(NEW_RU, speaker(32, "ru"), "member");
assert.match(lastText(NEW_RU.id), /^Привет! Я Achivator Bot\./);
await botStatus(NEW_RU, speaker(32, "ru"), "administrator");
assert.match(lastText(NEW_RU.id), /^Спасибо за права администратора!/);

statuses.set(31, "creator");
statuses.set(32, "creator");
await inChat(NEW_EN, speaker(31, "en"), command("/verify"));
assert.equal(lastText(NEW_EN.id), "Verified. You are creator. \nYou can now set Jetton for this chat and access other settings.");
await inChat(NEW_RU, speaker(32, "ru"), command("/verify"));
assert.equal(lastText(NEW_RU.id), "Подтверждено: вы создатель.\nТеперь можно задать жетон для этого чата и открыть остальные настройки.");
await inChat(NEW_RU, speaker(ADMIN, "ru"), command("/verify"));
assert.equal(lastText(NEW_RU.id), "Ваш статус — администратор, а подтвердить бота может только создатель чата.");
const MASTER = "EQ" + "b".repeat(46);
await inChat(NEW_EN, speaker(31, "en"), command(`/jetton ${MASTER}`));
assert.equal(lastText(NEW_EN.id),
  `Reward jetton set: ${MASTER}\n\n` +
  "Next steps:\n" +
  "1. Open the mini app and activate the chat pool (one-time, 0.3 TON).\n" +
  "2. Top up the pool with your jettons.\n" +
  "Members will then earn points for positive reactions and claim them as jettons.");
await inChat(NEW_EN, speaker(33, "en"), command(`/jetton ${MASTER}`));
assert.equal(lastText(NEW_EN.id), "Only the chat creator can set the reward jetton.");
await inChat(NEW_RU, speaker(32, "ru"), command(`/jetton ${MASTER}`));
assert.match(lastText(NEW_RU.id), /^Жетон для наград задан: EQb+\n\nЧто дальше:/);

// /start and /help in a private chat: an introduction with three link buttons,
// in the user's language; a deep-link payload changes nothing.
const lastMessage = chat_id => sent.filter(m => m.chat_id === chat_id).at(-1);
const buttons = m => m.reply_markup.inline_keyboard.flat().map(b => `${b.text} ${b.url}`);
await inChat(DM(41), speaker(41, "en"), command("/start"));
assert.match(lastText(41), /^Hi! I'm Achivator, a loyalty system for Telegram chats\./);
assert.deepEqual(buttons(lastMessage(41)), [
  "Open the app https://t.me/achivator_bot/app",
  "Add to a group https://t.me/achivator_bot?startgroup=true",
  "Setup guide https://achivator.cc/en/help",
]);
await inChat(DM(42), speaker(42, "ru"), command("/start"));
assert.match(lastText(42), /^Привет! Я Achivator — система лояльности для чатов в Telegram\./);
assert.deepEqual(buttons(lastMessage(42)), [
  "Открыть приложение https://t.me/achivator_bot/app",
  "Добавить в группу https://t.me/achivator_bot?startgroup=true",
  "Инструкция по настройке https://achivator.cc/ru/help",
]);
const before = sent.length;
await inChat(DM(41), speaker(41, "en"), command("/start some-unknown-payload"));
await inChat(DM(42), speaker(42, "ru"), command("/help"));
assert.equal(sent.length, before + 2);
assert.match(lastText(41), /^Hi! I'm Achivator/);
assert.match(lastText(42), /^Привет! Я Achivator —/);

// In a group: "Add to group" greets (my_chat_member) and then sends
// /start@achivator_bot true, which must not repeat the greeting.
const ADDED = {id: -700, type: "supergroup", title: "Added"};
const inAdded = text => inChat(ADDED, speaker(51, "en"), command(text));
const count = () => sent.filter(m => m.chat_id === ADDED.id).length;
await botStatus(ADDED, speaker(51, "en"), "member");
assert.match(lastText(ADDED.id), /^Hello! I'm the Achivator Bot\./);
await inAdded("/start@achivator_bot true");
assert.equal(count(), 1, "no setup hint right after the greeting");
await inAdded("/start@other_bot");
assert.equal(count(), 1, "a command for another bot is not ours");
// later, while the bot is still not an admin, a member's /start gets the hint
const realNow = Date.now;
const twoMinutesLater = async fn => { Date.now = () => realNow() + 2 * 60 * 1000; try { await fn(); } finally { Date.now = realNow; } };
await twoMinutesLater(() => inAdded("/start"));
assert.equal(lastText(ADDED.id),
  "To get started, make me an admin, then the chat creator runs /verify@achivator_bot.\n" +
  "Setup guide: https://achivator.cc/en/help");
assert.equal(lastMessage(ADDED.id).link_preview_options?.is_disabled, true);
// once the bot is an admin: the automatic /start stays silent, a typed one gets a pointer
statuses.set(bot.botInfo.id, "administrator");
const counted = count();
await inAdded("/start@achivator_bot true");
assert.equal(count(), counted, "automatic /start in a set-up group is silent");
await inAdded("/start");
assert.equal(lastText(ADDED.id), "I'm already an admin here. Setup guide: https://achivator.cc/en/help");
await inChat(NEW_RU, speaker(32, "ru"), command("/help@achivator_bot"));
assert.equal(lastText(NEW_RU.id), "Я уже администратор в этом чате. Инструкция по настройке: https://achivator.cc/ru/help");
statuses.delete(bot.botInfo.id);
await twoMinutesLater(() => inChat(NEW_RU, speaker(32, "ru"), command("/help")));
assert.match(lastText(NEW_RU.id), /^Чтобы начать, сделайте меня администратором/);

// Blocking and unblocking the bot in a private chat is a my_chat_member update
// too, but there is no group to greet.
const beforeUnblock = sent.length;
await botStatus(DM(71), speaker(71, "en"), "kicked");
await botStatus(DM(71), speaker(71, "en"), "member");
assert.equal(sent.length, beforeUnblock, "no greeting in a private chat");

// A post on behalf of a channel has no sender: English, and no crash.
const CHANNEL = {id: -600, type: "channel", title: "C"};
const postInChannel = text => bot.handleUpdate({update_id: ++updateId, channel_post: {message_id: ++msgId, date: 1, chat: CHANNEL, text}});
await postInChannel("/reward 5");
assert.equal(lastText(CHANNEL.id),
  "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
  "Post as yourself, or run the command in the linked discussion group.");
// Only the channel's admins post in it: a channel post may set the language,
// yet it still cannot /reward (the grant must name who gave it).
await postInChannel("/lang ru");
assert.equal(lastText(CHANNEL.id), "Язык чата: русский. Теперь я пишу здесь по-русски.");
assert.equal((await database.collection("chats").findOne({id: CHANNEL.id})).lang, "ru");
await postInChannel("/reward 5");
assert.equal(lastText(CHANNEL.id), t("ru", "cannotSeeSender"));
await postInChannel("/lang auto");
assert.equal(lastText(CHANNEL.id), "Chat language reset: I reply in the language of each member's Telegram app.");
assert.equal((await database.collection("chats").findOne({id: CHANNEL.id})).lang, undefined);
await postInChannel("/jetton");
assert.equal(lastText(CHANNEL.id), "I cannot see who sent this (a post on behalf of the channel). Post as yourself to run /jetton.");

// ---- Point price announcements ----
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.map(String).join(" "));
const outbox = database.collection("announcements");
const chatsColl = database.collection("chats");
const NOW = new Date("2026-10-01T09:00:00Z");
const minutes = n => new Date(NOW.getTime() + n * 60 * 1000);
const queue = (chat_id, type, params, extra = {}) =>
  outbox.insertOne({chat_id, type, params, created_at: minutes(-1), sent_at: null, claimed_at: null, attempts: 0, ...extra});
const row = _id => cols.get("announcements").docs.find(d => d._id === _id);
const textsTo = chat_id => sent.filter(m => m.chat_id === chat_id).map(m => m.text);
const run = (now = NOW) => bot.announcements.run(now);

// A scheduled decrease in a Russian chat: sent once, even by two overlapping
// runs, with a button to the mini app; then the cancellation, in order.
const PRICE_RU = {id: -800, type: "supergroup", title: "P"};
await chatsColl.insertOne({id: PRICE_RU.id, lang: "ru", point_price: "0.5"});
const EFFECTIVE = new Date("2026-10-05T12:00:00Z");
const {insertedId: scheduled} = await queue(PRICE_RU.id, "price_decrease_scheduled",
  {from: "0.5", to: "0.25", symbol: "MEME", effective_at: EFFECTIVE});
const {insertedId: cancelled} = await queue(PRICE_RU.id, "price_decrease_cancelled",
  {from: "0.5", to: "0.25", symbol: "MEME"}, {created_at: minutes(0)});
const [first, second] = await Promise.all([run(), run()]);
assert.equal(first.sent + second.sent, 2);
assert.deepEqual(textsTo(PRICE_RU.id), [
  "Цена балла снизится 5 октября 2026, 12:00 UTC: 1 балл = 0,5 → 0,25 MEME.\n" +
    "До этого момента уже заработанные баллы можно забрать по текущей цене — откройте мини-приложение.\n" +
    "Чтобы получать личные напоминания, запустите @achivator_bot в личных сообщениях.",
  "Запланированное снижение цены балла отменено: 1 балл по-прежнему стоит 0,5 MEME.",
]);
assert.deepEqual(buttons(sent.find(m => m.chat_id === PRICE_RU.id)), ["Открыть приложение https://t.me/achivator_bot/app"]);
assert.equal(row(scheduled).sent_at.getTime(), NOW.getTime());
assert.equal(row(cancelled).sent_at.getTime(), NOW.getTime());
await run();
assert.equal(textsTo(PRICE_RU.id).length, 2, "a sent announcement is never sent again");

// A chat without a language hears English; a missing symbol reads "jetton".
const PRICE_EN = {id: -801, type: "supergroup", title: "E"};
await queue(PRICE_EN.id, "price_increased", {from: "0.25", to: "1", symbol: null, cancelled_pending: true});
await queue(PRICE_EN.id, "price_decrease_scheduled", {from: "1", to: "0.5", symbol: "USDT", effective_at: EFFECTIVE});
await run();
assert.deepEqual(textsTo(PRICE_EN.id), [
  "The price of a point has gone up: 1 point = 1 jetton (was 0.25).\nThe planned decrease is cancelled.",
  "The price of a point will drop on 5 Oct 2026, 12:00 UTC: 1 point = 1 → 0.5 USDT.\n" +
    "Points already earned can be claimed at the current price until then — open the mini app.\n" +
    "Start @achivator_bot in private to get personal reminders.",
]);
assert.equal(t("en", "priceIncreased", {from: "1", to: "2", symbol: "X", cancelled_pending: false}),
  "The price of a point has gone up: 1 point = 2 X (was 1).");
assert.equal(t("ru", "priceDecreased", {from: "1", to: "0.5", symbol: null}),
  "Цена балла снизилась: 1 балл = 0,5 жетона (было 1).");

// A failed send is retried on the next run, and the chat's later
// announcements wait for it; after 5 failed attempts the bot gives up.
const FLAKY = -802, GONE = -803;
failingChats.add(FLAKY);
const {insertedId: flaky} = await queue(FLAKY, "price_increased", {from: "1", to: "2", symbol: "X", cancelled_pending: false});
const {insertedId: flakyLater} = await queue(FLAKY, "price_decrease_cancelled", {from: "2", to: "1", symbol: "X"},
  {created_at: minutes(0)});
await run();
assert.deepEqual([row(flaky).attempts, row(flaky).claimed_at, row(flaky).sent_at], [1, null, null]);
assert.equal(row(flakyLater).attempts, 0, "the later announcement waits");
await run();
assert.equal(row(flaky).attempts, 2);
failingChats.delete(FLAKY);
await run();
assert.deepEqual(textsTo(FLAKY), [
  "The price of a point has gone up: 1 point = 2 X (was 1).",
  "The planned price decrease is cancelled: 1 point stays 2 X.",
]);
failingChats.add(GONE);
const {insertedId: gone} = await queue(GONE, "price_increased", {from: "1", to: "2", symbol: "X", cancelled_pending: false});
for (let i = 0; i < 7; i++) await run(minutes(i));
assert.equal(sendAttempts.filter(id => id === GONE).length, 5, "gives up after 5 attempts");
assert.equal(row(gone).attempts, 5);
assert.equal(row(gone).sent_at, null);
assert.ok(errors.some(line => line.includes(`to chat ${GONE}: attempt 5 failed, giving up`)));

// A claim left by a run that died mid-send is taken over after 5 minutes.
const {insertedId: stuck} = await queue(-804, "price_decrease_cancelled", {from: "1", to: "0.5", symbol: "X"},
  {claimed_at: minutes(-3)});
await run();
assert.equal(row(stuck).sent_at, null, "a fresh claim belongs to a live run");
await run(minutes(3));
assert.equal(row(stuck).sent_at.getTime(), minutes(3).getTime());
assert.equal(textsTo(-804).length, 1);
// unknown types and malformed params are given up at once; a "will drop"
// announcement for a moment already past is not sent
const {insertedId: odd} = await queue(-805, "price_exploded", {from: "1", to: "2"});
const {insertedId: late} = await queue(-805, "price_decrease_scheduled",
  {from: "1", to: "0.5", symbol: "X", effective_at: minutes(-10)});
await run();
assert.equal(row(odd).attempts, 5);
assert.ok(row(late).sent_at);
assert.equal(textsTo(-805).length, 0);

// The mini app applied a due decrease itself and queued the announcement: the
// same text the bot sends when it applies one.
await queue(-807, "price_decreased", {from: "0.5", to: "0.25", symbol: "MEME"});
await chatsColl.insertOne({id: -808, lang: "ru"});
await queue(-808, "price_decreased", {from: "1", to: "0.75", symbol: null});
await run();
assert.deepEqual(textsTo(-807), ["The price of a point has dropped: 1 point = 0.25 MEME (was 0.5)."]);
assert.deepEqual(textsTo(-808), ["Цена балла снизилась: 1 балл = 0,75 жетона (было 1)."]);

// A due decrease is applied once, with history and an announcement in the
// chat's language, not before effective_at.
const REQUESTED = new Date("2026-09-28T12:00:00Z");
const pending = (price, extra = {}) => ({price, to_default: false, from: "0.5", symbol: "MEME",
  effective_at: EFFECTIVE, requested_at: REQUESTED, by: CREATOR, ...extra});
await chatsColl.updateOne({id: PRICE_RU.id}, {$set: {point_price_pending: pending("0.25", {maturation_days: 4})}});
await run(new Date(EFFECTIVE.getTime() - 1));
const priceRu = () => cols.get("chats").docs.find(d => d.id === PRICE_RU.id);
assert.equal(priceRu().point_price, "0.5", "not before effective_at");
assert.ok(priceRu().point_price_pending);
const after = new Date(EFFECTIVE.getTime() + 30 * 1000);
const applied = await Promise.all([run(after), run(after)]);
assert.equal(applied[0].applied + applied[1].applied, 1);
assert.equal(priceRu().point_price, "0.25");
assert.equal(priceRu().point_price_pending, undefined);
// the maturation snapshotted in the pending is carried into the history entry
assert.deepEqual(priceRu().point_price_history, [{old: "0.5", new: "0.25", at: EFFECTIVE, by: CREATOR, maturation_days: 4}]);
assert.deepEqual(textsTo(PRICE_RU.id).slice(2), ["Цена балла снизилась: 1 балл = 0,25 MEME (было 0,5)."]);
await run(minutes(60 * 24 * 10));
assert.equal(textsTo(PRICE_RU.id).length, 3);

// Back to the platform default: point_price is removed; English chat.
await chatsColl.insertOne({id: PRICE_EN.id, point_price: "1",
  point_price_pending: pending("0.1", {to_default: true, from: "1", symbol: null})});
await run(after);
const priceEn = cols.get("chats").docs.find(d => d.id === PRICE_EN.id);
assert.ok(!("point_price" in priceEn) && !("point_price_pending" in priceEn));
// a pending scheduled before snapshots: no maturation_days (the mini app falls
// back to the chat's current setting)
assert.deepEqual(priceEn.point_price_history, [{old: "1", new: "0.1", at: EFFECTIVE, by: CREATOR}]);
assert.equal(textsTo(PRICE_EN.id).at(-1), "The price of a point has dropped: 1 point = 0.1 jetton (was 1).");

// The mini app replaced the pending decrease after the bot read it: the one
// read is not applied (the new one waits for its own effective_at).
const REPLACED = -806;
await chatsColl.insertOne({id: REPLACED, point_price: "0.5", point_price_pending: pending("0.25")});
const realFind = cols.get("chats").find;
cols.get("chats").find = function (f) {
  const cursor = realFind.call(this, f);
  const replaced = cols.get("chats").docs.find(d => d.id === REPLACED);
  replaced.point_price_pending = pending("0.4", {requested_at: minutes(0), effective_at: minutes(60 * 24 * 7)});
  return cursor;
};
const outcome = await run(after);
cols.get("chats").find = realFind;
assert.equal(outcome.applied, 0);
const replaced = cols.get("chats").docs.find(d => d.id === REPLACED);
assert.equal(replaced.point_price, "0.5");
assert.equal(replaced.point_price_pending.price, "0.4");
assert.equal(replaced.point_price_history, undefined);
assert.equal(textsTo(REPLACED).length, 0);
// The timer runs a pass at once and stops cleanly.
const queuedBefore = sent.length;
await queue(-809, "price_decrease_cancelled", {from: "1", to: "0.5", symbol: "X"});
bot.announcements.start(60 * 60 * 1000);
bot.announcements.start(60 * 60 * 1000); // a second start is a no-op
await settle();
bot.announcements.stop();
assert.equal(sent.length, queuedBefore + 1);
console.error = originalError;

// ---- Private reminders about a price decrease ----
console.error = (...args) => errors.push(args.map(String).join(" "));
const {TelegramError} = await import("telegraf");
const {decimalMul, decimalSub} = await import("../decimal.mjs");
const tgError = (error_code, description, parameters) => () => new TelegramError({ok: false, error_code, description, parameters});
const rewardsColl = database.collection("rewards");
const dmQueue = cols.get("dm_queue");
const usersColl = database.collection("users");
const waits = [];
const runDms = now => bot.dms.run(now, {sleep: async ms => waits.push(ms)});
const dmsTo = user_id => sent.filter(m => m.chat_id === user_id);
const dmRows = source_id => dmQueue.docs.filter(d => String(d.source_id) === String(source_id));
const holdersOf = source_id => dmRows(source_id).map(d => d.user_id).sort((a, b) => a - b);
const giveReward = (chat_id, user_id, pts, claimed_points) =>
  rewardsColl.insertOne({chat_id, user_id, points: pts, ...(claimed_points === undefined ? {} : {claimed_points})});
const pendingDecrease = (from, price, effective_at) =>
  ({price, to_default: false, from, symbol: "MEME", effective_at, requested_at: minutes(-5), by: CREATOR});
const secondsLater = n => new Date(NOW.getTime() + n * 1000);

// Exact decimal arithmetic for the estimate.
assert.equal(0.1 * 3 === 0.3, false, "floats would get this wrong");
assert.equal(decimalMul(3, "0.1"), "0.3");
assert.equal(decimalMul("7", "0.000000001"), "0.000000007");
assert.equal(decimalMul("1.50", "2"), "3");
assert.equal(decimalMul(123456789012345, "0.123456789"), "15241578751714.595060205");
assert.equal(decimalMul(0, "0.1"), "0");
assert.equal(decimalMul("abc", "1"), null);
assert.equal(decimalSub(5, 2), "3");
assert.equal(decimalSub(1, 1), "0");
assert.equal(decimalSub("0.3", "0.1"), "0.2");

// The scheduled announcement in a Russian chat reaches every member with
// unclaimed points there, in their own language (else the chat's), and
// nobody else.
const REMIND = {id: -900, type: "supergroup", title: "Meme Lords"};
const REMIND_AT = new Date("2026-10-08T12:00:00Z");
await chatsColl.insertOne({id: REMIND.id, title: "Meme Lords", lang: "ru", point_price: "0.1",
  point_price_pending: pendingDecrease("0.1", "0.05", REMIND_AT)});
await inChat(REMIND, speaker(1001, "ru"), {text: "привет"});
await inChat(REMIND, speaker(1006, "en-US"), {text: "hi"});
assert.equal((await usersColl.findOne({id: 1001})).lang, "ru");
await inChat(REMIND, user(1006), {text: "no language_code keeps the last one"});
assert.equal((await usersColl.findOne({id: 1006})).lang, "en");
await giveReward(REMIND.id, 1001, 3);          // 3 unclaimed
await giveReward(REMIND.id, 1002, 10, 10);     // all claimed
await giveReward(REMIND.id, 1003, 5, 2);       // 3 unclaimed, never seen: the chat's language
await giveReward(-901, 1004, 50);              // points in another chat only
await giveReward(REMIND.id, 1005, 7);          // blocked the bot
await giveReward(REMIND.id, 1006, 2);          // English app
await giveReward(REMIND.id, 1007, 0);
await botStatus(DM(1005), speaker(1005, "en"), "kicked");
assert.ok((await usersColl.findOne({id: 1005})).dm_blocked_at, "blocking the bot in private is remembered");

const {insertedId: reminder} = await queue(REMIND.id, "price_decrease_scheduled",
  {from: "0.1", to: "0.05", symbol: "MEME", effective_at: REMIND_AT});
await run();
assert.equal(textsTo(REMIND.id).at(-1),
  "Цена балла снизится 8 октября 2026, 12:00 UTC: 1 балл = 0,1 → 0,05 MEME.\n" +
  "До этого момента уже заработанные баллы можно забрать по текущей цене — откройте мини-приложение.\n" +
  "Чтобы получать личные напоминания, запустите @achivator_bot в личных сообщениях.");
assert.deepEqual(holdersOf(reminder), [1001, 1003, 1006]);
assert.ok(row(reminder).fanned_out_at && !("fanout_due" in row(reminder)));
const reminderRow = id => dmRows(reminder).find(d => d.user_id === id);
assert.deepEqual(dmRows(reminder).map(d => [d.user_id, d.lang, d.params.points, d.params.estimate]),
  [[1001, "ru", "3", "0.3"], [1003, "ru", "3", "0.3"], [1006, "en", "2", "0.2"]]);
assert.equal(reminderRow(1001).chat_id, REMIND.id);
assert.equal(reminderRow(1001).kind, "price_decrease_scheduled");

// Idempotent: another pass, and a fan-out run again, queue nobody twice.
await run(minutes(1));
await outbox.updateOne({_id: reminder}, {$set: {fanout_due: true}});
await run(minutes(2));
assert.equal(dmRows(reminder).length, 3);
assert.ok(!("fanout_due" in row(reminder)));

// Delivered with a button to the mini app, spaced 1/DM_RATE_PER_SEC apart.
assert.deepEqual(bot.dms.limits, {ratePerSec: 20, intervalMs: 1000, budget: 20});
assert.deepEqual(await runDms(NOW), {sent: 3, skipped: 0, failed: 0, paused: false});
assert.deepEqual(dmsTo(1001).map(m => m.text), [
  "В чате «Meme Lords» цена балла снизится 8 октября 2026, 12:00 UTC: 1 балл = 0,1 → 0,05 MEME.\n" +
  "У вас 3 балла (≈ 0,3 MEME по текущей цене). Заберите их до этого времени, чтобы сохранить текущий курс."]);
assert.deepEqual(dmsTo(1006).map(m => m.text), [
  "In Meme Lords, the price of a point drops on 8 Oct 2026, 12:00 UTC: 1 point = 0.1 → 0.05 MEME.\n" +
  "You have 2 points (≈ 0.2 MEME at the current price). Claim them before then to keep the current rate."]);
assert.deepEqual(buttons(dmsTo(1006)[0]), ["Open the app https://t.me/achivator_bot/app"]);
assert.deepEqual(buttons(dmsTo(1001)[0]), ["Открыть приложение https://t.me/achivator_bot/app"]);
assert.equal(dmsTo(1003).length, 1);
assert.equal(dmsTo(1002).length + dmsTo(1004).length + dmsTo(1005).length + dmsTo(1007).length, 0);
assert.ok(dmRows(reminder).every(d => d.sent_at && !d.skipped));
assert.deepEqual(await runDms(secondsLater(1)), {sent: 0, skipped: 0, failed: 0, paused: false}, "sent once");
assert.equal(t("en", "dmPriceDecreaseScheduled", {chat_title: null, from: "1", to: "0.5", symbol: null,
  effective_at: REMIND_AT, points: "1", estimate: "1"}),
  "In one of your chats, the price of a point drops on 8 Oct 2026, 12:00 UTC: 1 point = 1 → 0.5 jetton.\n" +
  "You have 1 point (≈ 1 jetton at the current price). Claim them before then to keep the current rate.");

// The process dies between the chat message and queuing the private ones:
// the next pass queues them, and the chat's later announcements wait.
const CRASH = -901;
await chatsColl.insertOne({id: CRASH, title: "Crash", point_price: "1", point_price_pending: pendingDecrease("1", "0.5", REMIND_AT)});
const {insertedId: crashed} = await queue(CRASH, "price_decrease_scheduled",
  {from: "1", to: "0.5", symbol: "MEME", effective_at: REMIND_AT});
const {insertedId: afterCrash} = await queue(CRASH, "price_increased",
  {from: "1", to: "2", symbol: "MEME", cancelled_pending: false}, {created_at: minutes(0)});
const realRewardsFind = rewardsColl.find;
rewardsColl.find = () => { throw new Error("connection reset"); };
await run(minutes(3));
rewardsColl.find = realRewardsFind;
assert.equal(textsTo(CRASH).length, 1, "the chat heard it");
assert.equal(row(crashed).fanout_due, true);
assert.equal(dmRows(crashed).length, 0);
assert.equal(row(afterCrash).sent_at, null, "the chat's next announcement waits for the fan-out");
assert.ok(errors.some(line => line.includes("queuing private messages failed")));
await run(minutes(4));
assert.deepEqual(holdersOf(crashed), [1004]);
assert.ok(row(crashed).fanned_out_at && row(afterCrash).sent_at);
await outbox.updateOne({_id: crashed}, {$set: {fanout_due: true}});
await run(minutes(5));
assert.equal(dmRows(crashed).length, 1, "a crash and a re-run never queue twice");
assert.equal(textsTo(CRASH).length, 2);
await chatsColl.updateOne({id: CRASH}, {$unset: {point_price_pending: ""}}); // the increase replaced it
assert.deepEqual(await runDms(minutes(5)), {sent: 0, skipped: 1, failed: 0, paused: false},
  "a reminder whose decrease is gone is dropped");
assert.equal(dmRows(crashed)[0].skipped, "decrease no longer pending");
assert.equal(dmsTo(1004).length, 0);

// Rate limit: 50 queued reminders go out at most one second's budget per pass.
const BIG = -904;
await chatsColl.insertOne({id: BIG, title: "Big", point_price: "1", point_price_pending: pendingDecrease("1", "0.5", REMIND_AT)});
for (let i = 0; i < 50; i++) await giveReward(BIG, 2000 + i, 1);
const {insertedId: big} = await queue(BIG, "price_decrease_scheduled", {from: "1", to: "0.5", symbol: "MEME", effective_at: REMIND_AT});
await run(minutes(6));
assert.equal(dmRows(big).length, 50);
const bigSent = () => sent.filter(m => m.chat_id >= 2000 && m.chat_id < 2050).length;
waits.length = 0;
const firstPass = await runDms(minutes(6));
assert.equal(firstPass.sent, 20);
assert.equal(bigSent(), 20);
assert.equal(waits.length >= 19, true, "every message waits for its slot");
const gaps = waits.slice(1).map((w, i) => w - waits[i]);
assert.ok(gaps.every(gap => gap > 40 && gap <= 50.001), `50 ms apart at 20/s: ${gaps}`);
assert.equal((await runDms(minutes(6))).sent, 20);
assert.equal(bigSent(), 40);
assert.equal((await runDms(minutes(7))).sent, 10);
assert.equal(bigSent(), 50);
assert.equal(new Set(sent.filter(m => m.chat_id >= 2000 && m.chat_id < 2050).map(m => m.chat_id)).size, 50);

// 403 and "chat not found": skipped, and the user is left out of later
// fan-outs until they start the bot again.
const BLOCK = -905;
const blockPending = (price, at) => chatsColl.updateOne({id: BLOCK}, {$set: {point_price_pending: pendingDecrease("1", price, at)}});
await chatsColl.insertOne({id: BLOCK, title: "Block", point_price: "1"});
await blockPending("0.5", REMIND_AT);
for (const id of [3003, 3004, 3005]) await giveReward(BLOCK, id, 4);
dmFailures.set(3003, tgError(403, "Forbidden: bot was blocked by the user"));
dmFailures.set(3004, tgError(400, "Bad Request: chat not found"));
const {insertedId: block1} = await queue(BLOCK, "price_decrease_scheduled", {from: "1", to: "0.5", symbol: "MEME", effective_at: REMIND_AT});
await run(minutes(8));
assert.deepEqual(await runDms(minutes(8)), {sent: 1, skipped: 2, failed: 0, paused: false});
assert.deepEqual(dmRows(block1).map(d => [d.user_id, d.skipped ?? null]), [[3003, "unreachable"], [3004, "unreachable"], [3005, null]]);
assert.match(dmRows(block1)[0].last_error, /blocked by the user/);
assert.ok((await usersColl.findOne({id: 3003})).dm_blocked_at);
assert.ok((await usersColl.findOne({id: 3004})).dm_blocked_at);
dmFailures.delete(3003);
dmFailures.delete(3004);
const LATER = new Date("2026-10-09T12:00:00Z");
await blockPending("0.4", LATER);
const {insertedId: block2} = await queue(BLOCK, "price_decrease_scheduled", {from: "1", to: "0.4", symbol: "MEME", effective_at: LATER});
await run(minutes(9));
assert.deepEqual(holdersOf(block2), [3005], "blocked users are left out");
await inChat(DM(3003), speaker(3003, "en"), command("/start"));
assert.match(lastText(3003), /^Hi! I'm Achivator/);
await botStatus(DM(3004), speaker(3004, "en"), "member");
assert.equal((await usersColl.findOne({id: 3003})).dm_blocked_at, undefined, "/start clears it");
assert.equal((await usersColl.findOne({id: 3004})).dm_blocked_at, undefined, "unblocking clears it");
const LATEST = new Date("2026-10-10T12:00:00Z");
await blockPending("0.3", LATEST);
const {insertedId: block3} = await queue(BLOCK, "price_decrease_scheduled", {from: "1", to: "0.3", symbol: "MEME", effective_at: LATEST});
await run(minutes(10));
assert.deepEqual(holdersOf(block3), [3003, 3004, 3005]);
// the replaced decreases' reminders still queued are dropped, the latest goes out
await runDms(minutes(10));
assert.equal(dmRows(block2)[0].skipped, "decrease no longer pending");
assert.deepEqual([3003, 3004, 3005].map(id => dmsTo(id).filter(m => m.text.startsWith("In Block")).length), [1, 1, 2]);

// A transient failure is retried with backoff and given up after 5 attempts.
const FLAKY_DM = 3010;
await dmQueue.insertOne({user_id: FLAKY_DM, chat_id: BLOCK, source_id: "manual", kind: "price_decrease_cancelled",
  params: {chat_title: "Block", from: "1", to: "0.5", symbol: "MEME"}, lang: "en", created_at: minutes(11),
  send_after: minutes(11), sent_at: null, claimed_at: null, attempts: 0, last_error: null});
const flakyDm = () => dmQueue.docs.find(d => d.user_id === FLAKY_DM);
dmFailures.set(FLAKY_DM, tgError(502, "Bad Gateway"));
assert.equal((await runDms(minutes(11))).failed, 1);
assert.deepEqual([flakyDm().attempts, flakyDm().claimed_at, flakyDm().sent_at], [1, null, null]);
assert.equal(flakyDm().send_after.getTime(), minutes(11).getTime() + 30 * 1000);
await runDms(minutes(11.2));
assert.equal(flakyDm().attempts, 1, "not before send_after");
for (let i = 12; i < 30; i += 3) await runDms(minutes(i));
assert.equal(sendAttempts.filter(id => id === FLAKY_DM).length, 5);
assert.deepEqual([flakyDm().attempts, flakyDm().sent_at, flakyDm().last_error], [5, null, "Bad Gateway"]);
assert.ok(errors.some(line => line.includes(`to ${FLAKY_DM}: attempt 5 failed, giving up`)));
dmFailures.delete(FLAKY_DM);

// Cancelled: only members who got the reminder hear it; reminders still
// queued are dropped instead. A chat without a language writes English.
const CANCEL = {id: -906, type: "supergroup", title: "Cancel Club"};
await chatsColl.insertOne({id: CANCEL.id, title: "Cancel Club", point_price: "0.5", point_price_pending: pendingDecrease("0.5", "0.25", REMIND_AT)});
for (const id of [4001, 4002, 4003]) await giveReward(CANCEL.id, id, 2);
await inChat(CANCEL, speaker(4003, "ru"), {text: "привет"});
const {insertedId: toCancel} = await queue(CANCEL.id, "price_decrease_scheduled",
  {from: "0.5", to: "0.25", symbol: "MEME", effective_at: REMIND_AT}, {created_at: minutes(29)});
await run(minutes(30));
assert.deepEqual(dmRows(toCancel).map(d => [d.user_id, d.lang]), [[4001, "en"], [4002, "en"], [4003, "ru"]]);
dmFailures.set(4002, tgError(403, "Forbidden: bot can't initiate conversation with a user"));
dmFailures.set(4003, tgError(500, "Internal Server Error"));
await runDms(minutes(30));
dmFailures.delete(4002);
dmFailures.delete(4003);
await giveReward(CANCEL.id, 4004, 9); // earned after the reminders went out
await chatsColl.updateOne({id: CANCEL.id}, {$unset: {point_price_pending: ""}});
const {insertedId: cancelRow} = await queue(CANCEL.id, "price_decrease_cancelled",
  {from: "0.5", to: "0.25", symbol: "MEME"}, {created_at: minutes(31)});
await run(minutes(32));
assert.equal(textsTo(CANCEL.id).at(-1), "The planned price decrease is cancelled: 1 point stays 0.5 MEME.");
assert.deepEqual(holdersOf(cancelRow), [4001]);
assert.equal(dmRows(toCancel).find(d => d.user_id === 4003).skipped, "cancelled");
await outbox.updateOne({_id: cancelRow}, {$set: {fanout_due: true}});
await run(minutes(33));
assert.deepEqual(holdersOf(cancelRow), [4001], "idempotent");
await runDms(minutes(34));
assert.deepEqual(dmsTo(4001).map(m => m.text), [
  "In Cancel Club, the price of a point drops on 8 Oct 2026, 12:00 UTC: 1 point = 0.5 → 0.25 MEME.\n" +
  "You have 2 points (≈ 1 MEME at the current price). Claim them before then to keep the current rate.",
  "In Cancel Club, the planned price drop is cancelled; 1 point stays 0.5 MEME."]);
assert.deepEqual([4002, 4003, 4004].map(id => dmsTo(id).length), [0, 0, 0]);
assert.equal(t("ru", "dmPriceDecreaseCancelled", {chat_title: "Клуб", from: "0.5", symbol: null}),
  "В чате «Клуб» запланированное снижение цены балла отменено: 1 балл по-прежнему стоит 0,5 жетона.");
// a cancellation whose decrease was never announced to the chat reminds nobody
const {insertedId: orphanCancel} = await queue(-907, "price_decrease_cancelled", {from: "1", to: "0.5", symbol: "X"});
await run(minutes(35));
assert.ok(row(orphanCancel).fanned_out_at);
assert.equal(dmRows(orphanCancel).length, 0);

// 429: the whole queue pauses for retry_after and the row is rescheduled.
const insertDm = (user_id, at) => dmQueue.insertOne({user_id, chat_id: BLOCK, source_id: "manual-429", kind: "price_decrease_cancelled",
  params: {chat_title: "Block", from: "1", to: "0.5", symbol: "MEME"}, lang: "en", created_at: at,
  send_after: at, sent_at: null, claimed_at: null, attempts: 0, last_error: null});
await insertDm(5001, minutes(40));
await insertDm(5002, minutes(40));
dmFailures.set(5001, tgError(429, "Too Many Requests: retry after 7", {retry_after: 7}));
const limited = await runDms(minutes(40));
assert.deepEqual(limited, {sent: 0, skipped: 0, failed: 0, paused: true});
const dm5001 = dmQueue.docs.find(d => d.user_id === 5001);
assert.deepEqual([dm5001.attempts, dm5001.claimed_at, dm5001.sent_at], [0, null, null]);
assert.ok(dm5001.send_after.getTime() >= minutes(40).getTime() + 7000);
assert.equal(sendAttempts.filter(id => id === 5002).length, 0, "the rest of the queue waits");
dmFailures.delete(5001);
assert.equal((await runDms(new Date(minutes(40).getTime() + 3000))).paused, true);
assert.equal(sendAttempts.filter(id => id === 5001 || id === 5002).length, 1);
assert.equal((await runDms(new Date(minutes(40).getTime() + 8000))).sent, 2);
assert.deepEqual([dmsTo(5001).length, dmsTo(5002).length], [1, 1]);

// The DM timer starts once and stops cleanly.
bot.dms.start(60 * 60 * 1000);
bot.dms.start(60 * 60 * 1000);
await settle();
bot.dms.stop();
console.error = originalError;

// A missing key falls back to English, an unknown key does not throw.
assert.equal(t("de", "jettonWhere"), "Run this command in a group or channel.");
console.error = () => {};
assert.equal(t("ru", "noSuchKey"), "noSuchKey");
console.error = originalError;

// ---- Subscription (Telegram Stars) ----
// Off by default: every test above ran with it off. Switched on, a chat's
// trial starts with /jetton, points stop after the trial and the grace days,
// a payment by the creator resumes them, claims never depend on it.
process.env.SUBSCRIPTIONS_ENABLED = "true";
const apiCalls = [];
const plainCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method, payload) {
  apiCalls.push({method, payload});
  return plainCallApi.call(this, method, payload);
};
const callsOf = method => apiCalls.filter(c => c.method === method).map(c => c.payload);
const DAY = 24 * 60 * 60 * 1000;
const SUB = {id: -600, type: "supergroup", title: "Paid Club"};
const SUB_OWNER = 6001, SUB_FAN = 6002, SUB_WRITER = 6003, SUB_HEIR = 6004;
statuses.set(SUB_OWNER, "creator");
const subChat = () => chatsColl.docs.find(d => d.id === SUB.id);
const subPoints = id => cols.get("rewards").docs.find(d => d.chat_id === SUB.id && d.user_id === id)?.points ?? 0;
const subReact = async () => {
  const message_id = ++msgId;
  await bot.handleUpdate({update_id: ++updateId, message: {message_id, date: 1, chat: SUB, from: user(SUB_WRITER), text: "take this"}});
  await bot.handleUpdate({update_id: ++updateId, message_reaction: {chat: SUB, message_id, user: user(SUB_FAN), date: 1,
    old_reaction: [], new_reaction: [{type: "emoji", emoji: "👍"}]}});
};
const subPay = (from, charge, extra = {}) => bot.handleUpdate({update_id: ++updateId, message: {
  message_id: ++msgId, date: 1, chat: {id: from, type: "private"}, from: user(from),
  successful_payment: {currency: "XTR", total_amount: 300, invoice_payload: `sub:${SUB.id}`,
    telegram_payment_charge_id: charge, provider_payment_charge_id: "",
    subscription_expiration_date: Math.floor((Date.now() + 30 * DAY) / 1000), is_recurring: true, ...extra}}});
const preCheckout = (from, payload = `sub:${SUB.id}`) => bot.handleUpdate({update_id: ++updateId, pre_checkout_query: {
  id: `q${updateId}`, from: user(from), currency: "XTR", total_amount: 300, invoice_payload: payload}});

await inChat(SUB, speaker(SUB_OWNER, "en"), command("/jetton EQ" + "b".repeat(46)));
assert.ok(subChat().trial_started_at instanceof Date, "/jetton starts the trial");
const trialStart = subChat().trial_started_at;
for (let i = 0; i < 5; i++) await inChat(SUB, user(SUB_FAN), {text: `hello ${i}`});
await subReact();
assert.equal(subPoints(SUB_WRITER), 1, "the trial accrues");
await inChat(SUB, speaker(SUB_OWNER, "en"), command("/jetton EQ" + "b".repeat(46)));
assert.equal(subChat().trial_started_at.getTime(), trialStart.getTime(), "a trial never restarts");

// Two days before the trial ends the creator is reminded, once.
const sentBefore = sent.length;
await chatsColl.updateOne({id: SUB.id}, {$set: {trial_started_at: new Date(Date.now() - 12 * DAY)}});
await bot.subscriptions.run(new Date());
await bot.subscriptions.run(new Date());
const reminders = sent.slice(sentBefore).filter(m => m.chat_id === SUB_OWNER);
assert.equal(reminders.length, 1);
assert.match(reminders[0].text, /^The free trial of Paid Club ends on /);

// Past the trial and the grace days: nothing accrues, /reward is refused,
// the chat hears it once.
await chatsColl.updateOne({id: SUB.id}, {$set: {trial_started_at: new Date(Date.now() - 20 * DAY)}});
await inChat(SUB, speaker(SUB_OWNER, "en"), command("/verify")); // drops the cached chat config
await subReact();
assert.equal(subPoints(SUB_WRITER), 1);
assert.equal(lastNoReward(), `no reward: subscription expired, points are paused (chat ${SUB.id}, message ${msgId}, from ${SUB_FAN})`);
await inChat(SUB, speaker(SUB_OWNER, "en"), command("/reward 6003 5"));
assert.match(textsTo(SUB.id).at(-1), /^Points are paused in this chat/);
assert.equal(subPoints(SUB_WRITER), 1);
await bot.subscriptions.run(new Date());
await bot.subscriptions.run(new Date());
assert.equal(textsTo(SUB.id).filter(text => text.startsWith("Achivator no longer counts points")).length, 1);
assert.ok(subChat().sub_stop_announced_for);

// Only the current creator may pay; anything else is refused before payment.
await preCheckout(SUB_FAN);
assert.deepEqual(callsOf("answerPreCheckoutQuery").at(-1),
  {pre_checkout_query_id: `q${updateId}`, ok: false, error_message: "Only the current creator of the chat can pay for its subscription."});
await preCheckout(SUB_OWNER, "something else");
assert.equal(callsOf("answerPreCheckoutQuery").at(-1).ok, false);
await preCheckout(SUB_OWNER);
assert.deepEqual({...callsOf("answerPreCheckoutQuery").at(-1)}, {pre_checkout_query_id: `q${updateId}`, ok: true, error_message: undefined});

// The payment resumes points and the chat hears it; a redelivered payment
// changes nothing.
await subPay(SUB_OWNER, "ch-1", {is_first_recurring: true});
await subPay(SUB_OWNER, "ch-1", {is_first_recurring: true});
assert.equal(cols.get("payments").docs.filter(d => d.chat_id === SUB.id).length, 1);
assert.deepEqual({...subChat().subscription, at: null}, {payer_id: SUB_OWNER, charge_id: "ch-1", recurring: true, stars: 300, at: null});
assert.ok(subChat().paid_until.getTime() > Date.now() + 29 * DAY);
assert.equal(subChat().sub_stop_announced_for, undefined);
assert.equal(textsTo(SUB.id).at(-1), "Achivator counts points in this chat again: the subscription is paid. Thank you!");
assert.match(textsTo(SUB_OWNER).at(-1), /^Thank you! Points in Paid Club are paid until .* and renew every month\.$/);
await subReact();
assert.equal(subPoints(SUB_WRITER), 2, "paid again");

// A renewal extends paid_until and keeps the subscription's first charge id.
const firstUntil = subChat().paid_until.getTime();
await subPay(SUB_OWNER, "ch-2", {subscription_expiration_date: Math.floor((Date.now() + 60 * DAY) / 1000)});
assert.equal(subChat().subscription.charge_id, "ch-1");
assert.ok(subChat().paid_until.getTime() > firstUntil);
// a renewing subscription gets no "ends soon" reminder
const beforeRenewingPass = sent.length;
await chatsColl.updateOne({id: SUB.id}, {$set: {paid_until: new Date(Date.now() + DAY)}});
await bot.subscriptions.run(new Date());
assert.equal(sent.slice(beforeRenewingPass).filter(m => m.chat_id === SUB_OWNER).length, 0);

// A new creator: the old payer's renewal is cancelled, what they paid stays
// with the chat, and they hear why.
statuses.set(SUB_HEIR, "creator");
const paidUntilBeforeHandover = subChat().paid_until.getTime();
await inChat(SUB, speaker(SUB_HEIR, "en"), command("/verify"));
assert.deepEqual(callsOf("editUserStarSubscription").at(-1), {user_id: SUB_OWNER, telegram_payment_charge_id: "ch-1", is_canceled: true});
assert.equal(subChat().subscription.recurring, false);
assert.equal(subChat().creator, SUB_HEIR);
assert.equal(subChat().paid_until.getTime(), paidUntilBeforeHandover);
assert.match(textsTo(SUB_OWNER).at(-1), /^You are no longer the creator of Paid Club/);
// the old creator can no longer pay for it
await preCheckout(SUB_OWNER);
assert.equal(callsOf("answerPreCheckoutQuery").at(-1).ok, false);
// the heir subscribes from their own account
await subPay(SUB_HEIR, "ch-3", {is_first_recurring: true});
assert.deepEqual([subChat().subscription.payer_id, subChat().subscription.charge_id], [SUB_HEIR, "ch-3"]);
statuses.delete(SUB_OWNER);
statuses.delete(SUB_HEIR);

// Off again: every chat accrues, as before subscriptions existed.
delete process.env.SUBSCRIPTIONS_ENABLED;
Telegram.prototype.callApi = plainCallApi;

// ---- Startup environment ----
// Production needs the database, the token and the webhook domain; without
// Grafana it starts with a warning. Development needs nothing.
const {checkEnv} = await import("../env.mjs");
const PROD = {NODE_ENV: "production", MONGODB_URI: "mongodb://db", ACHIVATOR_TOKEN: "1:x", WEBHOOK_URL: "bot.example.com"};
assert.deepEqual(checkEnv(PROD),
  {missing: [], warnings: ["Metrics disabled, missing ENV var: ACHIVATOR_GRAFANA_USER_ID, ACHIVATOR_GRAFANA_TOKEN"]});
assert.deepEqual(checkEnv({...PROD, ACHIVATOR_GRAFANA_USER_ID: "1", ACHIVATOR_GRAFANA_TOKEN: "t"}), {missing: [], warnings: []});
assert.deepEqual(checkEnv({...PROD, ACHIVATOR_GRAFANA_USER_ID: "1"}).warnings,
  ["Metrics disabled, missing ENV var: ACHIVATOR_GRAFANA_TOKEN"]);
assert.deepEqual(checkEnv({NODE_ENV: "production", ACHIVATOR_GRAFANA_USER_ID: "1", ACHIVATOR_GRAFANA_TOKEN: "t"}).missing,
  ["MONGODB_URI", "ACHIVATOR_TOKEN", "WEBHOOK_URL"]);
assert.deepEqual(checkEnv({...PROD, WEBHOOK_URL: ""}).missing, ["WEBHOOK_URL"]);
assert.deepEqual(checkEnv({NODE_ENV: "development"}), {missing: [], warnings: []});

console.log = originalLog;
console.log("ALL OK");
// pending achievement clean-up timers would keep the process alive for 30 s
process.exit(0);
