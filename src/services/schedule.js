const Slot = require('../models/Slot');
const Booking = require('../models/Booking');
const { esc } = require('../utils/format');
const { DAY, parseDateTime, fmtTime } = require('../utils/time');
const { ensureDefaultSlots } = require('./defaultSlots');

/** Day schedule for supervisors: every slot with who reserved it. */
async function scheduleText(date) {
  const from = parseDateTime(date);
  if (!from) return null;
  await ensureDefaultSlots(date);
  const slots = await Slot.find({ start: { $gte: from, $lt: new Date(from.getTime() + DAY) } })
    .sort({ start: 1, account: 1 }).populate('account');
  if (!slots.length) return `🗓 <b>Schedule ${date}</b>\n\nNo slots on this day.`;
  const bookings = await Booking.find({ slot: { $in: slots.map((s) => s._id) } }).populate('user');
  const by = new Map();
  bookings.forEach((b) => { const k = String(b.slot); by.set(k, [...(by.get(k) || []), b]); });
  const reserved = slots.filter((s) => s.bookedCount > 0).length;
  const full = slots.filter((s) => s.bookedCount >= s.capacity).length;
  const multi = new Set(slots.map((s) => String(s.account._id))).size > 1;
  let text = `🗓 <b>Schedule</b> · ${date}\n🔴 ${full} full · 🟡 ${reserved - full} partial · 🟢 ${slots.length - reserved} free\n`;
  const PERIODS = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', night: '🌙 Night' };
  let lastPeriod = '';
  slots.slice(0, 70).forEach((s) => {
    const period = fmtTime(s.start).split(' ')[1];
    if (period !== lastPeriod) { text += `\n<b>${PERIODS[period] || period}</b>\n`; lastPeriod = period; }
    const list = by.get(String(s._id)) || [];
    const icon = s.bookedCount >= s.capacity ? '🔴' : s.bookedCount > 0 ? '🟡' : '🟢';
    const who = list.map((b) => `${esc(b.user.name)}${b.noShow ? ' (no-show)' : ''}`).join(', ');
    text += `${icon} ${fmtTime(s.start)}–${fmtTime(s.end)}${multi ? ` · ${esc(s.account.name)}` : ''}${s.capacity > 1 ? ` [${s.bookedCount}/${s.capacity}]` : ''}${who ? ` — <b>${who}</b>` : ''}\n`;
  });
  if (slots.length > 70) text += `\n… ${slots.length - 70} more`;
  return text.trimEnd();
}

module.exports = { scheduleText };
