const mongoose = require('mongoose');

const INSTAGRAM_STATUSES = ['DISCONNECTED', 'PENDING', 'CONNECTED', 'ERROR'];

const instagramConnectionSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, unique: true },
  status: { type: String, enum: INSTAGRAM_STATUSES, default: 'DISCONNECTED' },
  username: String,
  accountId: String,
  encryptedAccessToken: { type: String, select: false },
  encryptedRefreshToken: { type: String, select: false },
  tokenExpiresAt: Date,
  lastSyncAt: Date,
  lastError: String,
  connectedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('InstagramConnection', instagramConnectionSchema);
module.exports.INSTAGRAM_STATUSES = INSTAGRAM_STATUSES;
