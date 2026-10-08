require('dotenv').config();

const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing required env variable: ${k}`);
  return process.env[k];
};
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

const config = {
  botToken: need('BOT_TOKEN'),
  adminBotToken: process.env.ADMIN_BOT_TOKEN || '', // optional second bot just for supervisors
  mongoUri: need('MONGO_URI'),
  encKey: need('ENCRYPTION_KEY'),
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  tz: process.env.TZ_NAME || 'Africa/Addis_Ababa',
  tzOffset: process.env.TZ_OFFSET || '+03:00',
  maxCapacity: 2, // hard limit: at most 2 users per slot
  defaultCapacity: Math.min(2, Math.max(1, num('DEFAULT_SLOT_CAPACITY', 1))),
  defaultSlotStart: process.env.DEFAULT_SLOT_START || '08:00',
  defaultSlotEnd: process.env.DEFAULT_SLOT_END || '22:00',
  defaultSlotMinutes: num('DEFAULT_SLOT_MINUTES', 60),
  maxHoursPerDay: num('MAX_HOURS_PER_DAY', 8),
  minNoticeMin: num('MIN_NOTICE_MIN', 0),
  cancelDeadlineMin: num('CANCEL_DEADLINE_MIN', 60),
  alarmMinBefore: num('ALARM_MIN_BEFORE', 15),
  startReminderMin: num('START_REMINDER_MIN', 5),
  earlyStartMin: num('EARLY_START_MIN', 10),
  autoCloseGraceMin: num('AUTO_CLOSE_GRACE_MIN', 10),
  dailySummaryHour: num('DAILY_SUMMARY_HOUR', 18),
  showPassword: process.env.SHOW_PASSWORD === 'true',
};

if (!/^[0-9a-fA-F]{64}$/.test(config.encKey)) {
  throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
}
const timeMinutes = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
const dailyMinutes = timeMinutes(config.defaultSlotEnd) - timeMinutes(config.defaultSlotStart);
if (!(dailyMinutes > 0) || !Number.isInteger(config.defaultSlotMinutes) || config.defaultSlotMinutes < 5 || dailyMinutes % config.defaultSlotMinutes !== 0) {
  throw new Error('Default slots need valid HH:MM start/end times on the same day and a whole slot length of at least 5 minutes that divides the daily window.');
}
module.exports = config;
