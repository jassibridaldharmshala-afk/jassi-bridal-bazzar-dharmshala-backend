const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const addressSchema = new mongoose.Schema({
  fullName: String,
  mobile: String,
  alternateMobile: String,
  phone: String,
  pincode: String,
  state: String,
  city: String,
  houseNo: String,
  houseNumber: String,
  area: String,
  landmark: String,
  addressType: { type: String, enum: ['Home', 'Work', 'Other'], default: 'Home' },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, required: true, unique: true },
  isEmailVerified: { type: Boolean, default: false },
  gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
  birthDate: Date,
  alternatePhone: String,
  hintName: String,
  password: String,
  isPhoneVerified: { type: Boolean, default: false },
  role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  systemRole: { type: String, enum: ['USER', 'MASTER_OWNER'], default: 'USER' },
  masterSessionVersion: { type: String, select: false },
  authSessionVersion: { type: Number, default: 0, min: 0, select: false },
  availableModes: [{ type: String, enum: ['customer', 'admin', 'seller'] }],
  activeMode: { type: String, enum: ['customer', 'admin', 'seller'], default: 'customer' },
  addresses: [addressSchema],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  isBlocked: { type: Boolean, default: false },
}, { timestamps: true });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.password || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.matchPassword = async function matchPassword(password) {
  if (!password || !this.password) return false;
  if (/^\$2[aby]\$/.test(this.password)) return bcrypt.compare(password, this.password);
  return password === this.password;
};

userSchema.methods.hasLegacyPlainPassword = function hasLegacyPlainPassword() {
  return this.password && !/^\$2[aby]\$/.test(this.password);
};

module.exports = mongoose.model('User', userSchema);
