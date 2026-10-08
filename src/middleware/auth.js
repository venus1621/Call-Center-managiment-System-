const config = require('../config');
const User = require('../models/User');
const { Markup } = require('telegraf');

/** Only registered, active users in private chats may use the bot. */
async function auth(ctx, next, { allowJoin = true } = {}) {
  if (!ctx.from || ctx.chat?.type !== 'private') return;
  const id = ctx.from.id;
  const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(id);
  const isEnvAdmin = config.adminIds.includes(id);

  let user = await User.findOne({ telegramId: id });
  if (isEnvAdmin && (!user || ['pending', 'rejected'].includes(user.registrationStatus))) {
    user = await User.findOneAndUpdate(
      { telegramId: id },
      { $set: { role: 'admin', active: true, registrationStatus: 'approved' }, $setOnInsert: { name: fullName, username: ctx.from.username } },
      { upsert: true, new: true }
    );
  }
  if (!user || !user.active || ['pending', 'rejected'].includes(user.registrationStatus)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (!user) {
      if (!allowJoin) return ctx.reply('This bot is for supervisors only. Open the agents bot to request access.');
      return ctx.reply(
        `Welcome! You need admin approval to use this bot.\nYour Telegram ID: ${id}\n\nPress the button below to request access.`,
        Markup.inlineKeyboard([[Markup.button.callback('Request to join', 'join:request')]])
      );
    }
    if (user.registrationStatus === 'pending') return ctx.reply('Your join request is waiting for admin approval. You will be notified when it is reviewed.');
    if (user.registrationStatus === 'rejected') return ctx.reply('Your join request was rejected. Please contact your supervisor.');
    return ctx.reply('Your access has been deactivated. Please contact your supervisor.');
  }

  let dirty = false;
  if (isEnvAdmin && user.role !== 'admin') { user.role = 'admin'; dirty = true; }
  if (ctx.from.username && user.username !== ctx.from.username) { user.username = ctx.from.username; dirty = true; }
  if (dirty) await user.save();

  ctx.state.user = user;
  return next();
}

const adminOnly = (ctx, next) =>
  ctx.state.user?.role === 'admin' ? next() : ctx.reply('⛔ Admins only.');

module.exports = { auth, adminOnly };
