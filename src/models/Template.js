const mongoose = require('mongoose');

// Reusable message text saved by a supervisor (built-in templates live in code).
const templateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 40 },
    text: { type: String, required: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', templateSchema);
