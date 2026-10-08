// Lets any handler send through the right bot: agents are reached through the agents bot,
// supervisors through the admin bot (or the same bot in single-bot mode).
let agentBot = null;
let adminBot = null;

const setBots = (agents, admin) => { agentBot = agents; adminBot = admin || agents; };
const opts = (extra = {}) => ({ parse_mode: 'HTML', ...extra });

/** Throws if Telegram refuses (e.g. the user never started the agents bot). */
const toUser = (chatId, text, extra) => agentBot.telegram.sendMessage(chatId, text, opts(extra));
const toAdmin = (chatId, text, extra) => adminBot.telegram.sendMessage(chatId, text, opts(extra)).catch(() => {});

module.exports = { setBots, toUser, toAdmin };
