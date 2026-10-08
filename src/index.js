const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { auth } = require('./middleware/auth');
const agent = require('./handlers/agent');
const admin = require('./handlers/admin');
const reports = require('./handlers/reports');
const panel = require('./handlers/panel');
const messages = require('./handlers/messages');
const join = require('./handlers/join');
const notify = require('./services/notify');
const { startJobs } = require('./jobs');
const { prepareDefaultSchedule } = require('./services/defaultSlots');

const agentCommands = [
  { command: 'start', description: 'Open the bot / request access' },
  { command: 'join', description: 'Request to join' },
  { command: 'slots', description: 'Free times & reserve' },
  { command: 'mybookings', description: 'My reservations / cancel' },
  { command: 'myaccount', description: 'Account for my slot' },
  { command: 'startwork', description: 'Start working' },
  { command: 'endwork', description: 'End working' },
  { command: 'becomeadmin', description: 'Request admin access' },
  { command: 'myhours', description: 'My worked hours' },
];
const adminCommands = [
  { command: 'panel', description: 'Admin menu' },
  { command: 'requests', description: 'Approve or reject join requests' },
  { command: 'adminrequests', description: 'Approve or reject admin requests' },
  { command: 'schedule', description: 'Who is booked when' },
  { command: 'accounts', description: 'Accounts & who uses them' },
  { command: 'accountreport', description: 'Full report of one account' },
  { command: 'msg', description: 'Message an agent (with confirmation)' },
  { command: 'messages', description: 'Sent messages & confirmations' },
  { command: 'templates', description: 'Message templates' },
  { command: 'hours', description: 'Hours report by agent' },
  { command: 'accounthours', description: 'Hours report by account' },
];

/** Only supervisors may use the dedicated admin bot. */
const adminGate = (ctx, next) =>
  ctx.state.user?.role === 'admin' ? next() : ctx.reply('⛔ This bot is for supervisors only. Use the agents bot instead.');

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected');
  await Promise.all([require('./models/User').init(), require('./models/Account').init(), require('./models/Slot').init(), require('./models/ScheduleOverride').init(), require('./models/Booking').init(), require('./models/Session').init(), require('./models/Message').init()]);
  await prepareDefaultSchedule();
  console.log(`Default daily schedule ready: ${config.defaultSlotStart}-${config.defaultSlotEnd} (${config.defaultSlotMinutes}-minute slots)`);

  const agentBot = new Telegraf(config.botToken);
  const adminBot = config.adminBotToken ? new Telegraf(config.adminBotToken) : null;

  const base = (bot, { allowJoin = false } = {}) => {
    bot.command('id', (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`)); // works before registration
    if (allowJoin) join.registerPublic(bot);
    bot.use((ctx, next) => auth(ctx, next, { allowJoin }));
    bot.catch((err, ctx) => console.error(`Error for ${ctx.updateType}:`, err));
  };

  // Agents bot
  base(agentBot, { allowJoin: true });
  agent.register(agentBot);
  messages.registerAck(agentBot); // agents confirm messages with "Got it"
  if (!adminBot) { // single-bot mode: supervisors use the same bot
    admin.register(agentBot);
    reports.register(agentBot);
    panel.register(agentBot);
    join.registerAdmin(agentBot);
    messages.register(agentBot); // keep last: it listens for typed message text
  }

  // Dedicated admin bot (optional)
  if (adminBot) {
    base(adminBot);
    adminBot.use(adminGate);
    admin.register(adminBot);
    reports.register(adminBot);
    panel.register(adminBot, { handleStart: true });
    join.registerAdmin(adminBot);
    messages.register(adminBot); // keep last: it listens for typed message text
  }

  notify.setBots(agentBot, adminBot);

  // Agent notifications go through the agents bot; supervisor summaries through the admin bot
  startJobs(agentBot, adminBot || agentBot);

  try {
    await agentBot.telegram.setMyCommands(agentCommands);
    if (adminBot) await adminBot.telegram.setMyCommands(adminCommands);
    else for (const id of config.adminIds) {
      await agentBot.telegram.setMyCommands([...agentCommands, ...adminCommands], { scope: { type: 'chat', chat_id: id } }).catch(() => {});
    }
  } catch (e) { console.error('setMyCommands failed:', e.message); }

  const bots = [agentBot, adminBot].filter(Boolean);
  const stop = (sig) => { bots.forEach((b) => b.stop(sig)); mongoose.disconnect(); };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  console.log(`Starting ${adminBot ? 'agents bot + admin bot' : 'single bot'} (long polling)...`);
  bots.forEach((b) => b.launch().catch((e) => { console.error('Bot launch failed:', e); process.exit(1); }));
}

main().catch((e) => { console.error(e); process.exit(1); });
