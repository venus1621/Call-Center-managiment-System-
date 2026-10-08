const mongoose = require('mongoose');

// Remember explicit admin schedules/deletions so automatic slots do not restore them.
const scheduleOverrideSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    date: { type: String, required: true },
  },
  { timestamps: true }
);
scheduleOverrideSchema.index({ account: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ScheduleOverride', scheduleOverrideSchema);
