const mongoose = require('mongoose');

const asset = new mongoose.Schema({
  url: { type: String, required: true, maxlength: 4096, validate: value => /^https?:\/\/|^\/uploads\//i.test(value) },
  publicId: { type: String, maxlength: 1024 },
}, { _id: false });

module.exports = new mongoose.Schema({
  original: { type: asset, required: true },
  edited: { type: asset, required: true },
  preset: { type: String, enum: ['transparent', 'white', 'grey', 'beige', 'studio', 'gradient'], required: true },
}, { _id: false });
