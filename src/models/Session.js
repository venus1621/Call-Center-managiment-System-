const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    slot: { type: mongoose.Schema.Types.ObjectId, ref: 'Slot', required: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'completed', 'auto-closed'], default: 'active' },
    lateMinutes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

sessionSchema.index({ user: 1, status: 1 });
sessionSchema.index({ account: 1, startedAt: 1 });
sessionSchema.index({ startedAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);
