const mongoose = require('mongoose');

const websiteThemeVersionSchema = new mongoose.Schema({
  theme: { type: mongoose.Schema.Types.ObjectId, ref: 'WebsiteTheme', required: true, index: true },
  version: { type: Number, required: true },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  note: { type: String, trim: true, maxlength: 240 },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

websiteThemeVersionSchema.index({ theme: 1, version: -1 }, { unique: true });

module.exports = mongoose.model('WebsiteThemeVersion', websiteThemeVersionSchema);
