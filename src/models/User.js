const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    username: { type: String },
    role: { type: String, enum: ['admin', 'agent'], default: 'agent' },
    active: { type: Boolean, default: true },
    // Existing and manually added users retain access; applicants start inactive.
    registrationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
    requestedAt: { type: Date },
    // An agent can ask to become an admin; an existing admin approves or rejects.
    adminRequest: { type: String, enum: ['none', 'pending'], default: 'none' },
    adminRequestedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
