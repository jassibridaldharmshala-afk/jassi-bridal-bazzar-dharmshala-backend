const mongoose = require('mongoose');
const storeIdPlugin = require('./plugins/storeId');

const verificationEvidenceSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnExchange' },
  orderItemId: { type: String, default: '', maxlength: 64 },
  phase: { type: String, enum: ['PACKING', 'RETURN_REQUEST', 'RETURN_INSPECTION'], required: true },
  type: { type: String, enum: ['PRODUCT_PHOTO', 'CONDITION_PHOTO', 'PACKAGE_PHOTO', 'SHIPPING_LABEL_PHOTO', 'PACKING_VIDEO', 'CUSTOMER_PHOTO', 'CUSTOMER_VIDEO', 'RETURN_PHOTO', 'UNBOXING_VIDEO'], required: true },
  fileUrl: { type: String, required: true, maxlength: 2200 },
  mimeType: { type: String, maxlength: 100 },
  sizeBytes: { type: Number, min: 0 },
  provider: { type: String, maxlength: 30 },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { timestamps: true });

verificationEvidenceSchema.plugin(storeIdPlugin);
verificationEvidenceSchema.index({ storeId: 1, order: 1, phase: 1, createdAt: -1 });
verificationEvidenceSchema.index({ storeId: 1, returnRequest: 1, phase: 1, createdAt: -1 });

module.exports = mongoose.model('VerificationEvidence', verificationEvidenceSchema);

