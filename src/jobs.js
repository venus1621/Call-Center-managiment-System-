const cron = require('node-cron');
const { Markup } = require('telegraf');
const config = require('./config');
const Booking = require('./models/Booking');
const Session = require('./models/Session');
const User = require('./models/User');
const { esc, accountInfo } = require('./utils/format');
const { fmtTime, parseRange } = require('./utils/time');
const { hoursReport, renderReport } = require('./services/report');
const { prepareDefaultSchedule } = require('./services/defaultSlots');

const startBtn = Markup.inlineKeyboard([[Markup.button.callback('▶️ Start work', 'work:start')]]);

function startJobs(bot, adminBot = bot) {
  const send = async (chatId, text, extra = {}) => {
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra }); }
    catch (e) { console.error(`send to ${chatId} failed:`, e.message); }
  };

  const sendAdmin = async (chatId, text) => {
    try { await adminBot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }); }
    catch (e) { console.error(`admin send to ${chatId} failed:`, e.message); }
  };

  async function tick() {
    const now = new Date();

    // 1) Pre-shift alarm: "your slot starts in N minutes"
    const soon = await Booking.find({
      preAlarmSent: false,
      start: { $gt: now, $lte: new Date(now.getTime() + config.alarmMinBefore * 60000) },
    }).populate('account user');
    for (const b of soon) {
      const mins = Math.max(1, Math.round((b.start - now) / 60000));
      await Booking.updateOne({ _id: b._id }, { preAlarmSent: true });
      await send(b.user.telegramId, `⏰ <b>Your slot starts in ${mins} min</b> (${fmtTime(b.start)}–${fmtTime(b.end)})\n\n${accountInfo(b.account, b.agentCode)}`, startBtn);
    }

    // 2) Reminder if the agent has not pressed Start shortly after the slot began
    const late = await Booking.find({
      startReminderSent: false,
      start: { $lte: new Date(now.getTime() - config.startReminderMin * 60000) },
      end: { $gt: now },
    }).populate('account user');
    for (const b of late) {
      await Booking.updateOne({ _id: b._id }, { startReminderSent: true });
      if (await Session.exists({ slot: b.slot, user: b.user._id })) continue;
      await send(b.user.telegramId, `⚠️ Your slot began at ${fmtTime(b.start)} and you haven't started yet.\n\n${accountInfo(b.account, b.agentCode)}`, startBtn);
    }

    // 3) Auto-close sessions the agent forgot to end
    const active = await Session.find({ status: 'active' }).populate('slot user');
    for (const sess of active) {
      if (now.getTime() >= sess.slot.end.getTime() + config.autoCloseGraceMin * 60000) {
        const endedAt = sess.slot.end > sess.startedAt ? sess.slot.end : now;
        await Session.updateOne({ _id: sess._id }, { endedAt, status: 'auto-closed' });
        await send(sess.user.telegramId, `ℹ️ Your session was closed automatically at ${fmtTime(endedAt)} because you did not press End. Please use ⏹ End work next time.`);
      }
    }

    // 4) Evaluate finished reservations -> mark no-shows
    const done = await Booking.find({ finalized: false, end: { $lte: now } }).populate('user account');
    for (const b of done) {
      const worked = await Session.exists({ slot: b.slot, user: b.user._id });
      await Booking.updateOne({ _id: b._id }, { finalized: true, noShow: !worked });
      if (!worked) await send(b.user.telegramId, `❌ No-show: you reserved ${esc(b.account.name)} ${fmtTime(b.start)}–${fmtTime(b.end)} but did not start work.`);
    }
  }

  async function dailySummary() {
    const range = parseRange(['today']);
    const [byUser, byAcc] = await Promise.all([
      hoursReport(range.from, range.to, { by: 'user' }),
      hoursReport(range.from, range.to, { by: 'account' }),
    ]);
    const text = `${renderReport('Daily summary – agents', range.label, byUser)}\n\n${renderReport('Daily summary – accounts', range.label, byAcc)}`;
    const admins = await User.find({ role: 'admin', active: true });
    for (const a of admins) await sendAdmin(a.telegramId, text);
  }

  cron.schedule('* * * * *', () => tick().catch((e) => console.error('tick error:', e)));
  cron.schedule('0 0 * * *', () => prepareDefaultSchedule().catch((e) => console.error('default schedule error:', e)), { timezone: config.tz });
  cron.schedule(`0 ${config.dailySummaryHour} * * *`, () => dailySummary().catch((e) => console.error('summary error:', e)), { timezone: config.tz });
}

module.exports = { startJobs };
