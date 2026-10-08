const { Markup } = require('telegraf');
const User = require('../models/User');
const Account = require('../models/Account');
const Session = require('../models/Session');
const Booking = require('../models/Booking');
const { adminOnly } = require('../middleware/auth');
const { esc } = require('../utils/format');
const { todayStr, addDays, fmtTime, fmtDate, parseRange } = require('../utils/time');
const { hoursReport, renderReport, accountDetail, renderAccountDetail } = require('../services/report');
const { scheduleText } = require('../services/schedule');
const { ADMIN_HELP } = require('./admin');

const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const btn = (label, data) => Markup.button.callback(label, data);
const HOME = [btn('🏠 Home', 'p:home')];
const RANGES = [['Today', 'today'], ['Yesterday', 'yesterday'], ['Week', 'week'], ['Month', 'month']];
const rangeRow = (prefix, current) => RANGES.map(([l, k]) => btn(k === current ? `• ${l}` : l, `${prefix}:${k}`));

/** Edit the panel message in place (button press) or send a new one (command). */
async function show(ctx, text, rows) {
  const extra = html(Markup.inlineKeyboard(rows));
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, extra); } catch (e) { /* not modified */ }
    return ctx.answerCbQuery().catch(() => {});
  }
  return ctx.reply(text, extra);
}

// ---------- screens: each returns { text, rows } ----------
async function homeScreen() {
  const pending = await User.countDocuments({ registrationStatus: 'pending' });
  const adminReqs = await User.countDocuments({ adminRequest: 'pending' });
  return {
    text: '🛠 <b>Admin panel</b>\nPick what you want to manage.' + (pending ? `\n\n🔔 <b>${pending}</b> join request${pending === 1 ? '' : 's'} waiting for approval.` : ''),
    rows: [
      [btn('📡 Live now', 'p:live'), btn('🗓 Schedule', 'p:sched:today')],
      [btn('👥 Team', 'p:team'), btn('🔑 Accounts', 'p:accs')],
      [btn(`📥 Join requests${pending ? ` (${pending})` : ''}`, 'join:list:0'), btn('✉️ Messages', 'msg:list')],
      ...(adminReqs ? [[btn(`🛡 Admin requests (${adminReqs})`, 'adm:list')]] : []),
      [btn('📊 Reports', 'p:rep'), btn('ℹ️ Commands', 'p:help')],
    ],
  };
}

async function teamScreen() {
  const users = await User.find({ registrationStatus: { $nin: ['pending', 'rejected'] } }).sort({ name: 1 }).limit(40);
  const rows = users.map((u) => [btn(`${u.active ? '' : '✖ '}${u.name} · ${u.role}`, `p:user:${u._id}`)]);
  rows.push([btn('📥 Join requests', 'join:list:0'), btn('📢 Message everyone', 'msg:compose:all')], HOME);
  return {
    text: `👥 <b>Team</b> (${users.length})\nTap a person to manage them.\n\nTo add someone: <code>/adduser 123456789 Name agent</code>`,
    rows,
  };
}

async function userScreen(id) {
  const u = await User.findOne({ _id: id, registrationStatus: { $nin: ['pending', 'rejected'] } });
  if (!u) return { text: 'User not found.', rows: [HOME] };
  const week = parseRange(['week']);
  const [hours] = await hoursReport(week.from, week.to, { by: 'user', id: u._id });
  const upcoming = await Booking.countDocuments({ user: u._id, end: { $gt: new Date() } });
  const text =
    `👤 <b>${esc(u.name)}</b>${u.username ? ' @' + esc(u.username) : ''}\n` +
    `Role: <b>${u.role}</b> · ${u.active ? '🟢 active' : '⛔ deactivated'}\nTelegram ID: <code>${u.telegramId}</code>\n` +
    `Upcoming reservations: ${upcoming}\n` +
    (hours ? `This week: booked ${Math.round(hours.bookedMin / 6) / 10} h · worked ${Math.round(hours.workedMin / 6) / 10} h · no-shows ${hours.noShows}` : 'This week: no activity');
  return {
    text,
    rows: [
      [btn(u.active ? '⛔ Deactivate' : '✅ Activate', `p:utog:${u._id}`), btn(u.role === 'admin' ? '⬇️ Make agent' : '⬆️ Make admin', `p:urole:${u._id}`)],
      [btn('✉️ Send message', `msg:compose:${u._id}`)],
      [btn('◀️ Team', 'p:team'), ...HOME],
    ],
  };
}

async function accountsScreen() {
  const accounts = await Account.find().sort({ name: 1 });
  const inUse = new Set((await Session.find({ status: 'active' })).map((s) => String(s.account)));
  const rows = accounts.map((a) => [btn(`${!a.active ? '⛔' : inUse.has(String(a._id)) ? '🟢' : '⚪'} ${a.name}`, `p:acc:${a._id}:week`)]);
  rows.push(HOME);
  return {
    text: `🔑 <b>Accounts</b> (${accounts.length})\nTap an account for its full report.\n🟢 in use · ⚪ free · ⛔ disabled\n\nTo add or update: <code>/addaccount CC-03 login password</code>`,
    rows,
  };
}

async function accountScreen(id, rangeKey) {
  const range = parseRange([rangeKey]);
  const d = await accountDetail(id, range);
  if (!d) return { text: 'Account not found.', rows: [HOME] };
  return {
    text: renderAccountDetail(d, range.label),
    rows: [
      rangeRow(`p:acc:${id}`, rangeKey),
      [btn(d.acc.active ? '⛔ Disable account' : '✅ Enable account', `p:atog:${id}:${rangeKey}`)],
      [btn('◀️ Accounts', 'p:accs'), ...HOME],
    ],
  };
}

async function reportScreen(by, rangeKey) {
  const range = parseRange([rangeKey]);
  const rows = await hoursReport(range.from, range.to, { by });
  return {
    text: renderReport(by === 'account' ? 'Hours per account' : 'Hours per agent', range.label, rows),
    rows: [
      [btn(by === 'user' ? '• 👤 Agents' : '👤 Agents', `p:rep:user:${rangeKey}`), btn(by === 'account' ? '• 🔑 Accounts' : '🔑 Accounts', `p:rep:account:${rangeKey}`)],
      rangeRow(`p:rep:${by}`, rangeKey),
      HOME,
    ],
  };
}

async function liveScreen() {
  const now = new Date();
  const accounts = await Account.find({ active: true }).sort({ name: 1 });
  const active = await Session.find({ status: 'active' }).populate('user');
  const by = new Map();
  active.forEach((s) => by.set(String(s.account), [...(by.get(String(s.account)) || []), `${esc(s.user.name)} (since ${fmtTime(s.startedAt)})`]));
  let text = `📡 <b>Live now</b> — ${fmtTime(now)}\n`;
  for (const a of accounts) {
    const users = by.get(String(a._id));
    if (users) { text += `\n🟢 <b>${esc(a.name)}</b> — ${users.join(', ')}`; continue; }
    const next = await Booking.findOne({ account: a._id, end: { $gt: now } }).sort({ start: 1 }).populate('user');
    text += `\n⚪ <b>${esc(a.name)}</b> — free${next ? `; next: ${fmtDate(next.start)} ${fmtTime(next.start)} ${esc(next.user?.name)}` : ''}`;
  }
  if (!accounts.length) text += '\nNo accounts yet.';
  return { text, rows: [[btn('🔄 Refresh', 'p:live'), ...HOME]] };
}

async function schedScreen(date) {
  const text = await scheduleText(date);
  return {
    text: `${text}\n\n<i>Ethiopian time · publish slots: /addslots ${date} 2:00day 4:00night all 60 2</i>`,
    rows: [[btn('◀️ Prev', `p:sched:${addDays(date, -1)}`), btn('Today', 'p:sched:today'), btn('Next ▶️', `p:sched:${addDays(date, 1)}`)], HOME],
  };
}

function register(bot, { handleStart = false } = {}) {
  const open = async (ctx) => { const s = await homeScreen(); return show(ctx, s.text, s.rows); };
  bot.command(['panel', 'admin'], adminOnly, open);
  bot.hears('🛠 Admin panel', adminOnly, open);
  if (handleStart) {
    // dedicated admin bot: bottom keyboard with the main admin sections
    const kb = Markup.keyboard([['📡 Live now', '🗓 Schedule'], ['👥 Team', '🔑 Accounts'], ['📊 Reports', '🛠 Admin panel']]).resize().persistent();
    bot.start(adminOnly, async (ctx) => { await ctx.reply('Use the buttons below to move around 👇', kb); return open(ctx); });
    const go = (label, screen) => bot.hears(label, adminOnly, async (ctx) => { const x = await screen(); return show(ctx, x.text, x.rows); });
    go('📡 Live now', liveScreen);
    go('🗓 Schedule', () => schedScreen(todayStr()));
    go('👥 Team', teamScreen);
    go('🔑 Accounts', accountsScreen);
    go('📊 Reports', () => reportScreen('user', 'week'));
  }

  const route = (re, screen) =>
    bot.action(re, adminOnly, async (ctx) => { const s = await screen(ctx); return show(ctx, s.text, s.rows); });

  route(/^p:home$/, () => homeScreen());
  route(/^p:help$/, () => ({ text: ADMIN_HELP, rows: [HOME] }));
  route(/^p:team$/, () => teamScreen());
  route(/^p:user:([a-f0-9]{24})$/, (ctx) => userScreen(ctx.match[1]));
  route(/^p:accs$/, () => accountsScreen());
  route(/^p:acc:([a-f0-9]{24}):(\w+)$/, (ctx) => accountScreen(ctx.match[1], ctx.match[2]));
  route(/^p:rep$/, () => reportScreen('user', 'week'));
  route(/^p:rep:(account|user):(\w+)$/, (ctx) => reportScreen(ctx.match[1], ctx.match[2]));
  route(/^p:live$/, () => liveScreen());
  route(/^p:sched:(today|\d{4}-\d{2}-\d{2})$/, (ctx) => schedScreen(ctx.match[1] === 'today' ? todayStr() : ctx.match[1]));

  // actions that change data, then re-render
  bot.action(/^p:utog:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const u = await User.findOne({ _id: ctx.match[1], registrationStatus: { $nin: ['pending', 'rejected'] } });
    if (!u) return ctx.answerCbQuery('User not found.', { show_alert: true });
    if (String(u._id) === String(ctx.state.user._id)) return ctx.answerCbQuery("You can't deactivate yourself.", { show_alert: true });
    u.active = !u.active;
    await u.save();
    const s = await userScreen(u._id);
    return show(ctx, s.text, s.rows);
  });
  bot.action(/^p:urole:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const u = await User.findOne({ _id: ctx.match[1], registrationStatus: { $nin: ['pending', 'rejected'] } });
    if (!u) return ctx.answerCbQuery('User not found.', { show_alert: true });
    if (String(u._id) === String(ctx.state.user._id)) return ctx.answerCbQuery("You can't change your own role.", { show_alert: true });
    u.role = u.role === 'admin' ? 'agent' : 'admin';
    await u.save();
    const s = await userScreen(u._id);
    return show(ctx, s.text, s.rows);
  });
  bot.action(/^p:atog:([a-f0-9]{24}):(\w+)$/, adminOnly, async (ctx) => {
    const a = await Account.findById(ctx.match[1]);
    if (!a) return ctx.answerCbQuery('Account not found.', { show_alert: true });
    a.active = !a.active;
    await a.save();
    const s = await accountScreen(a._id, ctx.match[2]);
    return show(ctx, s.text, s.rows);
  });
}

module.exports = { register };
