const { Schema } = require('mongoose');
const variant = new Schema({ url: String, publicId: String, provider: String, mimeType: String, sizeBytes: Number,
  width: { type: Number, min: 1 }, height: { type: Number, min: 1 } }, { _id: false });
module.exports = { width: Number, height: Number, mimeType: String, sizeBytes: Number, provider: String,
  variants: { type: [variant], default: undefined } };
