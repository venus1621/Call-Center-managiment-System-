const mongoose = require('mongoose');

// A time window on one call center account. Up to `capacity` (1 or 2) users can reserve it.
const slotSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    capacity: { type: Number, default: 1, min: 1, max: 2 },
    bookedCount: { type: Number, default: 0, min: 0 },
    generatedByDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

slotSchema.index({ account: 1, start: 1 }, { unique: true });
slotSchema.index({ start: 1 });

module.exports = mongoose.model('Slot', slotSchema);
