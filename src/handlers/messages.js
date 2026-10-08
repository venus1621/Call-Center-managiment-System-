const { Markup } = require('telegraf');
const User = require('../models/User');
const Message = require('../models/Message');
const Template = require('../models/Template');
const { adminOnly } = require('../middleware/auth');
const notify = require('../services/notify');
const { esc } = require('../utils/format');
const { fmtDateTime, fmtTime } = require('../utils/time');
const { findUser } = require('./admin');

const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const MAX_LEN = 1000;
const DRAFT_TTL_MIN = 30;
const AWAIT_TTL_MIN = 10;
const awaiting = new Map(); // admin telegramId -> { target, at }  (waiting for the message text)

// Built-in templates (always available). Supervisors can add their own with /addtemplate.
const BUILTIN_TEMPLATES = [
  { id: 'b0', title: '⏰ Start earlier', text: 'Please start your shift 15 minutes earlier tomorrow.' },
  { id: 'b1', title: '🔔 Shift reminder', text: 'Reminder: your shift is coming up. Please be ready and press Start work on time.' },
  { id: 'b2', title: '🗓 Schedule changed', text: 'The schedule has changed. Please check /mybookings to see your updated reservations.' },
  { id: 'b3', title: '📞 Contact me', text: 'Please contact me when you are available.' },
  { id: 'b4', title: '🙏 Thank you', text: 'Thank you for your good work today!' },
];
const allTemplates = async () => [...BUILTIN_TEMPLATES, ...(await Template.find().sort({ createdAt: 1 }).limit(20))
  .map((t) => ({ id: String(t._id), title: t.title, text: t.text, custom: true }))];
const findTemplate = async (id) => (await allTemplates()).find((t) => t.id === id);

/** Who answered an availability request. */
async function availabilitySummary(messageId) {
  const m = await Message.findById(messageId).populate('recipients.user');
  if (!m) return null;
  const names = (answer) => m.recipients.filter((r) => (answer ? r.answer === answer : !r.answer) && r.status === 'sent').map((r) => esc(r.user?.name || '?'));
  const yes = names('yes');
  const no = names('no');
  const waiting = names(null);
  const line = (icon, label, list) => `${icon} <b>${label} (${list.length})</b>${list.length ? `\n${list.join(', ')}` : ''}`;
  const short = m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text;
  return {
    id: m._id,
    text: `🙋 <b>Availability</b>\n“${esc(short)}”\n\n${line('✅', 'Available', yes)}\n\n${line('❌', 'Not available', no)}\n\n${line('⏳', 'No answer yet', waiting)}`,
  };
}
const summaryButtons = (id) => Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', `msg:sum:${id}`), Markup.button.callback('✉️ Messages', 'msg:list')]]);

async function resolveTargets(target, senderId) {
  if (target === 'all') return User.find({ active: true, role: 'agent', _id: { $ne: senderId } }).sort({ name: 1 });
  const u = /^[a-f0-9]{24}$/.test(target) ? await User.findById(target) : await findUser(target);
  return u && u.active && String(u._id) !== String(senderId) ? [u] : [];
}

/** Save a draft and ask the supervisor to confirm before anything is sent. */
async function previewDraft(ctx, target, text, kind = 'text') {
  const sender = ctx.state.user;
  if (!text.trim()) return ctx.reply('The message is empty.');
  if (text.length > MAX_LEN) return ctx.reply(`Too long (${text.length}/${MAX_LEN} characters). Please shorten it.`);
  const recipients = await resolveTargets(target, sender._id);
  if (!recipients.length) return ctx.reply('No active recipient found. Check the name/@username/ID (see /users).');

  const msg = await Message.create({
    sender: sender._id,
    text,
    kind,
    target: target === 'all' ? 'all' : 'user',
    recipients: recipients.map((u) => ({ user: u._id, telegramId: u.telegramId })),
  });
  const names = recipients.map((u) => esc(u.name));
  const to = target === 'all'
    ? `all agents (${names.length}): ${names.slice(0, 15).join(', ')}${names.length > 15 ? ', …' : ''}`
    : names[0];
  return ctx.reply(
    `${kind === 'availability' ? '🙋 <b>Please confirm this availability request</b>' : '✉️ <b>Please confirm this message</b>'}\n\nTo: <b>${to}</b>\n\n┌──────────\n${esc(text)}\n└──────────\n\n${kind === 'availability' ? 'Agents will get ✅ <i>I am available</i> / ❌ <i>Not available</i> buttons. You will see who answered.' : 'The agent(s) will get a ✅ <i>Got it</i> button and you will be told when they confirm.'}`,
    html(Markup.inlineKeyboard([[Markup.button.callback('✅ Send', `msg:send:${msg._id}`), Markup.button.callback('❌ Cancel', `msg:cancel:${msg._id}`)]]))
  );
}

async function listScreen() {
  const msgs = await Message.find({ status: 'sent' }).sort({ createdAt: -1 }).limit(10).populate('sender recipients.user');
  let text = '✉️ <b>Recent messages</b>\n';
  if (!msgs.length) text += '\nNothing sent yet.';
  msgs.forEach((m) => {
    const sent = m.recipients.filter((r) => r.status === 'sent').length;
    const acked = m.recipients.filter((r) => r.ackedAt).length;
    const to = m.target === 'all' ? `all agents (${m.recipients.length})` : esc(m.recipients[0]?.user?.name || '?');
    const preview = esc(m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text);
    if (m.kind === 'availability') {
      const yes = m.recipients.filter((r) => r.answer === 'yes').length;
      text += `\n• 🙋 ${fmtDateTime(m.createdAt)} → ${to}\n   “${preview}” — ✅ ${yes} available · ❌ ${m.recipients.filter((r) => r.answer === 'no').length} no · ⏳ ${sent - acked} waiting`;
    } else text += `\n• ${fmtDateTime(m.createdAt)} → ${to}\n   “${preview}” — delivered ${sent}/${m.recipients.length}, confirmed ${acked}`;
  });
  text += '\n\nSend: <code>/msg @username your text</code> or <code>/msg all your text</code>';
  return {
    text,
    rows: [
      [Markup.button.callback('📢 Message everyone', 'msg:compose:all'), Markup.button.callback('📋 Templates', 'msg:tpls')],
      [Markup.button.callback('🙋 Ask who is available', 'msg:avail')],
      [Markup.button.callback('🏠 Home', 'p:home')],
    ],
  };
}

/** Supervisor side: compose, confirm, history. */
function register(bot) {
  // /msg <@name|id|all> <text>
  bot.command('msg', adminOnly, async (ctx) => {
    const m = ctx.message.text.match(/^\/msg(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/);
    if (!m) return ctx.reply('Usage: /msg <@username|id|all> <message>\nExample: /msg @abel Please start 15 min earlier tomorrow.\nOr open /panel → Team → person → ✉️ Send message.');
    return previewDraft(ctx, m[1].toLowerCase() === 'all' ? 'all' : m[1], m[2].trim());
  });

  bot.command('messages', adminOnly, async (ctx) => {
    const s = await listScreen();
    return ctx.reply(s.text, html(Markup.inlineKeyboard(s.rows)));
  });
  bot.action('msg:list', adminOnly, async (ctx) => {
    const s = await listScreen();
    await ctx.answerCbQuery();
    try { await ctx.editMessageText(s.text, html(Markup.inlineKeyboard(s.rows))); } catch (e) { /* unchanged */ }
  });

  // panel buttons: ask for the text, then preview it
  bot.action(/^msg:compose:(all|[a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const target = ctx.match[1];
    const rec = await resolveTargets(target, ctx.state.user._id);
    if (!rec.length) return ctx.answerCbQuery('No active recipient.', { show_alert: true });
    awaiting.set(ctx.from.id, { target, at: Date.now() });
    await ctx.answerCbQuery();
    return ctx.reply(
      `✍️ Type the message for <b>${target === 'all' ? `all agents (${rec.length})` : esc(rec[0].name)}</b> (max ${MAX_LEN} characters).\nYou will see a preview and confirm before it is sent.`,
      html(Markup.inlineKeyboard([
        [Markup.button.callback('📋 Use a template', `msg:tpl:${target}`)],
        [Markup.button.callback('❌ Cancel', 'msg:abort')],
      ]))
    );
  });

  // ---- availability requests ----
  bot.action('msg:avail', adminOnly, async (ctx) => {
    awaiting.set(ctx.from.id, { target: 'all', kind: 'availability', at: Date.now() });
    await ctx.answerCbQuery();
    return ctx.reply(
      '🙋 <b>Availability request</b>\nType the details agents should answer for.\nExample: <i>Tomorrow 2:00 morning–6:00 afternoon, extra shift. Are you available?</i>',
      html(Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'msg:abort')]]))
    );
  });
  bot.action(/^msg:sum:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const s = await availabilitySummary(ctx.match[1]);
    if (!s) return ctx.answerCbQuery('Not found.', { show_alert: true });
    await ctx.answerCbQuery();
    try { return await ctx.editMessageText(s.text, html(summaryButtons(s.id))); }
    catch (e) { return undefined; }
  });

  // ---- templates ----
  // pick a template for a recipient, then straight to the confirm preview
  bot.action(/^msg:tpl:(all|[a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const target = ctx.match[1];
    const tpls = await allTemplates();
    awaiting.delete(ctx.from.id);
    await ctx.answerCbQuery();
    const rows = tpls.map((t) => [Markup.button.callback(t.title, `msg:use:${target}:${t.id}`)]);
    rows.push([Markup.button.callback('❌ Cancel', 'msg:abort')]);
    const text = '📋 <b>Choose a template</b>\nYou will see a preview and confirm before it is sent.\n\n' +
      tpls.map((t) => `<b>${esc(t.title)}</b>\n${esc(t.text)}`).join('\n\n');
    try { return await ctx.editMessageText(text, html(Markup.inlineKeyboard(rows))); }
    catch (e) { return ctx.reply(text, html(Markup.inlineKeyboard(rows))); }
  });

  bot.action(/^msg:use:(all|[a-f0-9]{24}):(b\d|[a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const t = await findTemplate(ctx.match[2]);
    if (!t) return ctx.answerCbQuery('Template not found.', { show_alert: true });
    await ctx.answerCbQuery();
    return previewDraft(ctx, ctx.match[1], t.text);
  });

  // manage templates
  const templatesScreen = async () => {
    const tpls = await allTemplates();
    const rows = tpls.filter((t) => t.custom).map((t) => [Markup.button.callback(`🗑 Delete: ${t.title}`, `msg:tdel:${t.id}`)]);
    rows.push([Markup.button.callback('➕ New template', 'msg:tnew')], [Markup.button.callback('◀️ Messages', 'msg:list'), Markup.button.callback('🏠 Home', 'p:home')]);
    return {
      text: '📋 <b>Message templates</b>\n\n' + tpls.map((t) => `${t.custom ? '⭐' : '•'} <b>${esc(t.title)}</b>\n${esc(t.text)}`).join('\n\n') +
        '\n\n⭐ = yours. Add: <code>/addtemplate Title | message text</code>',
      rows,
    };
  };
  const saveTemplate = async (ctx, raw) => {
    const m = raw.match(/^([^|]{1,40})\|([\s\S]{1,1000})$/);
    if (!m || !m[1].trim() || !m[2].trim()) return ctx.reply('Format: <code>Title | message text</code>\nExample: <code>Late warning | You were late today. Please be on time.</code>', html());
    await Template.create({ title: m[1].trim(), text: m[2].trim(), createdBy: ctx.state.user._id });
    const s = await templatesScreen();
    return ctx.reply(`✅ Template saved.\n\n${s.text}`, html(Markup.inlineKeyboard(s.rows)));
  };
  bot.command('templates', adminOnly, async (ctx) => { const s = await templatesScreen(); return ctx.reply(s.text, html(Markup.inlineKeyboard(s.rows))); });
  bot.command('addtemplate', adminOnly, (ctx) => saveTemplate(ctx, ctx.message.text.replace(/^\/addtemplate(?:@\w+)?\s*/, '')));
  bot.action('msg:tpls', adminOnly, async (ctx) => {
    await ctx.answerCbQuery();
    const s = await templatesScreen();
    try { return await ctx.editMessageText(s.text, html(Markup.inlineKeyboard(s.rows))); } catch (e) { return undefined; }
  });
  bot.action('msg:tnew', adminOnly, async (ctx) => {
    awaiting.set(ctx.from.id, { target: '__template', at: Date.now() });
    await ctx.answerCbQuery();
    return ctx.reply('✍️ Send the new template as:\n<code>Title | message text</code>', html(Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'msg:abort')]])));
  });
  bot.action(/^msg:tdel:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    await Template.deleteOne({ _id: ctx.match[1] });
    await ctx.answerCbQuery('Deleted');
    const s = await templatesScreen();
    try { return await ctx.editMessageText(s.text, html(Markup.inlineKeyboard(s.rows))); } catch (e) { return undefined; }
  });
  bot.action('msg:abort', adminOnly, async (ctx) => {
    awaiting.delete(ctx.from.id);
    await ctx.answerCbQuery('Cancelled');
    try { await ctx.editMessageText('Cancelled.'); } catch (e) { /* ignore */ }
  });

  bot.action(/^msg:cancel:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const m = await Message.findOneAndUpdate({ _id: ctx.match[1], sender: ctx.state.user._id, status: 'draft' }, { status: 'cancelled' });
    await ctx.answerCbQuery(m ? 'Cancelled' : 'Already handled');
    try { await ctx.editMessageText('❌ Message cancelled. Nothing was sent.'); } catch (e) { /* ignore */ }
  });

  bot.action(/^msg:send:([a-f0-9]{24})$/, adminOnly, async (ctx) => {
    const sender = ctx.state.user;
    // atomic: only one press can move a draft to "sending"
    const m = await Message.findOneAndUpdate(
      { _id: ctx.match[1], sender: sender._id, status: 'draft', createdAt: { $gt: new Date(Date.now() - DRAFT_TTL_MIN * 60000) } },
      { status: 'sending' },
      { new: true }
    );
    if (!m) return ctx.answerCbQuery('This draft was already sent, cancelled or expired.', { show_alert: true });
    await ctx.answerCbQuery('Sending…');

    const avail = m.kind === 'availability';
    const kb = Markup.inlineKeyboard(avail
      ? [[Markup.button.callback('✅ I am available', `msg:av:y:${m._id}`), Markup.button.callback('❌ Not available', `msg:av:n:${m._id}`)]]
      : [[Markup.button.callback('✅ Got it', `msg:ack:${m._id}`)]]);
    const body = `${avail ? '🙋 <b>Availability request' : '📩 <b>Message'} from ${esc(sender.name)}</b>\n\n${esc(m.text)}${avail ? '\n\n<i>Please answer below.</i>' : ''}`;
    const failed = [];
    let ok = 0;
    for (const r of m.recipients) {
      let set;
      try {
        await notify.toUser(r.telegramId, body, kb);
        set = { 'recipients.$.status': 'sent', 'recipients.$.sentAt': new Date() };
        ok += 1;
      } catch (e) {
        set = { 'recipients.$.status': 'failed', 'recipients.$.error': String(e.description || e.message || '').slice(0, 100) };
        failed.push(r.user);
      }
      await Message.updateOne({ _id: m._id, 'recipients.user': r.user }, { $set: set });
    }
    await Message.updateOne({ _id: m._id }, { status: 'sent' });

    let text = `✅ <b>Sent</b> to ${ok}/${m.recipients.length}.`;
    if (failed.length) {
      const names = (await User.find({ _id: { $in: failed } })).map((u) => esc(u.name));
      text += `\n⚠️ Not delivered to: ${names.join(', ')} (they must press Start in the agents bot first).`;
    }
    text += avail ? '\nYou will be notified as agents answer.' : '\nYou will be notified when they press “Got it”. See /messages.';
    const after = avail ? html(summaryButtons(m._id)) : html();
    try { await ctx.editMessageText(text, after); } catch (e) { await ctx.reply(text, after); }
  });

  // Text typed after pressing "✉️ Send message" becomes the draft. Keep this registered last.
  bot.on('text', async (ctx, next) => {
    const st = awaiting.get(ctx.from.id);
    if (!st) return next();
    if (ctx.message.text.startsWith('/')) { awaiting.delete(ctx.from.id); return next(); } // a command aborts composing
    awaiting.delete(ctx.from.id);
    if (Date.now() - st.at > AWAIT_TTL_MIN * 60000) return ctx.reply('That took too long. Please start again from the panel.');
    if (ctx.state.user?.role !== 'admin') return next();
    if (st.target === '__template') return saveTemplate(ctx, ctx.message.text);
    return previewDraft(ctx, st.target, ctx.message.text, st.kind || 'text');
  });
}

/** Agent side: the "Got it" button and the availability answers. */
function registerAck(bot) {
  bot.action(/^msg:ack:([a-f0-9]{24})$/, async (ctx) => {
    const user = ctx.state.user;
    const m = await Message.findOneAndUpdate(
      { _id: ctx.match[1], recipients: { $elemMatch: { user: user._id, ackedAt: null } } },
      { $set: { 'recipients.$.ackedAt': new Date() } },
      { new: true }
    ).populate('sender');
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) { /* ignore */ }
    if (!m) return ctx.answerCbQuery('Already confirmed.');
    await ctx.answerCbQuery('Thanks, confirmed ✅');
    const short = m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text;
    return notify.toAdmin(m.sender.telegramId, `✅ <b>${esc(user.name)}</b> confirmed your message at ${fmtTime(new Date())}:\n“${esc(short)}”`);
  });

  // availability: the agent may change their answer until the supervisor closes the topic
  bot.action(/^msg:av:(y|n):([a-f0-9]{24})$/, async (ctx) => {
    const user = ctx.state.user;
    const yes = ctx.match[1] === 'y';
    const m = await Message.findOneAndUpdate(
      { _id: ctx.match[2], kind: 'availability', 'recipients.user': user._id },
      { $set: { 'recipients.$.answer': yes ? 'yes' : 'no', 'recipients.$.ackedAt': new Date() } },
      { new: true }
    ).populate('sender');
    if (!m) return ctx.answerCbQuery('This request is no longer open.', { show_alert: true });
    await ctx.answerCbQuery(yes ? 'Marked available ✅' : 'Marked not available ❌');
    const again = Markup.inlineKeyboard([[Markup.button.callback(yes ? '❌ Change to not available' : '✅ Change to available', `msg:av:${yes ? 'n' : 'y'}:${m._id}`)]]);
    try { await ctx.editMessageText(`🙋 <b>Availability request from ${esc(m.sender.name)}</b>\n\n${esc(m.text)}\n\n${yes ? '✅ You answered: <b>available</b>' : '❌ You answered: <b>not available</b>'}`, html(again)); } catch (e) { /* ignore */ }
    const sum = await availabilitySummary(m._id);
    return notify.toAdmin(m.sender.telegramId, `${yes ? '✅' : '❌'} <b>${esc(user.name)}</b> is ${yes ? '' : 'not '}available.\n\n${sum.text}`, summaryButtons(m._id));
  });
}

module.exports = { register, registerAck };
