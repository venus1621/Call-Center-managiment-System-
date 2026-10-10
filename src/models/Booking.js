const mongoose = require('mongoose');

// One user's reservation of one slot.
const bookingSchema = new mongoose.Schema(
  {
    slot: { type: mongoose.Schema.Types.ObjectId, ref: 'Slot', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    agentCode: { type: String }, // which of the account's agent codes this reservation must use
    preAlarmSent: { type: Boolean, default: false },
    startReminderSent: { type: Boolean, default: false },
    finalized: { type: Boolean, default: false }, // evaluated after the slot ended
    noShow: { type: Boolean, default: false },
  },
  { timestamps: true }
);

bookingSchema.index({ slot: 1, user: 1 }, { unique: true });
// Two reservations of one slot can never hold the same agent code.
bookingSchema.index({ slot: 1, agentCode: 1 }, { unique: true, partialFilterExpression: { agentCode: { $type: 'string' } } });
bookingSchema.index({ user: 1, start: 1 });
bookingSchema.index({ account: 1, start: 1 });
bookingSchema.index({ start: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
