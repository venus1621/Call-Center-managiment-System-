const mongoose = require('mongoose');

// A supervisor -> agent(s) direct message, kept for audit and delivery/confirmation tracking.
const recipientSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    error: String,
    sentAt: Date,
    ackedAt: { type: Date, default: null }, // agent pressed "Got it" (or answered)
    answer: { type: String, enum: ['yes', 'no'], default: undefined }, // availability requests
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
    target: { type: String, enum: ['user', 'all'], default: 'user' },
    kind: { type: String, enum: ['text', 'availability'], default: 'text' },
    recipients: [recipientSchema],
    // draft = waiting for the supervisor's confirmation
    status: { type: String, enum: ['draft', 'sending', 'sent', 'cancelled'], default: 'draft' },
  },
  { timestamps: true }
);

messageSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
