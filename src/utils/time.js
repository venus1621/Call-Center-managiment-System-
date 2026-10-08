const config = require('../config');

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** "2026-10-08" + "09:30" in the configured timezone -> Date (or null) */
function parseDateTime(dateStr, timeStr = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !/^\d{1,2}:\d{2}$/.test(timeStr || '')) return null;
  const [h, m] = timeStr.split(':');
  const d = new Date(`${dateStr}T${pad(h)}:${m}:00${config.tzOffset}`);
  return isNaN(d.getTime()) ? null : d;
}

/** Keep standard clock parsing separate from the Ethiopian clock shown to people. */
function parseSlotTime(dateStr, timeStr) {
  if (typeof timeStr !== 'string') return null;
  const match = timeStr.match(/^(0?[1-9]|1[0-2]):([0-5]\d)(day|morning|afternoon|night|d|n)$/i);
  if (!match) return parseDateTime(dateStr, timeStr);
  const night = ['night', 'n'].includes(match[3].toLowerCase());
  const hour = (Number(match[1]) % 12 + (night ? 18 : 6)) % 24;
  if (match[3].toLowerCase() === 'morning' && (hour < 6 || hour >= 12)) return null;
  if (match[3].toLowerCase() === 'afternoon' && (hour < 12 || hour >= 18)) return null;
  return parseDateTime(dateStr, `${pad(hour)}:${match[2]}`);
}

function fmtTime(d) {
  const standard = new Date(d).toLocaleTimeString('en-GB', {
    timeZone: config.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const [hour, minute] = standard.split(':').map(Number);
  const ethiopianHour = (hour + 6) % 12 || 12;
  const period = hour < 6 || hour >= 18 ? 'night' : hour < 12 ? 'morning' : 'afternoon';
  return `${ethiopianHour}:${pad(minute)} ${period}`;
}
const fmtDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: config.tz });
const fmtDateTime = (d) => `${fmtDate(d)} ${fmtTime(d)}`;
const todayStr = () => fmtDate(new Date());
const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** minutes -> "7:05" */
const fmtHM = (min) => {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}:${pad(t % 60)}`;
};
/** minutes -> "7h 05m" */
const fmtHm = (min) => {
  const t = Math.round(min);
  return `${Math.floor(t / 60)}h ${pad(t % 60)}m`;
};
const fmtDiff = (min) => `${min < 0 ? '-' : '+'}${fmtHM(Math.abs(min))}`;

/**
 * args: [] | ['today'|'yesterday'|'week'|'month'] | ['YYYY-MM-DD'] | ['YYYY-MM-DD','YYYY-MM-DD']
 * returns { from, to (exclusive), label } or null if invalid
 */
function parseRange(args = []) {
  const today = todayStr();
  const a = (args[0] || 'today').toLowerCase();
  let fromStr;
  let toStr;
  if (a === 'today') fromStr = toStr = today;
  else if (a === 'yesterday') fromStr = toStr = addDays(today, -1);
  else if (a === 'week') {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    fromStr = addDays(today, -((dow + 6) % 7));
    toStr = addDays(fromStr, 6);
  } else if (a === 'month') {
    const [y, m] = today.split('-').map(Number);
    fromStr = `${y}-${pad(m)}-01`;
    toStr = addDays(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1);
  } else {
    fromStr = args[0];
    toStr = args[1] || args[0];
  }
  const from = parseDateTime(fromStr);
  const toDay = parseDateTime(toStr);
  if (!from || !toDay || toDay < from) return null;
  return {
    from,
    to: new Date(toDay.getTime() + DAY),
    label: fromStr === toStr ? fromStr : `${fromStr} → ${toStr}`,
  };
}

module.exports = {
  DAY, parseDateTime, parseSlotTime, fmtTime, fmtDate, fmtDateTime, todayStr, addDays,
  fmtHM, fmtHm, fmtDiff, parseRange,
};
