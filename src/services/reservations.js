const config = require('../config');
const Slot = require('../models/Slot');
const Booking = require('../models/Booking');
const { DAY, fmtDate, fmtHm, parseDateTime } = require('../utils/time');

class ReservationError extends Error {}
const userQueues = new Map();

/**
 * Store one reservation. When the account has agent codes, the booking gets the first code
 * that no other reservation of this slot uses, so two agents sharing a slot never get the same code.
 */
async function insertBooking(user, slot) {
  const base = { slot: slot._id, user: user._id, account: slot.account._id, start: slot.start, end: slot.end };
  const codes = slot.account.agentCodes || [];
  if (!codes.length) return Booking.create(base);
  for (;;) {
    const used = await Booking.find({ slot: slot._id, agentCode: { $type: 'string' } }).distinct('agentCode');
    const free = codes.find((code) => !used.includes(code));
    if (!free) throw new ReservationError('No agent code is free for this time. Please choose another time.');
    try { return await Booking.create({ ...base, agentCode: free }); }
    catch (err) {
      if (err.code === 11000 && err.keyPattern?.agentCode) continue; // lost a race for this code: pick the next
      throw err;
    }
  }
}

async function createReservations(user, slotIds, options = {}) {
  const ids = [...new Set(slotIds.map(String))];
  if (!ids.length) throw new ReservationError('Select at least one time before reserving.');
  const slots = await Slot.find({ _id: { $in: ids } }).sort({ start: 1 }).populate('account');
  if (slots.length !== ids.length || slots.some((slot) => !slot.account?.active || slot.bookedCount >= slot.capacity)) {
    throw new ReservationError('One of these slots is full or no longer available. Please review your selected times.');
  }
  if (!options.skipNotice && slots.some((slot) => slot.start.getTime() <= Date.now() + config.minNoticeMin * 60000)) {
    throw new ReservationError(config.minNoticeMin ? `Reservations close ${config.minNoticeMin} min before the start.` : 'One of these times has already started. Please choose a later time.');
  }
  if (await Booking.exists({ user: user._id, slot: { $in: ids } })) throw new ReservationError('You already reserved one of these times.');
  if (slots.some((slot, index) => index > 0 && slot.start < slots[index - 1].end)) {
    throw new ReservationError('Your selected times overlap. Choose one account for each time.');
  }
  if (await Booking.exists({ user: user._id, $or: slots.map((slot) => ({ start: { $lt: slot.end }, end: { $gt: slot.start } })) })) {
    throw new ReservationError('You already have a reservation that overlaps one of these times.');
  }

  const firstDay = parseDateTime(fmtDate(slots[0].start));
  const lastDay = parseDateTime(fmtDate(slots.at(-1).start));
  const existing = await Booking.find({ user: user._id, start: { $gte: firstDay, $lt: new Date(lastDay.getTime() + DAY) } }).select('start end');
  const minutesByDay = new Map();
  for (const item of [...existing, ...slots]) {
    const day = fmtDate(item.start);
    minutesByDay.set(day, (minutesByDay.get(day) || 0) + (item.end - item.start) / 60000);
  }
  for (const [day, minutes] of minutesByDay) {
    if (minutes > config.maxHoursPerDay * 60) throw new ReservationError(`Daily limit is ${config.maxHoursPerDay} h. These reservations would total ${fmtHm(minutes)} on ${day}.`);
  }

  const claimed = [];
  const created = [];
  const agentCodes = {};
  try {
    for (const slot of slots) {
      const taken = await Slot.findOneAndUpdate(
        { _id: slot._id, $expr: { $lt: ['$bookedCount', '$capacity'] } },
        { $inc: { bookedCount: 1 } }, { new: true }
      );
      if (!taken) throw new ReservationError('Someone just took the last place in a selected slot. No selected times were reserved; please try again.');
      claimed.push(slot._id);
    }
    for (const slot of slots) {
      const booking = await insertBooking(user, slot);
      created.push(booking._id);
      if (booking.agentCode) agentCodes[String(slot._id)] = booking.agentCode;
    }
  } catch (err) {
    // Local MongoDB may not support transactions. Undo only this attempt's writes.
    if (created.length) await Booking.deleteMany({ _id: { $in: created }, user: user._id });
    if (claimed.length) await Slot.updateMany({ _id: { $in: claimed } }, { $inc: { bookedCount: -1 } });
    throw err;
  }
  slots.agentCodes = agentCodes;
  return slots;
}

/** Serialize one user's booking attempts so double clicks cannot bypass hour/overlap limits. */
async function reserveSlots(user, slotIds, options = {}) {
  const key = String(user._id);
  const previous = userQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => createReservations(user, slotIds, options));
  userQueues.set(key, operation);
  try { return await operation; }
  finally { if (userQueues.get(key) === operation) userQueues.delete(key); }
}

module.exports = { reserveSlots, ReservationError };
