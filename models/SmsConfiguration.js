const mongoose = require('mongoose');

const connection = new mongoose.Schema({
  source: { type: String, enum: ['settings', 'environment'] },
  provider: { type: String, enum: ['twilio', 'twofactor', 'msg91', 'fast2sms'] },
  credentialsEncrypted: { type: String, select: false },
  savedFields: [String],
  verifiedAt: Date,
}, { _id: false });
const schema = new mongoose.Schema({
  // Authentication is deployment-wide, not a public store setting. Never use
  // an arbitrary request storeId to choose credentials for owner authentication.
  _id: { type: String, default: 'deployment' },
  revision: { type: Number, default: 0 },
  active: connection,
  pending: connection,
  challenge: { type: new mongoose.Schema({
    id: String, actor: String, phone: String, codeHash: String,
    revision: Number, expiresAt: Date, attempts: Number,
    state: { type: String, enum: ['SENDING', 'READY', 'FAILED'] },
  }, { _id: false }), select: false },
  lastTestAt: Date,
}, { timestamps: true });
module.exports = mongoose.model('SmsConfiguration', schema);
