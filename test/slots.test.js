const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { randomBytes } = require('node:crypto');

process.env.BOT_TOKEN = '123456:test';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.MONGO_URI = process.env.JOIN_TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
process.env.ADMIN_IDS = '9001';
process.env.DEFAULT_SLOT_START = '08:00';
process.env.DEFAULT_SLOT_END = '22:00';
process.env.DEFAULT_SLOT_MINUTES = '60';

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const config = require('../src/config');
const User = require('../src/models/User');
const Account = require('../src/models/Account');
const Slot = require('../src/models/Slot');
const Booking = require('../src/models/Booking');
const ScheduleOverride = require('../src/models/ScheduleOverride');
const { auth } = require('../src/middleware/auth');
const agent = require('../src/handlers/agent');
const admin = require('../src/handlers/admin');
const { prepareDefaultSchedule, ensureDefaultSlots } = require('../src/services/defaultSlots');
const { scheduleText } = require('../src/services/schedule');
const { todayStr, addDays, parseDateTime, fmtTime, fmtDate } = require('../src/utils/time');

const dbName = `call_center_bot_slots_test_${process.pid}_${randomBytes(5).toString('hex')}`;
let bot;
let events;
let account;
let user;
let updateId = 0;
const tomorrow = () => addDays(todayStr(), 1);

before(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.init(), Account.init(), Slot.init(), Booking.init(), ScheduleOverride.init()]);
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Account.deleteMany({}), Slot.deleteMany({}), Booking.deleteMany({}), ScheduleOverride.deleteMany({})]);
  config.defaultCapacity = 1;
  config.minNoticeMin = 0;
  config.maxHoursPerDay = 8;
  config.cancelDeadlineMin = 60;
  config.adminIds = [9001];
  await prepareDefaultSchedule();
  account = await Account.findOne({ name: 'CC-01' });
  user = await User.create({ telegramId: 1001, name: 'Agent One' });
  events = [];
  bot = new Telegraf('123456:test');
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'slots_test_bot' };
  for (const method of ['reply', 'answerCbQuery', 'editMessageText']) {
    bot.context[method] = async function (...args) {
      events.push({ method, chatId: this.chat?.id, args });
      return { message_id: updateId };
    };
  }
  bot.use(auth);
  agent.register(bot);
  admin.register(bot);
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName && /^call_center_bot_slots_test_\d+_[a-f0-9]+$/.test(dbName)) {
      await mongoose.connection.dropDatabase();
    }
  } finally { await mongoose.disconnect(); }
});

const from = (id) => ({ id, is_bot: false, first_name: `User ${id}` });
async function message(id, text) {
  const command = text.match(/^\/\w+(?:@\w+)?/);
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: from(id), text,
      entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : [],
    },
  });
}
async function callback(id, data) {
  return bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId), from: from(id), chat_instance: 'test', data,
      message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: bot.botInfo, text: 'Select a time' },
    },
  });
}
const last = (method) => events.filter((event) => event.method === method).at(-1);
const buttons = (event) => event.args[1].reply_markup.inline_keyboard.flat();
const tomorrowSlot = (time = '08:00') => Slot.findOne({ account: account._id, start: parseDateTime(tomorrow(), time) });

test('a fresh installation gets CC-01 and fourteen hourly slots for today and tomorrow', async () => {
  assert.equal(await Account.countDocuments(), 1);
  assert.equal(await Slot.countDocuments(), 28);
  const slots = await Slot.find({ account: account._id, start: { $gte: parseDateTime(tomorrow()) } }).sort({ start: 1 });
  assert.equal(slots.length, 14);
  assert.equal(fmtTime(slots[0].start), '2:00 morning');
  assert.equal(fmtTime(slots.at(-1).end), '4:00 night');
  for (const slot of slots) {
    assert.equal(slot.end - slot.start, 3600000);
    assert.equal(fmtDate(slot.start), tomorrow());
    assert.equal(slot.capacity, 1);
    assert.equal(slot.bookedCount, 0);
    assert.equal(slot.generatedByDefault, true);
  }
});

test('parallel date views do not duplicate slots or reset an existing reservation', async () => {
  const date = addDays(todayStr(), 3);
  await Promise.all(Array.from({ length: 4 }, () => ensureDefaultSlots(date)));
  const slots = await Slot.find({ start: { $gte: parseDateTime(date) } });
  assert.equal(slots.length, 14);
  await Slot.updateOne({ _id: slots[0]._id }, { $set: { bookedCount: 1, capacity: 2 } });
  await ensureDefaultSlots(date);
  const preserved = await Slot.findById(slots[0]._id);
  assert.equal(preserved.bookedCount, 1);
  assert.equal(preserved.capacity, 2);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(date) } }), 14);
});

test('only active accounts get defaults, and disabled accounts do not cause replacement calendars', async () => {
  await Account.updateOne({ _id: account._id }, { active: false });
  await prepareDefaultSchedule();
  assert.equal(await Account.countDocuments(), 1);
  const date = addDays(todayStr(), 3);
  await ensureDefaultSlots(date);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(date) } }), 0);
  await Account.create({ name: 'CC-02', active: true });
  await ensureDefaultSlots(date);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(date) } }), 14);
  assert.equal(await Slot.countDocuments({ account: account._id, start: { $gte: parseDateTime(date) } }), 0);
});

test('start offers time selection; selecting previews without booking and Reserve confirms', async () => {
  await Account.updateOne({ _id: account._id }, { username: 'real-login' });
  await message(1001, '/start');
  assert.ok(buttons(last('reply')).some((button) => button.text === '📅 Reserve a time'));
  await message(1001, `/slots ${tomorrow()}`);
  assert.equal(buttons(last('reply')).filter((button) => button.callback_data.startsWith('slot:toggle:')).length, 14);
  const slot = await tomorrowSlot();
  await callback(1001, `slot:select:${slot._id}`);
  const preview = last('editMessageText');
  assert.match(preview.args[0], /Confirm your reservation/);
  assert.match(preview.args[0], /2:00 morning–3:00 morning/);
  assert.doesNotMatch(preview.args[0], /real-login/);
  assert.ok(buttons(preview).some((button) => button.text === 'Reserve' && button.callback_data === `slot:book:${slot._id}`));
  assert.equal(await Booking.countDocuments(), 0);
  await callback(1001, `slot:book:${slot._id}`);
  const booking = await Booking.findOne({ user: user._id });
  assert.equal(String(booking.slot), String(slot._id));
  assert.equal(String(booking.account), String(account._id));
  assert.equal(booking.start.getTime(), slot.start.getTime());
  assert.equal(booking.end.getTime(), slot.end.getTime());
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
  assert.match(last('reply').args[0], /Reserved/);
  assert.match(last('reply').args[0], /real-login/);
  await callback(1001, 'bookings:mine');
  assert.match(last('editMessageText').args[0], /My reservations/);
  assert.match(last('editMessageText').args[0], /2:00 morning–3:00 morning/);
});

test('two users choosing the same final seat can create only one reservation', async () => {
  await User.create({ telegramId: 1002, name: 'Agent Two' });
  const slot = await tomorrowSlot();
  await callback(1001, `slot:select:${slot._id}`);
  await callback(1002, `slot:select:${slot._id}`);
  await Promise.all([callback(1001, `slot:book:${slot._id}`), callback(1002, `slot:book:${slot._id}`)]);
  assert.equal(await Booking.countDocuments({ slot: slot._id }), 1);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
  assert.ok(events.some((event) => event.method === 'answerCbQuery' && /full|last place/.test(event.args[0] || '')));
  await ensureDefaultSlots(tomorrow());
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('stale buttons for disabled accounts cannot select or reserve and disabled slots are hidden', async () => {
  const slot = await tomorrowSlot();
  await Account.updateOne({ _id: account._id }, { active: false });
  await callback(1001, `slot:select:${slot._id}`);
  assert.match(last('answerCbQuery').args[0], /no longer available/);
  await callback(1001, `slot:book:${slot._id}`);
  assert.match(last('answerCbQuery').args[0], /no longer available/);
  assert.equal(await Booking.countDocuments(), 0);
  await message(1001, `/slots ${tomorrow()}`);
  assert.match(last('reply').args[0], /No active call-center accounts/);
  assert.equal(buttons(last('reply')).filter((button) => button.callback_data.startsWith('slot:toggle:')).length, 0);
});

test('past dates do not generate slots and navigation generates future dates', async () => {
  const date = addDays(todayStr(), 4);
  await callback(1001, `slots:date:${date}`);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(date) } }), 14);
  assert.match(last('editMessageText').args[0], new RegExp(date));
  const yesterday = addDays(todayStr(), -1);
  await ensureDefaultSlots(yesterday);
  assert.equal(await Slot.countDocuments({ start: { $lt: parseDateTime(todayStr()) } }), 0);
  await callback(1001, 'slots:date:2026-99-99');
  assert.match(last('answerCbQuery').args[0], /Invalid date/);
});

test('existing manual schedules are preserved without adding default windows', async () => {
  const date = addDays(todayStr(), 4);
  await Slot.create({ account: account._id, start: parseDateTime(date, '10:00'), end: parseDateTime(date, '12:00'), capacity: 2 });
  await ensureDefaultSlots(date);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(date) } }), 1);
  assert.match(await scheduleText(date), /4:00 morning–6:00 afternoon/);
});

test('admin deletions preserve booked slots and defaults do not restore removed slots', async () => {
  const slot = await tomorrowSlot();
  await callback(1001, `slot:book:${slot._id}`);
  await message(9001, `/delslots ${tomorrow()} all`);
  await ensureDefaultSlots(tomorrow());
  assert.equal(await ScheduleOverride.countDocuments({ account: account._id, date: tomorrow() }), 1);
  assert.equal(await Slot.countDocuments({ start: { $gte: parseDateTime(tomorrow()) } }), 1);
  assert.equal(await Booking.countDocuments(), 1);
  assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
});

test('an explicit admin schedule overrides the automatic daily schedule', async () => {
  const date = addDays(todayStr(), 4);
  await message(9001, `/addslots ${date} 10:00 12:00 all 60 2`);
  await ensureDefaultSlots(date);
  const slots = await Slot.find({ start: { $gte: parseDateTime(date) } }).sort({ start: 1 });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].capacity, 2);
  assert.equal(fmtTime(slots[0].start), '4:00 morning');
  assert.equal(fmtTime(slots.at(-1).end), '6:00 afternoon');
});

test('daily limits, duplicate prevention and cancellation still apply to default slots', async () => {
  config.maxHoursPerDay = 1;
  const first = await tomorrowSlot('08:00');
  const second = await tomorrowSlot('09:00');
  await Slot.updateOne({ _id: first._id }, { capacity: 2 });
  await callback(1001, `slot:book:${first._id}`);
  await callback(1001, `slot:book:${first._id}`);
  assert.match(last('answerCbQuery').args[0], /already reserved/);
  await callback(1001, `slot:book:${second._id}`);
  assert.match(last('answerCbQuery').args[0], /Daily limit/);
  assert.equal(await Booking.countDocuments(), 1);
  const booking = await Booking.findOne({ user: user._id });
  await callback(1001, `slot:cancel:${booking._id}`);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal((await Slot.findById(first._id)).bookedCount, 0);
  await callback(1001, `slot:book:${second._id}`);
  assert.equal(await Booking.countDocuments(), 1);
});

test('after the last starting time the default slots view opens tomorrow', async () => {
  const realNow = Date.now;
  Date.now = () => parseDateTime(todayStr(), '22:00').getTime();
  try {
    await message(1001, '/slots');
    assert.match(last('reply').args[0], new RegExp(tomorrow()));
    assert.equal(buttons(last('reply')).filter((button) => button.callback_data.startsWith('slot:toggle:')).length, 14);
  } finally { Date.now = realNow; }
});

test('several clock buttons can be selected, deselected, and reserved together', async () => {
  const slots = await Promise.all(['08:00', '09:00', '11:00'].map(tomorrowSlot));
  for (const slot of slots) await callback(1001, `slot:toggle:${slot._id}`);
  assert.equal(await Booking.countDocuments(), 0);
  assert.match(last('editMessageText').args[0], /Selected: <b>3<\/b>/);
  assert.match(last('editMessageText').args[0], /3h 00m/);
  assert.equal(buttons(last('editMessageText')).filter((button) => button.text.startsWith('☑️')).length, 3);
  assert.ok(buttons(last('editMessageText')).some((button) => button.text === '✅ Reserve selected (3)'));
  await callback(1001, `slot:toggle:${slots[1]._id}`);
  assert.match(last('editMessageText').args[0], /Selected: <b>2<\/b>/);
  await callback(1001, `slot:toggle:${slots[1]._id}`);
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.equal(await Booking.countDocuments({ user: user._id }), 3);
  assert.match(last('reply').args[0], /Reserved 3 times/);
  for (const slot of slots) {
    assert.equal((await Slot.findById(slot._id)).bookedCount, 1);
    assert.ok(await Booking.exists({ slot: slot._id, user: user._id }));
  }
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.match(last('answerCbQuery').args[0], /Select at least one time/);
  assert.equal(await Booking.countDocuments(), 3);
});

test('batch selections respect total daily hours and can be cleared without booking', async () => {
  config.maxHoursPerDay = 2;
  for (const time of ['08:00', '09:00', '10:00']) {
    const slot = await tomorrowSlot(time);
    await callback(1001, `slot:toggle:${slot._id}`);
  }
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.match(last('answerCbQuery').args[0], /Daily limit/);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal(await Slot.countDocuments({ bookedCount: { $gt: 0 } }), 0);
  await callback(1001, `slots:clear:${tomorrow()}`);
  assert.match(last('editMessageText').args[0], /Selected: <b>0<\/b>/);
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.match(last('answerCbQuery').args[0], /Select at least one time/);
});

test('overlapping times on different accounts are rejected before any places are claimed', async () => {
  const secondAccount = await Account.create({ name: 'CC-02' });
  await ensureDefaultSlots(tomorrow());
  const first = await tomorrowSlot();
  const second = await Slot.findOne({ account: secondAccount._id, start: first.start });
  await callback(1001, `slot:toggle:${first._id}`);
  await callback(1001, `slot:toggle:${second._id}`);
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.match(last('answerCbQuery').args[0], /selected times overlap/);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal(await Slot.countDocuments({ bookedCount: { $gt: 0 } }), 0);
});

test('losing a place during a batch releases earlier claimed places', async () => {
  const first = await tomorrowSlot('08:00');
  const second = await tomorrowSlot('09:00');
  await callback(1001, `slot:toggle:${first._id}`);
  await callback(1001, `slot:toggle:${second._id}`);
  const original = Slot.findOneAndUpdate;
  let calls = 0;
  Slot.findOneAndUpdate = function (...args) {
    if (++calls === 2) return Promise.resolve(null);
    return original.apply(this, args);
  };
  try { await callback(1001, `slots:reserve:${tomorrow()}`); }
  finally { Slot.findOneAndUpdate = original; }
  assert.match(last('answerCbQuery').args[0], /No selected times were reserved/);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal((await Slot.findById(first._id)).bookedCount, 0);
  assert.equal((await Slot.findById(second._id)).bookedCount, 0);
});

test('a failed batch write removes its partial bookings and preserves other reservations', async () => {
  const existingSlot = await tomorrowSlot('14:00');
  await callback(1001, `slot:book:${existingSlot._id}`);
  for (const time of ['08:00', '09:00']) {
    const slot = await tomorrowSlot(time);
    await callback(1001, `slot:toggle:${slot._id}`);
  }
  const original = Booking.insertMany;
  Booking.insertMany = async function (documents) {
    await Booking.create(documents[0]);
    throw new Error('Simulated interrupted write');
  };
  try { await callback(1001, `slots:reserve:${tomorrow()}`); }
  finally { Booking.insertMany = original; }
  assert.match(last('answerCbQuery').args[0], /Could not reserve/);
  assert.equal(await Booking.countDocuments(), 1);
  assert.ok(await Booking.exists({ slot: existingSlot._id, user: user._id }));
  assert.equal((await tomorrowSlot('08:00')).bookedCount, 0);
  assert.equal((await tomorrowSlot('09:00')).bookedCount, 0);
  assert.equal((await Slot.findById(existingSlot._id)).bookedCount, 1);
});

test('simultaneous bookings by one user cannot bypass their daily hours limit', async () => {
  config.maxHoursPerDay = 1;
  const first = await tomorrowSlot('08:00');
  const second = await tomorrowSlot('09:00');
  await Promise.all([callback(1001, `slot:book:${first._id}`), callback(1001, `slot:book:${second._id}`)]);
  assert.equal(await Booking.countDocuments({ user: user._id }), 1);
  assert.equal(await Slot.countDocuments({ bookedCount: 1 }), 1);
  assert.ok(events.some((event) => event.method === 'answerCbQuery' && /Daily limit/.test(event.args[0] || '')));
});

test('selections are private to each user and date', async () => {
  await User.create({ telegramId: 1002, name: 'Agent Two' });
  const first = await tomorrowSlot();
  await callback(1001, `slot:toggle:${first._id}`);
  await callback(1002, `slots:reserve:${tomorrow()}`);
  assert.match(last('answerCbQuery').args[0], /Select at least one time/);
  const otherDate = addDays(todayStr(), 2);
  await callback(1001, `slots:date:${otherDate}`);
  await callback(1001, `slots:reserve:${otherDate}`);
  assert.match(last('answerCbQuery').args[0], /Select at least one time/);
  await callback(1001, `slots:date:${tomorrow()}`);
  assert.match(last('editMessageText').args[0], /Selected: <b>1<\/b>/);
  await callback(1001, `slots:reserve:${tomorrow()}`);
  assert.equal(await Booking.countDocuments({ user: user._id }), 1);
});

test('Ethiopian clock buttons keep the same actual booking times', async () => {
  await message(1001, `/slots ${tomorrow()}`);
  const listing = last('reply');
  assert.match(listing.args[0], /Ethiopian time/);
  assert.doesNotMatch(listing.args[0], /24-hour clock/);
  const first = await tomorrowSlot('08:00');
  assert.ok(buttons(listing).some((button) => button.callback_data === `slot:toggle:${first._id}` && button.text.includes('2:00 morning–3:00 morning')));
  const final = await tomorrowSlot('21:00');
  assert.ok(buttons(listing).some((button) => button.callback_data === `slot:toggle:${final._id}` && button.text.includes('3:00 night–4:00 night')));
  await callback(1001, `slot:toggle:${first._id}`);
  await callback(1001, `slot:toggle:${final._id}`);
  await callback(1001, `slots:reserve:${tomorrow()}`);
  const bookings = await Booking.find({ user: user._id }).sort({ start: 1 });
  assert.equal(bookings.length, 2);
  assert.equal(bookings[0].start.getTime(), parseDateTime(tomorrow(), '08:00').getTime());
  assert.equal(bookings[1].end.getTime(), parseDateTime(tomorrow(), '22:00').getTime());
  assert.match(last('reply').args[0], /2:00 morning–3:00 morning/);
  assert.match(last('reply').args[0], /3:00 night–4:00 night/);
});

test('admins can publish Ethiopian day/night times with the intended actual schedule', async () => {
  const date = addDays(todayStr(), 4);
  await message(9001, `/addslots ${date} 2:00day 4:00night all 60`);
  const slots = await Slot.find({ start: { $gte: parseDateTime(date) } }).sort({ start: 1 });
  assert.equal(slots.length, 14);
  assert.equal(slots[0].start.getTime(), parseDateTime(date, '08:00').getTime());
  assert.equal(slots.at(-1).end.getTime(), parseDateTime(date, '22:00').getTime());
  assert.match(last('reply').args[0], /2:00 morning–4:00 night \(Ethiopian time\)/);
});

test('Ethiopian night times can cross midnight in custom schedules', async () => {
  const date = addDays(todayStr(), 4);
  await message(9001, `/addslots ${date} 2:00night 7:00night all 60`);
  const slots = await Slot.find({ start: { $gte: parseDateTime(date) } }).sort({ start: 1 });
  assert.equal(slots.length, 5);
  assert.equal(slots[0].start.getTime(), parseDateTime(date, '20:00').getTime());
  assert.equal(slots.at(-1).end.getTime(), parseDateTime(addDays(date, 1), '01:00').getTime());
});
