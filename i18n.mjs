import {fmt, bold, link} from "telegraf/format";

// User-facing texts of the bot in every supported language. Log lines stay in
// English and are not here. A key missing from a language falls back to
// English, so a new message can ship before its translation.
//
// The English wording of the greeting, the admin-rights thanks, /verify,
// /jetton and the "cannot see who sent this" replies is quoted by the mini
// app setup guide: change it there too, or not at all.

export const LANGUAGES = ["en", "ru"];

// Maps a Telegram `language_code` ("ru", "uk", "en-US", undefined) to one of
// LANGUAGES. Only Russian Telegram apps get Russian; every other language,
// Ukrainian, Belarusian and Kazakh included, gets English.
export function langFromCode(code) {
  const base = String(code || "").toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(base) ? base : "en";
}

// 1 балл, 2 балла, 5 баллов, 11 баллов, 21 балл
function ruPlural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Point price announcements show the moment of a change explicitly in UTC:
// "5 Oct 2026, 12:00 UTC", "5 октября 2026, 12:00 UTC".
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RU_MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function utcDateTime(value, months) {
  const date = new Date(value);
  const time = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${time} UTC`;
}

// Prices arrive as canonical decimal strings ("0.25"); Russian writes "0,25".
function ruDecimal(value) {
  return String(value).replace(".", ",");
}

// "В чате «Мемы»", or "В одном из ваших чатов" when the title is unknown
function ruInChat(title) {
  return title ? `В чате «${title}»` : "В одном из ваших чатов";
}

// 1 балл, 3 балла, 5 баллов; a fraction takes "балла" (2,5 балла)
function ruPointsWord(points) {
  const n = Number(points);
  return Number.isInteger(n) ? ruPlural(n, "балл", "балла", "баллов") : "балла";
}

const en = {
  languageName: "English",
  member: "member",
  memberStatus: status => status,

  achievementUnlocked: (who, achievement, appUrl) =>
    fmt`Hey, ${who}! New achievement unlocked: ${bold(achievement)}! Check it out in ${link(
      "the mini app",
      appUrl,
    )} by @achivator_bot 🎉`,

  greeting:
    "Hello! I'm the Achivator Bot. I'm here to help you track and reward achievements in your chat. \n" +
    "To get started, make sure to 1) grant me admin rights so that I could read messages and reactions, \n" +
    "and 2) Verify as the chat creator /verify@achivator_bot.\n" +
    "I don't store full message texts, just statistics, and I'm open source! \n" +
    "You can find the source code at https://github.com/seniorsoftwarevlogger/achivator",
  adminThanks:
    "Thank you for granting me admin rights! I will now be able to track messages and reactions 🙌\n" +
    "To reward members with jettons for positive reactions, the chat creator runs /jetton <jetton master address>.",

  // /start and /help in a private chat, with buttons below the text
  welcome:
    "Hi! I'm Achivator, a loyalty system for Telegram chats.\n\n" +
    "Members react to helpful messages, and their authors earn points. Points are claimed as the chat's " +
    "own jetton, and along the way members unlock achievements.\n\n" +
    "To set it up: add me to your group, make me an admin and follow the setup guide.",
  buttonOpenApp: "Open the app",
  buttonAddToGroup: "Add to a group",
  buttonSetupGuide: "Setup guide",
  setupGuideUrl: "https://achivator.cc/en/help",
  // /start and /help in a group
  startGroupSetup: guideUrl =>
    "To get started, make me an admin, then the chat creator runs /verify@achivator_bot.\n" +
    `Setup guide: ${guideUrl}`,
  startGroupReady: guideUrl => `I'm already an admin here. Setup guide: ${guideUrl}`,

  cannotSeeSender:
    "I cannot see who sent this (anonymous admin or a post on behalf of the channel).\n" +
    "Post as yourself, or run the command in the linked discussion group.",

  rewardAdminsOnly: "Only the chat creator and admins can grant rewards (I must be an admin to check).",
  rewardWhere: "Run /reward in a group or channel where I am an admin.",
  rewardNoJetton: "This chat has no reward jetton yet. The creator should run /jetton <master address> first.",
  rewardNoAuthor:
    "That message has no author I can reward (a bot or an anonymous channel post).\n" +
    "Grant by id instead: /reward <user id> <points> [reason]",
  rewardCannotResolve: username => `I cannot resolve ${username}: they must be a member of this chat.`,
  rewardUnknownUsername: username =>
    `I haven't seen ${username} in this chat yet — reply to their message instead: /reward <points> [reason]`,
  rewardUsage: maxPoints =>
    "Grant points to a member:\n" +
    "• as a reply: /reward <points> [reason]\n" +
    "• by mention or id: /reward <@username or user id> <points> [reason]\n" +
    `Points: 1…${maxPoints}. Only the creator and admins (including admin bots) can grant.`,
  rewardGranted: (points, name, reason) =>
    `+${points} points to ${name}` +
    (reason ? ` — ${reason}` : "") +
    "\nThey can claim them as jetton in the mini app once they mature.",

  jettonWhere: "Run this command in a group or channel.",
  jettonCreatorOnly: "Only the chat creator can set the reward jetton.",
  jettonCannotSeeSender: "I cannot see who sent this (a post on behalf of the channel). Post as yourself to run /jetton.",
  jettonCurrent: master =>
    `Current reward jetton: ${master}\n\n` +
    "Members earn points for positive reactions and claim them as jettons in the mini app.\n" +
    "To change the jetton: /jetton <master address>",
  jettonNotSet:
    "No reward jetton set for this chat yet.\n\n" +
    "To enable rewards: /jetton <jetton master address>\n" +
    "You will need the jettons in your wallet to top up the pool later.",
  jettonInvalid: "That does not look like a TON jetton master address (EQ... / UQ... / 0:...).",
  jettonSet: master =>
    `Reward jetton set: ${master}\n\n` +
    "Next steps:\n" +
    "1. Open the mini app and activate the chat pool (one-time, 0.3 TON).\n" +
    "2. Top up the pool with your jettons.\n" +
    "Members will then earn points for positive reactions and claim them as jettons.",

  verifyWhere: "Run /verify in the group you created.",
  verifyCannotCheck: "I cannot check your status here. Make sure I am an admin of this chat.",
  verifyNotCreator: status => `You are ${status}, but only chat creators can verify the bot.`,
  verified: status => `Verified. You are ${status}. \nYou can now set Jetton for this chat and access other settings.`,

  langCurrent: languageName => `Chat language: ${languageName}.`,
  langNotSet: "Chat language is not set: I reply in the language of each member's Telegram app.",
  langUsage: "To change it (creator and admins): /lang ru or /lang en",
  langUnknown: value => `I don't speak "${value}" yet. Available: /lang ru or /lang en`,
  langSet: languageName => `Chat language set: ${languageName}. I will write here in English.`,
  langAdminsOnly: "Only the chat creator and admins can change the chat language (I must be an admin to check).",
  langPrivate:
    "In a private chat I use the language of your Telegram app.\n" +
    "To set the language of a group, run /lang ru or /lang en there (creator and admins).",

  migrationCompleted: "Migration completed",

  // Point price changes made in the mini app. `symbol` is the reward jetton's
  // symbol, null when unknown.
  priceDecreaseScheduled: ({from, to, symbol, effective_at}) =>
    `The price of a point will drop on ${utcDateTime(effective_at, EN_MONTHS)}: ` +
    `1 point = ${from} → ${to} ${symbol || "jetton"}.\n` +
    "Points already earned can be claimed at the current price until then — open the mini app.\n" +
    "Start @achivator_bot in private to get personal reminders.",
  priceDecreased: ({from, to, symbol}) =>
    `The price of a point has dropped: 1 point = ${to} ${symbol || "jetton"} (was ${from}).`,
  priceIncreased: ({from, to, symbol, cancelled_pending}) =>
    `The price of a point has gone up: 1 point = ${to} ${symbol || "jetton"} (was ${from}).` +
    (cancelled_pending ? "\nThe planned decrease is cancelled." : ""),
  priceDecreaseCancelled: ({from, symbol}) =>
    `The planned price decrease is cancelled: 1 point stays ${from} ${symbol || "jetton"}.`,

  // The same changes, in private to each member with unclaimed points.
  // `points` and `estimate` (points × the current price) are decimal strings.
  dmPriceDecreaseScheduled: ({chat_title, from, to, symbol, effective_at, points, estimate}) =>
    `In ${chat_title || "one of your chats"}, the price of a point drops on ${utcDateTime(effective_at, EN_MONTHS)}: ` +
    `1 point = ${from} → ${to} ${symbol || "jetton"}.\n` +
    `You have ${points} ${points === "1" ? "point" : "points"} ` +
    `(≈ ${estimate} ${symbol || "jetton"} at the current price). ` +
    "Claim them before then to keep the current rate.",
  dmPriceDecreaseCancelled: ({chat_title, from, symbol}) =>
    `In ${chat_title || "one of your chats"}, the planned price drop is cancelled; ` +
    `1 point stays ${from} ${symbol || "jetton"}.`,

  commandStart: "What Achivator is and how to set it up",
  commandHelp: "Setup guide",
  commandVerify: "Verify creator status",
  commandJetton: "Set the reward jetton for this chat (creators)",
  commandReward: "Grant points to a member (admins)",
  commandLang: "Set the chat language: /lang ru or /lang en (admins)",
};

const RU_MEMBER_STATUSES = {
  creator: "создатель",
  administrator: "администратор",
  member: "участник",
  restricted: "участник с ограничениями",
  left: "не участник",
  kicked: "заблокирован",
};

const ru = {
  languageName: "русский",
  member: "участник",
  memberStatus: status => RU_MEMBER_STATUSES[status] || status,

  achievementUnlocked: (who, achievement, appUrl) =>
    fmt`Поздравляем, ${who}! Новое достижение: ${bold(achievement)}! Загляните в ${link(
      "мини-приложение",
      appUrl,
    )} @achivator_bot 🎉`,

  greeting:
    "Привет! Я Achivator Bot. Я помогаю отслеживать и награждать достижения в вашем чате.\n" +
    "Чтобы начать: 1) дайте мне права администратора, чтобы я видел сообщения и реакции,\n" +
    "и 2) подтвердите, что вы создатель чата: /verify@achivator_bot.\n" +
    "Я не храню тексты сообщений, только статистику, и мой код открыт!\n" +
    "Исходный код: https://github.com/seniorsoftwarevlogger/achivator",
  adminThanks:
    "Спасибо за права администратора! Теперь я вижу сообщения и реакции 🙌\n" +
    "Чтобы награждать участников жетонами за положительные реакции, создатель чата выполняет " +
    "/jetton <адрес мастер-контракта жетона>.",

  welcome:
    "Привет! Я Achivator — система лояльности для чатов в Telegram.\n\n" +
    "Участники ставят реакции на полезные сообщения, а их авторы получают баллы. Баллы можно забрать " +
    "собственным жетоном чата, а по пути участники открывают достижения.\n\n" +
    "Как подключить: добавьте меня в группу, сделайте администратором и следуйте инструкции по настройке.",
  buttonOpenApp: "Открыть приложение",
  buttonAddToGroup: "Добавить в группу",
  buttonSetupGuide: "Инструкция по настройке",
  setupGuideUrl: "https://achivator.cc/ru/help",
  startGroupSetup: guideUrl =>
    "Чтобы начать, сделайте меня администратором, затем создатель чата выполняет /verify@achivator_bot.\n" +
    `Инструкция по настройке: ${guideUrl}`,
  startGroupReady: guideUrl => `Я уже администратор в этом чате. Инструкция по настройке: ${guideUrl}`,

  cannotSeeSender:
    "Я не вижу, кто это отправил (анонимный администратор или пост от имени канала).\n" +
    "Напишите от своего имени или выполните команду в привязанной группе обсуждения.",

  rewardAdminsOnly:
    "Начислять баллы могут только создатель и администраторы чата " +
    "(чтобы это проверить, я должен быть администратором).",
  rewardWhere: "Выполните /reward в группе или канале, где я администратор.",
  rewardNoJetton:
    "В этом чате ещё не задан жетон для наград. Сначала создатель должен выполнить /jetton <адрес мастер-контракта>.",
  rewardNoAuthor:
    "У этого сообщения нет автора, которого можно наградить (бот или анонимный пост канала).\n" +
    "Начислите по id: /reward <id пользователя> <баллы> [причина]",
  rewardCannotResolve: username => `Не могу найти ${username}: пользователь должен быть участником этого чата.`,
  rewardUnknownUsername: username =>
    `Я ещё не видел ${username} в этом чате — ответьте на его сообщение: /reward <баллы> [причина]`,
  rewardUsage: maxPoints =>
    "Начислить баллы участнику:\n" +
    "• ответом на его сообщение: /reward <баллы> [причина]\n" +
    "• по упоминанию или id: /reward <@username или id пользователя> <баллы> [причина]\n" +
    `Баллы: 1…${maxPoints}. Начислять могут только создатель и администраторы (включая ботов-администраторов).`,
  rewardGranted: (points, name, reason) =>
    `${name}: +${points} ${ruPlural(points, "балл", "балла", "баллов")}` +
    (reason ? ` — ${reason}` : "") +
    "\nИх можно будет забрать жетонами в мини-приложении, когда пройдёт срок созревания.",

  jettonWhere: "Выполните эту команду в группе или канале.",
  jettonCreatorOnly: "Задать жетон для наград может только создатель чата.",
  jettonCannotSeeSender:
    "Я не вижу, кто это отправил (пост от имени канала). Чтобы выполнить /jetton, напишите от своего имени.",
  jettonCurrent: master =>
    `Текущий жетон для наград: ${master}\n\n` +
    "Участники получают баллы за положительные реакции и забирают их жетонами в мини-приложении.\n" +
    "Сменить жетон: /jetton <адрес мастер-контракта>",
  jettonNotSet:
    "Жетон для наград в этом чате ещё не задан.\n\n" +
    "Чтобы включить награды: /jetton <адрес мастер-контракта жетона>\n" +
    "Позже, чтобы пополнить пул, эти жетоны понадобятся в вашем кошельке.",
  jettonInvalid: "Это не похоже на адрес мастер-контракта жетона TON (EQ... / UQ... / 0:...).",
  jettonSet: master =>
    `Жетон для наград задан: ${master}\n\n` +
    "Что дальше:\n" +
    "1. Откройте мини-приложение и активируйте пул чата (один раз, 0,3 TON).\n" +
    "2. Пополните пул своими жетонами.\n" +
    "После этого участники будут получать баллы за положительные реакции и забирать их жетонами.",

  verifyWhere: "Выполните /verify в группе, которую вы создали.",
  verifyCannotCheck: "Не могу проверить ваш статус. Убедитесь, что я администратор этого чата.",
  verifyNotCreator: status => `Ваш статус — ${status}, а подтвердить бота может только создатель чата.`,
  verified: status =>
    `Подтверждено: вы ${status}.\nТеперь можно задать жетон для этого чата и открыть остальные настройки.`,

  langCurrent: languageName => `Язык чата: ${languageName}.`,
  langNotSet: "Язык чата не задан: я отвечаю каждому на языке его приложения Telegram.",
  langUsage: "Изменить (создатель и администраторы): /lang ru или /lang en",
  langUnknown: value => `Язык «${value}» я пока не знаю. Доступны: /lang ru или /lang en`,
  langSet: languageName => `Язык чата: ${languageName}. Теперь я пишу здесь по-русски.`,
  langAdminsOnly:
    "Менять язык чата могут только создатель и администраторы (чтобы это проверить, я должен быть администратором).",
  langPrivate:
    "В личном чате я пишу на языке вашего приложения Telegram.\n" +
    "Чтобы задать язык группы, выполните там /lang ru или /lang en (создатель и администраторы).",

  migrationCompleted: "Миграция завершена",

  priceDecreaseScheduled: ({from, to, symbol, effective_at}) =>
    `Цена балла снизится ${utcDateTime(effective_at, RU_MONTHS)}: ` +
    `1 балл = ${ruDecimal(from)} → ${ruDecimal(to)} ${symbol || "жетона"}.\n` +
    "До этого момента уже заработанные баллы можно забрать по текущей цене — откройте мини-приложение.\n" +
    "Чтобы получать личные напоминания, запустите @achivator_bot в личных сообщениях.",
  priceDecreased: ({from, to, symbol}) =>
    `Цена балла снизилась: 1 балл = ${ruDecimal(to)} ${symbol || "жетона"} (было ${ruDecimal(from)}).`,
  priceIncreased: ({from, to, symbol, cancelled_pending}) =>
    `Цена балла выросла: 1 балл = ${ruDecimal(to)} ${symbol || "жетона"} (было ${ruDecimal(from)}).` +
    (cancelled_pending ? "\nЗапланированное снижение отменено." : ""),
  priceDecreaseCancelled: ({from, symbol}) =>
    `Запланированное снижение цены балла отменено: 1 балл по-прежнему стоит ${ruDecimal(from)} ${symbol || "жетона"}.`,

  dmPriceDecreaseScheduled: ({chat_title, from, to, symbol, effective_at, points, estimate}) =>
    `${ruInChat(chat_title)} цена балла снизится ${utcDateTime(effective_at, RU_MONTHS)}: ` +
    `1 балл = ${ruDecimal(from)} → ${ruDecimal(to)} ${symbol || "жетона"}.\n` +
    `У вас ${ruDecimal(points)} ${ruPointsWord(points)} ` +
    `(≈ ${ruDecimal(estimate)} ${symbol || "жетона"} по текущей цене). ` +
    "Заберите их до этого времени, чтобы сохранить текущий курс.",
  dmPriceDecreaseCancelled: ({chat_title, from, symbol}) =>
    `${ruInChat(chat_title)} запланированное снижение цены балла отменено: ` +
    `1 балл по-прежнему стоит ${ruDecimal(from)} ${symbol || "жетона"}.`,

  commandStart: "Что такое Achivator и как его подключить",
  commandHelp: "Инструкция по настройке",
  commandVerify: "Подтвердить, что вы создатель чата",
  commandJetton: "Задать жетон для наград в этом чате (создатель)",
  commandReward: "Начислить баллы участнику (администраторы)",
  commandLang: "Язык чата: /lang ru или /lang en (администраторы)",
};

const DICTIONARIES = {en, ru};

// t("ru", "rewardUsage", 1000): the text for `key` in `lang`, English when the
// language or the key is missing. Entries that take parameters are functions.
// An unknown key is a bug, but it answers with the key instead of throwing
// inside an update handler.
export function t(lang, key, ...args) {
  const entry = DICTIONARIES[lang]?.[key] ?? en[key];
  if (entry === undefined) {
    console.error(`i18n: unknown message key "${key}"`);
    return key;
  }
  return typeof entry === "function" ? entry(...args) : entry;
}
