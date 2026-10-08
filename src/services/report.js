const Booking = require('../models/Booking');
const Slot = require('../models/Slot');
const Session = require('../models/Session');
const User = require('../models/User');
const Account = require('../models/Account');
const { esc } = require('../utils/format');
const { fmtHM, fmtDiff, fmtTime, fmtDate } = require('../utils/time');

const minutes = { $divide: [{ $subtract: ['$end', '$start'] }, 60000] };


/**
 * Booked vs worked minutes grouped by user or account.
 *  by: 'user' | 'account'; id: optional ObjectId to restrict to one user/account
 */
async function hoursReport(from, to, { by = 'user', id = null, account = null } = {}) {
  const slotKey = by === 'user' ? 'user' : 'account';
  const sessKey = by === 'user' ? 'user' : 'account';

  const slotMatch = { start: { $gte: from, $lt: to } };
  const sessMatch = { startedAt: { $gte: from, $lt: to }, endedAt: { $ne: null } };
  if (id) { slotMatch[slotKey] = id; sessMatch[sessKey] = id; }
  if (account) { slotMatch.account = account; sessMatch.account = account; }

  const [booked, worked] = await Promise.all([
    Booking.aggregate([
      { $match: slotMatch },
      {
        $group: {
          _id: `$${slotKey}`,
          bookedMin: { $sum: minutes },
          slots: { $sum: 1 },
          noShows: { $sum: { $cond: ['$noShow', 1, 0] } },
        },
      },
    ]),
    Session.aggregate([
      { $match: sessMatch },
      {
        $group: {
          _id: `$${sessKey}`,
          workedMin: { $sum: { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 60000] } },
        },
      },
    ]),
  ]);

  const map = new Map();
  const row = (k) => {
    const key = String(k);
    if (!map.has(key)) map.set(key, { id: k, name: '?', bookedMin: 0, workedMin: 0, slots: 0, noShows: 0 });
    return map.get(key);
  };
  booked.forEach((b) => Object.assign(row(b._id), { bookedMin: b.bookedMin, slots: b.slots, noShows: b.noShows }));
  worked.forEach((w) => { row(w._id).workedMin = w.workedMin; });

  const docs = await (by === 'user' ? User : Account).find({ _id: { $in: [...map.values()].map((r) => r.id) } });
  docs.forEach((d) => { map.get(String(d._id)).name = d.name; });

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const bar = (done, total) => {
  const n = total > 0 ? Math.min(10, Math.round((done / total) * 10)) : 0;
  return '█'.repeat(n) + '░'.repeat(10 - n);
};

/** One card per row + a team total; easy to read on a phone. */
function renderReport(title, label, rows) {
  const head = `📊 <b>${esc(title)}</b>\n${esc(label)}\n`;
  if (!rows.length) return `${head}\nNo data for this range.`;
  const total = rows.reduce(
    (t, r) => ({ b: t.b + r.bookedMin, w: t.w + r.workedMin, n: t.n + r.noShows }),
    { b: 0, w: 0, n: 0 }
  );
  const rate = (w, b) => (b > 0 ? Math.round((w / b) * 100) : 0);
  let t = `${head}\n<b>Total</b>\n📅 Booked ${fmtHM(total.b)} · ▶️ Worked ${fmtHM(total.w)}\n${bar(total.w, total.b)} ${rate(total.w, total.b)}%${total.n ? ` · ❌ ${total.n} no-show${total.n === 1 ? '' : 's'}` : ''}\n`;
  rows.forEach((r) => {
    t += `\n<b>${esc(r.name)}</b>\n📅 ${fmtHM(r.bookedMin)} · ▶️ ${fmtHM(r.workedMin)} · ${fmtDiff(r.workedMin - r.bookedMin)}${r.noShows ? ` · ❌ ${r.noShows}` : ''}\n`;
  });
  return `${t.trimEnd()}\n\n<i>Hours shown as h:mm. Diff = worked − booked.</i>`;
}

const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

/** Full report for one call center account over a range. */
async function accountDetail(accountId, range) {
  const acc = await Account.findById(accountId);
  if (!acc) return null;
  const { from, to } = range;
  const Session = require('../models/Session');
  const [slots, users, sessions, active] = await Promise.all([
    Slot.find({ account: acc._id, start: { $gte: from, $lt: to } }),
    hoursReport(from, to, { by: 'user', account: acc._id }),
    Session.find({ account: acc._id, startedAt: { $gte: from, $lt: to } }).sort({ startedAt: -1 }).limit(10).populate('user'),
    Session.find({ account: acc._id, status: 'active' }).populate('user'),
  ]);
  const len = (x) => (x.end - x.start) / 60000;
  return {
    acc, users, sessions, active,
    publishedMin: slots.reduce((t, x) => t + len(x), 0),
    reservedMin: slots.filter((x) => x.bookedCount > 0).reduce((t, x) => t + len(x), 0),
    seats: slots.reduce((t, x) => t + x.capacity, 0),
    seatsTaken: slots.reduce((t, x) => t + x.bookedCount, 0),
    bookedMin: users.reduce((t, r) => t + r.bookedMin, 0),
    workedMin: users.reduce((t, r) => t + r.workedMin, 0),
    noShows: users.reduce((t, r) => t + r.noShows, 0),
  };
}

function renderAccountDetail(d, label) {
  const now = !d.acc.active ? '⛔ disabled'
    : d.active.length ? `🟢 in use: ${d.active.map((x) => `${esc(x.user.name)} since ${fmtTime(x.startedAt)}`).join('; ')}`
      : '⚪ free';
  let t = `🔑 <b>Account ${esc(d.acc.name)}</b>\n${esc(label)}\nStatus now: ${now}\n\n`;
  t += `Published time: <b>${fmtHM(d.publishedMin)}</b>\n`;
  t += `Reserved time: <b>${fmtHM(d.reservedMin)}</b> (${pct(d.reservedMin, d.publishedMin)} of published)\n`;
  t += `Places taken: <b>${d.seatsTaken}/${d.seats}</b> (${pct(d.seatsTaken, d.seats)})\n`;
  t += `Agent-hours booked: <b>${fmtHM(d.bookedMin)}</b> · worked: <b>${fmtHM(d.workedMin)}</b> · no-shows: <b>${d.noShows}</b>\n`;
  t += `\n${renderReport('Per agent on this account', label, d.users)}`;
  if (d.sessions.length) {
    t += '\n\n<b>Recent sessions</b>';
    d.sessions.forEach((x) => {
      const dur = x.endedAt ? `${Math.round((x.endedAt - x.startedAt) / 60000)} min` : 'running';
      t += `\n• ${fmtDate(x.startedAt)} ${fmtTime(x.startedAt)}${x.endedAt ? '–' + fmtTime(x.endedAt) : ''} ${esc(x.user.name)} (${dur})${x.lateMinutes ? ` late ${x.lateMinutes}m` : ''}${x.status === 'auto-closed' ? ' auto-closed' : ''}`;
    });
  }
  return t;
}

module.exports = { hoursReport, renderReport, accountDetail, renderAccountDetail };
