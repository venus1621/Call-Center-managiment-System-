const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true }, // e.g. CC-03
    username: { type: String },                            // login name on the call center system
    passwordEnc: { type: String },                         // AES-256-GCM encrypted
    // Agent codes (e.g. agent/1567) on this account; each seat of a shared slot gets a different one.
    agentCodes: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Account', accountSchema);
