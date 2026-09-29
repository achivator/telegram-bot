// Smoke test: drives real Telegram updates through createBot with an
// in-memory stand-in for the handful of MongoDB operations the bot uses.
import assert from "node:assert/strict";
import {Telegram} from "telegraf";

const sent = [];
const commandMenus = [];
// chat member status by user id ("member" when unset); "error" makes the
// lookup fail, as it does for an anonymous admin
const statuses = new Map();
Telegram.prototype.callApi = async function (method, payload) {
  if (method === "getChatMember") {
    const status = statuses.get(payload.user_id) ?? "member";
    if (status === "error") throw new Error("Bad Request: user not found");
    return {status, user: {id: payload.user_id, first_name: `U${payload.user_id}`}};
  }
  if (method === "sendMessage") { sent.push(payload); return {message_id: 1}; }
  if (method === "setMyCommands") commandMenus.push(payload);
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

// Command menus: English by default and Russian, both with /lang.
assert.deepEqual(commandMenus.map(menu => menu.language_code), [undefined, "ru"]);
assert.deepEqual(commandMenus[0].commands.slice(0, 3), [
  {command: "verify", description: "Verify creator status"},
  {command: "jetton", description: "Set the reward jetton for this chat (creators)"},
  {command: "reward", description: "Grant points to a member (admins)"},
]);
assert.ok(commandMenus.every(menu => menu.commands.some(c => c.command === "lang")));
assert.match(commandMenus[1].commands[0].description, /создатель/);

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
assert.equal(lastText(MIXED.id), `I don't speak "de" yet. Available: /lang ru or /lang en`);
await inChat(MIXED, speaker(ADMIN, "en"), command("/lang RU"));
assert.equal(lastText(MIXED.id), "Язык чата: русский. Теперь я пишу здесь по-русски.");
assert.equal((await database.collection("chats").findOne({id: MIXED.id})).lang, "ru");
await inChat(MIXED, speaker(16, "en"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /^Поздравляем, U16!/);
await inChat(MIXED, speaker(ADMIN, "en"), command("/reward 5"));
assert.match(lastText(MIXED.id), /^В этом чате ещё не задан жетон/);
await inChat(MIXED, speaker(12, "en"), command("/lang"));
assert.equal(lastText(MIXED.id), "Язык чата: русский.\nИзменить (создатель и администраторы): /lang ru или /lang en");
await inChat(MIXED, speaker(ADMIN, "ru"), command("/lang en"));
assert.equal(lastText(MIXED.id), "Chat language set: English. I will write here in English.");
await inChat(MIXED, speaker(17, "ru"), {sticker: {file_id: "s"}});
await settle();
assert.match(lastText(MIXED.id), /New achievement unlocked/);

// A reward confirmation in a Russian group, with Russian plurals.
statuses.set(CREATOR, "creator");
await send(user(CREATOR), command("/lang ru"));
const meme = await send(user(AUTHOR), {text: "meme"});
await send(user(CREATOR), {...command("/reward 5 мем"), reply_to_message: {message_id: meme, date: 1, chat: CHAT, from: user(AUTHOR), text: "meme"}});
assert.equal(lastText(CHAT.id), "U3: +5 баллов — мем\nИх можно будет забрать жетонами в мини-приложении, когда пройдёт срок созревания.");
assert.deepEqual([1, 2, 5, 11, 21, 22, 112].map(n => t("ru", "rewardGranted", n, "X").split("\n")[0]),
  ["X: +1 балл", "X: +2 балла", "X: +5 баллов", "X: +11 баллов", "X: +21 балл", "X: +22 балла", "X: +112 баллов"]);
assert.equal(t("en", "rewardGranted", 5, "U3", null),
  "+5 points to U3\nThey can claim them as jetton in the mini app once they mature.");
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

// A post on behalf of a channel has no sender: English, and no crash.
const CHANNEL = {id: -600, type: "channel", title: "C"};
const postInChannel = text => bot.handleUpdate({update_id: ++updateId, channel_post: {message_id: ++msgId, date: 1, chat: CHANNEL, text}});
await postInChannel("/reward 5");
assert.equal(lastText(CHANNEL.id),
  "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
  "Post as yourself, or run the command in the linked discussion group.");
await postInChannel("/lang ru");
assert.equal(lastText(CHANNEL.id), t("en", "cannotSeeSender"));
await postInChannel("/jetton");
assert.equal(lastText(CHANNEL.id), "I cannot see who sent this (a post on behalf of the channel). Post as yourself to run /jetton.");

// A missing key falls back to English, an unknown key does not throw.
assert.equal(t("de", "jettonWhere"), "Run this command in a group or channel.");
const originalError = console.error;
console.error = () => {};
assert.equal(t("ru", "noSuchKey"), "noSuchKey");
console.error = originalError;

console.log = originalLog;
console.log("ALL OK");
// pending achievement clean-up timers would keep the process alive for 30 s
process.exit(0);
