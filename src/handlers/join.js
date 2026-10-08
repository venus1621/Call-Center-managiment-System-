const { Markup } = require('telegraf');
const User = require('../models/User');
const config = require('../config');
const { adminOnly } = require('../middleware/auth');
const notify = require('../services/notify');
const { esc } = require('../utils/format');

const PAGE_SIZE = 5;
const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const btn = (label, data) => Markup.button.callback(label, data);
const navigation = () => [[btn('Join requests', 'join:list:0'), btn('Home', 'p:home')]];
const identity = (user) =>
  `<b>${esc(user.name.slice(0, 80))}</b>${user.username ? ` @${esc(user.username)}` : ''}\nTelegram ID: <code>${user.telegramId}</code>`;
const reviewButtons = (user, numbered = '') => [
  btn(`${numbered}Approve`, `join:approve:${user._id}`),
  btn(`${numbered}Reject`, `join:reject:${user._id}`),
];

/** Public entry points run before auth but never grant access. */
async function requestJoin(ctx) {
  if (!ctx.from || ctx.chat?.type !== 'private') return;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  const telegramId = ctx.from.id;
  if (config.adminIds.includes(telegramId)) return ctx.reply('You are a configured admin. Send /start to open the bot.');

  let created = false;
  try {
    const result = await User.updateOne(
      { telegramId },
      { $setOnInsert: {
        telegramId,
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(telegramId),
        username: ctx.from.username,
        role: 'agent', active: false, registrationStatus: 'pending', requestedAt: new Date(),
      } },
      { upsert: true, runValidators: true }
    );
    created = result.upsertedCount === 1;
  } catch (err) {
    // Concurrent submissions can race on the unique Telegram ID; keep one request.
    if (err.code !== 11000) throw err;
  }
  const user = await User.findOne({ telegramId });
  if (user.registrationStatus === 'rejected') return ctx.reply('Your join request was rejected. Please contact your supervisor.');
  if (user.registrationStatus !== 'pending') {
    return ctx.reply(user.active ? 'You already have access. Send /start to open the bot.' : 'Your access has been deactivated. Please contact your supervisor.');
  }
  await ctx.reply(created
    ? 'Your join request has been submitted. You will be notified when an admin approves or rejects it.'
    : 'Your join request is already waiting for admin approval.');
  if (!created) return;

  const admins = await User.find({ role: 'admin', active: true, registrationStatus: { $nin: ['pending', 'rejected'] } });
  const adminIds = new Set([...config.adminIds, ...admins.map((admin) => admin.telegramId)]);
  const text = `New join request\n\n${identity(user)}\n\nApprove to give this person agent access.`;
  await Promise.all([...adminIds].map((id) => notify.toAdmin(id, text, Markup.inlineKeyboard([reviewButtons(user)]))));
}

async function listRequests(ctx, requestedPage = 0) {
  const total = await User.countDocuments({ registrationStatus: 'pending' });
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
  const users = await User.find({ registrationStatus: 'pending' })
    .sort({ requestedAt: 1, _id: 1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE);
  let text = `<b>Join requests</b> (${total} pending)\n`;
  const rows = [];
  users.forEach((user, index) => {
    const number = page * PAGE_SIZE + index + 1;
    text += `\n${number}. ${identity(user)}\n`;
    rows.push(reviewButtons(user, `${number}. `));
  });
  if (!total) text += '\nNo pending join requests.';
  else text += `\nPage ${page + 1} of ${Math.ceil(total / PAGE_SIZE)}. Approving gives agent access.`;
  const pages = [];
  if (page > 0) pages.push(btn('Previous', `join:list:${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total) pages.push(btn('Next', `join:list:${page + 1}`));
  if (pages.length) rows.push(pages);
  rows.push([btn('Refresh', `join:list:${page}`), btn('Home', 'p:home')]);
  const extra = html(Markup.inlineKeyboard(rows));
  if (!ctx.callbackQuery) return ctx.reply(text, extra);
  await ctx.answerCbQuery().catch(() => {});
  try { return await ctx.editMessageText(text, extra); }
  catch (err) { if (!err.description?.includes('message is not modified')) return ctx.reply(text, extra); }
}

async function reviewRequest(ctx) {
  const approved = ctx.match[1] === 'approve';
  // One atomic update decides both the request and access, even with multiple admins.
  const user = await User.findOneAndUpdate(
    { _id: ctx.match[2], registrationStatus: 'pending' },
    { $set: {
      registrationStatus: approved ? 'approved' : 'rejected', active: approved, role: 'agent',
      reviewedBy: ctx.state.user._id, reviewedAt: new Date(),
    } },
    { new: true, runValidators: true }
  );
  if (!user) {
    await ctx.answerCbQuery('This request has already been reviewed.', { show_alert: true });
    try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(navigation()).reply_markup); } catch (err) { /* old message */ }
    return;
  }
  await ctx.answerCbQuery(approved ? 'Approved' : 'Rejected').catch(() => {});
  let text = `${approved ? 'Approved' : 'Rejected'} join request\n\n${identity(user)}\n\nReviewed by ${esc(ctx.state.user.name)}.`;
  try {
    await notify.toUser(user.telegramId, approved
      ? 'Your join request has been approved! Send /start to see your commands and /slots to reserve a time.'
      : 'Your join request was rejected. Please contact your supervisor.');
  } catch (err) {
    text += '\nThe notification could not be delivered. The user can check their status with /start.';
  }
  const extra = html(Markup.inlineKeyboard(navigation()));
  try { return await ctx.editMessageText(text, extra); }
  catch (err) { return ctx.reply(text, extra); }
}

// ---------- admin-role requests (agent asks, an admin approves) ----------
const adminReviewButtons = (user) => [btn('✅ Approve', `adm:approve:${user._id}`), btn('✖ Reject', `adm:reject:${user._id}`)];

/** An existing agent asks to become an admin; every admin is notified. */
async function requestAdminRole(ctx) {
  const me = ctx.state.user;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
  if (me.role === 'admin') return ctx.reply('You are already an admin.');
  const user = await User.findOneAndUpdate(
    { _id: me._id, role: 'agent', adminRequest: { $ne: 'pending' } },
    { $set: { adminRequest: 'pending', adminRequestedAt: new Date() } },
    { new: true }
  );
  if (!user) return ctx.reply('⏳ Your admin request is already waiting for approval.');
  await ctx.reply('✅ Admin request sent. You will be notified when an admin reviews it.');
  const admins = await User.find({ role: 'admin', active: true, registrationStatus: { $nin: ['pending', 'rejected'] } });
  const adminIds = new Set([...config.adminIds, ...admins.map((a) => a.telegramId)]);
  const text = `🛡 <b>Admin access request</b>\n\n${identity(user)}\n\nApprove to make this person an admin.`;
  await Promise.all([...adminIds].map((id) => notify.toAdmin(id, text, Markup.inlineKeyboard([adminReviewButtons(user)]))));
}

async function listAdminRequests(ctx) {
  const users = await User.find({ adminRequest: 'pending' }).sort({ adminRequestedAt: 1 }).limit(20);
  let text = `🛡 <b>Admin requests</b> (${users.length} pending)\n`;
  const rows = [];
  users.forEach((u, i) => {
    text += `\n${i + 1}. ${identity(u)}\n`;
    rows.push([btn(`${i + 1}. ✅ Approve`, `adm:approve:${u._id}`), btn(`${i + 1}. ✖ Reject`, `adm:reject:${u._id}`)]);
  });
  if (!users.length) text += '\nNo pending admin requests.';
  rows.push([btn('🔄 Refresh', 'adm:list'), btn('🏠 Home', 'p:home')]);
  const extra = html(Markup.inlineKeyboard(rows));
  if (!ctx.callbackQuery) return ctx.reply(text, extra);
  await ctx.answerCbQuery().catch(() => {});
  try { return await ctx.editMessageText(text, extra); }
  catch (err) { if (!err.description?.includes('message is not modified')) return ctx.reply(text, extra); }
}

async function reviewAdminRequest(ctx) {
  const approved = ctx.match[1] === 'approve';
  // Atomic: only the first admin to press a button decides the request.
  const user = await User.findOneAndUpdate(
    { _id: ctx.match[2], adminRequest: 'pending' },
    { $set: { adminRequest: 'none', ...(approved ? { role: 'admin' } : {}) } },
    { new: true }
  );
  if (!user) {
    await ctx.answerCbQuery('This request has already been reviewed.', { show_alert: true });
    try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[btn('🛡 Admin requests', 'adm:list'), btn('🏠 Home', 'p:home')]]).reply_markup); } catch (err) { /* old message */ }
    return;
  }
  await ctx.answerCbQuery(approved ? 'Approved' : 'Rejected').catch(() => {});
  let text = `${approved ? '✅ Approved' : '✖ Rejected'} admin request\n\n${identity(user)}\n\nReviewed by ${esc(ctx.state.user.name)}.`;
  try {
    await notify.toUser(user.telegramId, approved
      ? '🛡 Your admin request was approved! Send /start to open the admin panel.'
      : 'Your admin request was rejected.');
  } catch (err) {
    text += '\nThe notification could not be delivered.';
  }
  const extra = html(Markup.inlineKeyboard([[btn('🛡 Admin requests', 'adm:list'), btn('🏠 Home', 'p:home')]]));
  try { return await ctx.editMessageText(text, extra); }
  catch (err) { return ctx.reply(text, extra); }
}

function registerPublic(bot) {
  bot.command('join', requestJoin);
  bot.action('join:request', requestJoin);
}

function registerAdmin(bot) {
  bot.command('requests', adminOnly, (ctx) => listRequests(ctx));
  bot.action(/^join:list:(\d{1,6})$/, adminOnly, (ctx) => listRequests(ctx, Number(ctx.match[1])));
  bot.action(/^join:(approve|reject):([a-f0-9]{24})$/, adminOnly, reviewRequest);
  bot.command('adminrequests', adminOnly, listAdminRequests);
  bot.action('adm:list', adminOnly, listAdminRequests);
  bot.action(/^adm:(approve|reject):([a-f0-9]{24})$/, adminOnly, reviewAdminRequest);
}

module.exports = { registerPublic, registerAdmin, requestAdminRole };
