const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { randomBytes } = require('node:crypto');

process.env.BOT_TOKEN = '123456:test';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.MONGO_URI = process.env.JOIN_TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
process.env.ADMIN_IDS = '9001';

// Capture cron callbacks so the background job tick can be driven by the tests.
const cronModule = require('node-cron');
const cronCallbacks = [];
cronModule.schedule = (expr, fn) => { cronCallbacks.push({ expr, fn }); return { stop() {} }; };

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const config = require('../src/config');
const User = require('../src/models/User');
const Account = require('../src/models/Account');
const Slot = require('../src/models/Slot');
const Booking = require('../src/models/Booking');
const Session = require('../src/models/Session');
const ScheduleOverride = require('../src/models/ScheduleOverride');
const { auth } = require('../src/middleware/auth');
const agent = require('../src/handlers/agent');
const { reserveSlots, ReservationError } = require('../src/services/reservations');
const { startJobs } = require('../src/jobs');

const dbName = `call_center_bot_slots_test_${process.pid}_${randomBytes(5).toString('hex')}`;
const MIN = 60000;
let account;
let events;
let bot;
let updateId = 0;
const users = {};

// All times are relative to "now" and rounded to whole seconds so tests stay deterministic.
const at = (offsetMin) => new Date(Math.round((Date.now() + offsetMin * MIN) / 1000) * 1000);
const mk = (offsetMin, { dur = 30, capacity = 1, acc = account } = {}) =>
  Slot.create({ account: acc._id, start: at(offsetMin), end: at(offsetMin + dur), capacity });
const reserve = (user, ...slots) => reserveSlots(user, slots.map((s) => String(s._id)));
const rejects = (promise, pattern) => assert.rejects(promise, (err) => err instanceof ReservationError && pattern.test(err.message));

before(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), Account.init(), Slot.init(), Booking.init(), Session.init(), ScheduleOverride.init()]);
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Account.deleteMany({}), Slot.deleteMany({}), Booking.deleteMany({}), Session.deleteMany({}), ScheduleOverride.deleteMany({})]);
  Object.assign(config, {
    defaultCapacity: 1, minNoticeMin: 0, maxHoursPerDay: 8, cancelDeadlineMin: 60,
    earlyStartMin: 10, alarmMinBefore: 15, startReminderMin: 5, autoCloseGraceMin: 10, adminIds: [9001],
  });
  account = await Account.create({ name: 'T-01', active: true, username: 'login', password: 'x' });
  users.a = await User.create({ telegramId: 1001, name: 'Agent A' });
  users.b = await User.create({ telegramId: 1002, name: 'Agent B' });
  users.c = await User.create({ telegramId: 1003, name: 'Agent C' });
  events = [];
  bot = new Telegraf('123456:test');
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'timing_test_bot' };
  for (const method of ['reply', 'answerCbQuery', 'editMessageText']) {
    bot.context[method] = async function (...args) { events.push({ method, chatId: this.chat?.id, args }); return { message_id: updateId }; };
  }
  bot.use(auth);
  agent.register(bot);
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
  } finally { await mongoose.disconnect(); }
});

const from = (id) => ({ id, is_bot: false, first_name: `User ${id}` });
const callback = (id, data) => bot.handleUpdate({
  update_id: ++updateId,
  callback_query: {
    id: String(updateId), from: from(id), chat_instance: 'test', data,
    message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: bot.botInfo, text: 'x' },
  },
});
const command = (id, text) => bot.handleUpdate({
  update_id: ++updateId,
  message: {
    message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: from(id), text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  },
});
const lastEvent = (method) => events.filter((e) => e.method === method).at(-1);
const toast = () => lastEvent('answerCbQuery')?.args[0] || '';
const replyText = () => lastEvent('reply')?.args[0] || '';

// ---------- capacity & concurrency ----------

test('capacity 2: two agents share a slot, the third is rejected, bookedCount is exact', async () => {
  const slot = await mk(120, { capacity: 2 });
  await reserve(users.a, slot);
  await reserve(users.b, slot);
  await rejects(reserve(users.c, slot), /full|no longer available/);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 2);
  assert.equal(await Booking.countDocuments({ slot: slot._id }), 2);
});

test('capacity 1: second agent is rejected', async () => {
  const slot = await mk(120);
  await reserve(users.a, slot);
  await rejects(reserve(users.b, slot), /full|no longer available/);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('five agents racing for a capacity-2 slot: exactly two win, count is consistent', async () => {
  const extra = await Promise.all([4, 5].map((n) => User.create({ telegramId: 2000 + n, name: `Agent ${n}` })));
  const slot = await mk(120, { capacity: 2 });
  const racers = [users.a, users.b, users.c, ...extra];
  const results = await Promise.allSettled(racers.map((u) => reserve(u, slot)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof ReservationError), true);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 2);
  assert.equal(await Booking.countDocuments({ slot: slot._id }), 2);
});

test('same agent double-clicking reserve creates one booking', async () => {
  const slot = await mk(120, { capacity: 2 });
  const results = await Promise.allSettled([reserve(users.a, slot), reserve(users.a, slot), reserve(users.a, slot)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await Booking.countDocuments({ user: users.a._id }), 1);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

// ---------- timing: how close to the start you may reserve ----------

test('a slot that already started cannot be reserved (even with no notice period)', async () => {
  const slot = await mk(-5);
  await rejects(reserve(users.a, slot), /already started/);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 0);
});

test('minimum notice: 20 min away is rejected, 40 min away is accepted (notice = 30)', async () => {
  config.minNoticeMin = 30;
  const near = await mk(20);
  const far = await mk(60);
  await rejects(reserve(users.a, near), /close 30 min before/);
  await reserve(users.a, far);
  assert.equal(await Booking.countDocuments({ user: users.a._id }), 1);
});

test('no notice period: a slot starting in 1 minute can still be reserved', async () => {
  const slot = await mk(1);
  await reserve(users.a, slot);
  assert.equal(await Booking.countDocuments(), 1);
});

// ---------- overlap, adjacency, daily limits ----------

test('back-to-back slots (end == start) are allowed, overlapping slots are rejected', async () => {
  const first = await mk(120, { dur: 30 });
  const adjacent = await mk(150, { dur: 30 });
  const overlapping = await mk(140, { dur: 30 }); // overlaps both
  await reserve(users.a, first, adjacent);
  assert.equal(await Booking.countDocuments({ user: users.a._id }), 2);
  await rejects(reserve(users.a, overlapping), /overlaps/);
});

test('overlap across two accounts is rejected as one batch with no partial booking', async () => {
  const other = await Account.create({ name: 'T-02', active: true });
  const s1 = await mk(300, { dur: 60 });
  const s2 = await mk(330, { dur: 60, acc: other });
  await rejects(reserve(users.a, s1, s2), /overlap/);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal((await Slot.findById(s1._id)).bookedCount, 0);
  assert.equal((await Slot.findById(s2._id)).bookedCount, 0);
});

test('daily limit: exactly the maximum is accepted, one more minute is rejected', async () => {
  config.maxHoursPerDay = 2;
  // Anchor to a local day far enough ahead that all slots share one date.
  const base = 24 * 60 * 3;
  const a = await mk(base, { dur: 60 });
  const b = await mk(base + 60, { dur: 60 });
  const c = await mk(base + 120, { dur: 1 });
  await reserve(users.a, a, b); // 120 min = limit
  await rejects(reserve(users.a, c), /Daily limit/);
  assert.equal(await Booking.countDocuments({ user: users.a._id }), 2);
});

test('daily limit is per day: the same hours on different days are fine', async () => {
  config.maxHoursPerDay = 1;
  const day1 = await mk(24 * 60 * 3, { dur: 60 });
  const day2 = await mk(24 * 60 * 5, { dur: 60 });
  await reserve(users.a, day1);
  await reserve(users.a, day2);
  assert.equal(await Booking.countDocuments({ user: users.a._id }), 2);
});

test('disabled account slots cannot be reserved', async () => {
  const slot = await mk(120);
  await Account.updateOne({ _id: account._id }, { active: false });
  await rejects(reserve(users.a, slot), /no longer available/);
});

test('empty selection and unknown slot are rejected', async () => {
  await rejects(reserveSlots(users.a, []), /at least one/);
  await rejects(reserveSlots(users.a, [String(new mongoose.Types.ObjectId())]), /no longer available/);
});

// ---------- cancellation timing ----------

async function bookAndCancel(user, offsetMin) {
  const slot = await mk(offsetMin);
  await reserve(user, slot);
  const booking = await Booking.findOne({ slot: slot._id, user: user._id });
  await callback(user.telegramId, `slot:cancel:${booking._id}`);
  return { slot, booking };
}

test('cancel 90 min before start (deadline 60): allowed and seat is released', async () => {
  const { slot, booking } = await bookAndCancel(users.a, 90);
  assert.equal(await Booking.findById(booking._id), null);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 0);
  await reserve(users.b, slot); // freed seat can be re-booked
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('cancel 30 min before start (deadline 60): rejected, booking and seat kept', async () => {
  const { slot, booking } = await bookAndCancel(users.a, 30);
  assert.match(toast(), /Too late to cancel/);
  assert.ok(await Booking.findById(booking._id));
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('cancel boundary: 59 min rejected, 61 min allowed', async () => {
  const late = await bookAndCancel(users.a, 59);
  assert.ok(await Booking.findById(late.booking._id));
  const ok = await bookAndCancel(users.b, 61);
  assert.equal(await Booking.findById(ok.booking._id), null);
});

test('cancelling after the slot started is rejected', async () => {
  const slot = await mk(-5);
  const booking = await Booking.create({ slot: slot._id, user: users.a._id, account: account._id, start: slot.start, end: slot.end });
  await Slot.updateOne({ _id: slot._id }, { bookedCount: 1 });
  await callback(1001, `slot:cancel:${booking._id}`);
  assert.match(toast(), /Too late/);
  assert.ok(await Booking.findById(booking._id));
});

test("an agent cannot cancel another agent's reservation", async () => {
  const slot = await mk(120);
  await reserve(users.a, slot);
  const booking = await Booking.findOne({ user: users.a._id });
  await callback(1002, `slot:cancel:${booking._id}`);
  assert.ok(await Booking.findById(booking._id));
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('cancelling twice only frees one seat', async () => {
  const slot = await mk(120, { capacity: 2 });
  await reserve(users.a, slot);
  await reserve(users.b, slot);
  const booking = await Booking.findOne({ user: users.a._id });
  await callback(1001, `slot:cancel:${booking._id}`);
  await callback(1001, `slot:cancel:${booking._id}`);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('my reservations: Cancel button only outside the deadline, Start only inside the early window', async () => {
  const early = await mk(120);
  const soon = await mk(8); // inside earlyStart (10) and inside cancel deadline
  await reserve(users.a, early);
  await reserve(users.a, soon);
  await command(1001, '/mybookings');
  const kb = lastEvent('reply').args[1].reply_markup.inline_keyboard.flat();
  const cancels = kb.filter((b) => b.callback_data?.startsWith('slot:cancel:'));
  assert.equal(cancels.length, 1);
  assert.ok(kb.some((b) => b.callback_data === 'work:start'));
});

// ---------- start / end work timing ----------

test('start work 15 min before the slot (early window 10): refused', async () => {
  await reserve(users.a, await mk(15));
  await command(1001, '/startwork');
  assert.match(replyText(), /no reserved slot right now/);
  assert.equal(await Session.countDocuments(), 0);
});

test('start work 5 min before the slot: allowed with 0 late minutes', async () => {
  await reserve(users.a, await mk(5));
  await command(1001, '/startwork');
  const session = await Session.findOne({ user: users.a._id });
  assert.equal(session.status, 'active');
  assert.equal(session.lateMinutes, 0);
});

test('start work 7 min after the slot began: recorded as 7 min late', async () => {
  const slot = await Slot.create({ account: account._id, start: at(-7), end: at(23), capacity: 1, bookedCount: 1 });
  await Booking.create({ slot: slot._id, user: users.a._id, account: account._id, start: slot.start, end: slot.end });
  await command(1001, '/startwork');
  const session = await Session.findOne({ user: users.a._id });
  assert.equal(session.lateMinutes, 7);
});

test('start work after the slot ended is refused', async () => {
  const slot = await Slot.create({ account: account._id, start: at(-40), end: at(-10), capacity: 1, bookedCount: 1 });
  await Booking.create({ slot: slot._id, user: users.a._id, account: account._id, start: slot.start, end: slot.end });
  await command(1001, '/startwork');
  assert.match(replyText(), /no reserved slot right now/);
});

test('start work without any reservation is refused', async () => {
  await command(1001, '/startwork');
  assert.match(replyText(), /no reserved slot/);
});

test('starting twice reports the active session; end work completes it; ending again says none', async () => {
  await reserve(users.a, await mk(2));
  await command(1001, '/startwork');
  await command(1001, '/startwork');
  assert.match(replyText(), /already have an active session/);
  assert.equal(await Session.countDocuments({ user: users.a._id }), 1);
  await command(1001, '/endwork');
  assert.equal((await Session.findOne({ user: users.a._id })).status, 'completed');
  await command(1001, '/endwork');
  assert.match(replyText(), /no active session/);
});

test("one agent cannot start work using another agent's reservation", async () => {
  await reserve(users.a, await mk(2));
  await command(1002, '/startwork');
  assert.match(replyText(), /no reserved slot/);
  assert.equal(await Session.countDocuments(), 0);
});

// ---------- background jobs (tick) ----------

function makeTick() {
  cronCallbacks.length = 0;
  const sent = [];
  const fake = { telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); } } };
  startJobs(fake, fake);
  const tick = cronCallbacks.find((c) => c.expr === '* * * * *').fn;
  return { tick, sent };
}
// Each seeded booking gets its own account so identical start times never collide on the unique slot index.
let seedCount = 0;
const seedBooking = async (user, startOffset, endOffset, extra = {}) => {
  const acc = await Account.create({ name: `S-${++seedCount}`, active: true });
  const slot = await Slot.create({ account: acc._id, start: at(startOffset), end: at(endOffset), capacity: 1, bookedCount: 1 });
  const booking = await Booking.create({ slot: slot._id, user: user._id, account: acc._id, start: slot.start, end: slot.end, ...extra });
  return { slot, booking, acc };
};

test('job: pre-shift alarm fires once, 10 min before start, not 30 min before', async () => {
  const { tick, sent } = makeTick();
  await seedBooking(users.a, 30, 60);
  await tick();
  assert.equal(sent.length, 0);
  const { booking } = await seedBooking(users.b, 10, 40);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 1002);
  assert.match(sent[0].text, /starts in/);
  assert.equal((await Booking.findById(booking._id)).preAlarmSent, true);
  await tick();
  assert.equal(sent.length, 1, 'alarm must not repeat');
});

test('job: reminder 6 min after start if agent has not started; none if already working; sent once', async () => {
  const { tick, sent } = makeTick();
  const idle = await seedBooking(users.a, -6, 24);
  const working = await seedBooking(users.b, -6, 24);
  await Session.create({ slot: working.slot._id, account: working.acc._id, user: users.b._id, startedAt: at(-5) });
  await tick();
  const reminders = sent.filter((m) => /haven't started/.test(m.text));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].chatId, 1001);
  await tick();
  assert.equal(sent.filter((m) => /haven't started/.test(m.text)).length, 1);
  assert.equal((await Booking.findById(idle.booking._id)).startReminderSent, true);
});

test('job: no reminder 3 min after start (reminder threshold is 5)', async () => {
  const { tick, sent } = makeTick();
  await seedBooking(users.a, -3, 27);
  await tick();
  assert.equal(sent.filter((m) => /haven't started/.test(m.text)).length, 0);
});

test('job: active session auto-closes only after end + grace', async () => {
  const { tick, sent } = makeTick();
  const early = await seedBooking(users.a, -40, -5); // ended 5 min ago, grace 10 → keep
  const late = await seedBooking(users.b, -50, -15); // ended 15 min ago → close
  const s1 = await Session.create({ slot: early.slot._id, account: early.acc._id, user: users.a._id, startedAt: at(-40) });
  const s2 = await Session.create({ slot: late.slot._id, account: late.acc._id, user: users.b._id, startedAt: at(-50) });
  await tick();
  assert.equal((await Session.findById(s1._id)).status, 'active');
  const closed = await Session.findById(s2._id);
  assert.equal(closed.status, 'auto-closed');
  assert.equal(closed.endedAt.getTime(), late.slot.end.getTime());
  assert.ok(sent.some((m) => m.chatId === 1002 && /closed automatically/.test(m.text)));
});

test('job: finished reservations are finalized — no-show without a session, not when worked', async () => {
  const { tick, sent } = makeTick();
  const missed = await seedBooking(users.a, -60, -30);
  const worked = await seedBooking(users.b, -60, -30);
  const future = await seedBooking(users.c, 60, 90);
  await Session.create({ slot: worked.slot._id, account: worked.acc._id, user: users.b._id, startedAt: at(-58), endedAt: at(-31), status: 'completed' });
  await tick();
  const m = await Booking.findById(missed.booking._id);
  const w = await Booking.findById(worked.booking._id);
  const f = await Booking.findById(future.booking._id);
  assert.deepEqual([m.finalized, m.noShow], [true, true]);
  assert.deepEqual([w.finalized, w.noShow], [true, false]);
  assert.deepEqual([f.finalized, f.noShow], [false, false]);
  assert.equal(sent.filter((x) => /No-show/.test(x.text)).length, 1);
  assert.equal(sent.find((x) => /No-show/.test(x.text)).chatId, 1001);
  await tick();
  assert.equal(sent.filter((x) => /No-show/.test(x.text)).length, 1, 'no-show must be reported once');
});

// ---------- confirmation message shows the confirmed time ----------

test('booking confirmation states the exact confirmed time, matching the stored booking', async () => {
  const { fmtTime, fmtDate } = require('../src/utils/time');
  const slot = await mk(120, { dur: 60 });
  await callback(1001, `slot:book:${slot._id}`);
  const booking = await Booking.findOne({ user: users.a._id });
  assert.ok(booking, 'booking was stored');
  const expected = `${fmtDate(slot.start)} ${fmtTime(slot.start)}–${fmtTime(slot.end)}`;
  assert.equal(booking.start.getTime(), slot.start.getTime());
  assert.equal(booking.end.getTime(), slot.end.getTime());
  assert.match(toast(), new RegExp(`Reserved ${fmtTime(slot.start)}–${fmtTime(slot.end)}`));
  assert.match(replyText(), /confirmed/);
  assert.ok(replyText().includes(expected), `confirmation should contain "${expected}"`);
  assert.equal(String(booking.account), String(account._id));
});

test('batch confirmation lists every confirmed time; a failed booking sends no confirmation', async () => {
  const { fmtTime } = require('../src/utils/time');
  const s1 = await mk(180, { dur: 30 });
  const s2 = await mk(240, { dur: 30 });
  const text = require('../src/handlers/agent');
  assert.ok(text);
  await reserve(users.b, s2); // s2 now full
  events.length = 0;
  await callback(1001, `slot:book:${s2._id}`); // must fail
  assert.equal(events.some((e) => e.method === 'reply' && /confirmed/.test(e.args[0])), false);
  assert.match(toast(), /full|no longer available|last place/);
  await callback(1001, `slot:book:${s1._id}`);
  assert.ok(replyText().includes(`${fmtTime(s1.start)}–${fmtTime(s1.end)}`));
});
