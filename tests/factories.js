const User = require('../models/User');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Coupon = require('../models/Coupon');
const Settings = require('../models/Settings');
const { generateToken } = require('../utils/generateToken');

let sequence = 0;
const nextId = () => { sequence += 1; return sequence; };

async function createCustomer(overrides = {}) {
  const id = nextId();
  const user = await User.create({
    name: `Test Customer ${id}`,
    phone: `90000000${String(id).padStart(2, '0')}`,
    email: `customer${id}@test.local`,
    isPhoneVerified: true,
    role: 'customer',
    activeMode: 'customer',
    availableModes: ['customer'],
    ...overrides,
  });
  return { user, token: generateToken(user) };
}

async function createAdmin(overrides = {}) {
  const id = nextId();
  const user = await User.create({
    name: `Test Admin ${id}`,
    phone: `95000000${String(id).padStart(2, '0')}`,
    email: `admin${id}@test.local`,
    isPhoneVerified: true,
    role: 'admin',
    activeMode: 'admin',
    availableModes: ['customer', 'admin'],
    ...overrides,
  });
  return { user, token: generateToken(user) };
}

async function createProduct(overrides = {}) {
  const id = nextId();
  const category = await Category.create({ name: `Category ${id}`, slug: `category-${id}` });
  return Product.create({
    name: `Test Product ${id}`,
    slug: `test-product-${id}`,
    category: category._id,
    price: 1000,
    originalPrice: 1500,
    stock: 10,
    isActive: true,
    sizes: ['S', 'M', 'L'],
    colors: ['Red'],
    ...overrides,
  });
}

async function createCoupon(overrides = {}) {
  const id = nextId();
  return Coupon.create({
    code: `TEST${id}`,
    type: 'Flat',
    discountValue: 100,
    minOrderAmount: 0,
    expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    isActive: true,
    ...overrides,
  });
}

async function setSettings(overrides = {}) {
  return Settings.findOneAndUpdate({}, {
    storeName: 'Jassi General Store',
    codEnabled: true,
    smartCodVerificationEnabled: false,
    codCharge: 0,
    razorpayEnabled: false,
    deliveryCharge: 99,
    freeShippingMinAmount: 999,
    platformFee: 0,
    gstRate: 0,
    ...overrides,
  }, { new: true, upsert: true });
}

function validAddress(overrides = {}) {
  return {
    fullName: 'Test Customer',
    mobile: '9000000001',
    pincode: '302001',
    state: 'Rajasthan',
    city: 'Jaipur',
    houseNo: '12',
    area: 'Test Area',
    addressType: 'Home',
    ...overrides,
  };
}

module.exports = {
  createAdmin,
  createCoupon,
  createCustomer,
  createProduct,
  setSettings,
  validAddress,
};
