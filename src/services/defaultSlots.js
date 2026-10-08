const config = require('../config');
const Account = require('../models/Account');
const Slot = require('../models/Slot');
const ScheduleOverride = require('../models/ScheduleOverride');
const { DAY, parseDateTime, todayStr, addDays } = require('../utils/time');

async function seedDefaultAccount() {
  // A first installation has a booking calendar; disabled accounts stay disabled.
  if (await Account.exists({})) return;
  await Account.updateOne({ name: 'CC-01' }, { $setOnInsert: { name: 'CC-01', active: true } }, { upsert: true });
}

async function disableDefaultSlots(date, accounts) {
  if (!accounts.length) return;
  await ScheduleOverride.bulkWrite(accounts.map((account) => ({ updateOne: {
    filter: { account: account._id, date },
    update: { $setOnInsert: { account: account._id, date } }, upsert: true,
  } })));
}

/** Fill an untouched day once per active account; existing reservations are never reset. */
async function ensureDefaultSlots(date) {
  const from = parseDateTime(date);
  if (!from) throw new Error('Invalid schedule date');
  const accounts = await Account.find({ active: true }).sort({ name: 1 });
  if (!accounts.length || date < todayStr()) return accounts;
  const accountIds = accounts.map((account) => account._id);
  const [overrides, manualSlots] = await Promise.all([
    ScheduleOverride.find({ date, account: { $in: accountIds } }).select('account'),
    Slot.find({ account: { $in: accountIds }, start: { $gte: from, $lt: new Date(from.getTime() + DAY) }, generatedByDefault: { $ne: true } }).select('account'),
  ]);
  const skipped = new Set([...overrides, ...manualSlots].map((item) => String(item.account)));
  const start = parseDateTime(date, config.defaultSlotStart).getTime();
  const end = parseDateTime(date, config.defaultSlotEnd).getTime();
  const length = config.defaultSlotMinutes * 60000;
  const operations = [];
  for (const account of accounts) {
    if (skipped.has(String(account._id))) continue;
    for (let time = start; time + length <= end; time += length) {
      operations.push({ updateOne: {
        filter: { account: account._id, start: new Date(time) },
        update: { $setOnInsert: {
          account: account._id, start: new Date(time), end: new Date(time + length),
          capacity: config.defaultCapacity, bookedCount: 0, generatedByDefault: true,
        } }, upsert: true,
      } });
    }
  }
  if (operations.length) {
    try { await Slot.bulkWrite(operations, { ordered: false }); }
    catch (err) {
      // Parallel date views may race to insert the same slot. Its unique index wins.
      if (!err.writeErrors?.length || err.writeErrors.some((error) => error.code !== 11000) || err.writeConcernErrors?.length) throw err;
    }
  }
  return accounts;
}

async function prepareDefaultSchedule() {
  await seedDefaultAccount();
  const today = todayStr();
  await ensureDefaultSlots(today);
  await ensureDefaultSlots(addDays(today, 1));
}

module.exports = { seedDefaultAccount, disableDefaultSlots, ensureDefaultSlots, prepareDefaultSchedule };
