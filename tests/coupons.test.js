const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCoupon, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Coupon = require('../models/Coupon');
const CouponCustomerUsage = require('../models/CouponCustomerUsage');
const Order = require('../models/Order');
const couponService = require('../services/couponService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

test('a valid coupon previews the discount the backend computes', async () => {
  const coupon = await createCoupon({ type: 'Percentage', discountValue: 10, maxDiscountAmount: 0 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });

  assert.equal(status, 200);
  assert.equal(data.discountAmount, 200);
});

test('the maximum discount cap is respected', async () => {
  const coupon = await createCoupon({ type: 'Percentage', discountValue: 50, maxDiscountAmount: 300 });
  const { data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 5000 } });
  assert.equal(data.discountAmount, 300);
});

test('a discount can never exceed the cart total', async () => {
  const coupon = await createCoupon({ type: 'Flat', discountValue: 5000 });
  const { data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 800 } });
  assert.equal(data.discountAmount, 800);
});

test('an expired coupon is refused', async () => {
  const coupon = await createCoupon({ expiryDate: new Date(Date.now() - 1000) });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'COUPON_EXPIRED');
});

test('an inactive coupon is refused', async () => {
  const coupon = await createCoupon({ isActive: false });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a coupon that has not started yet is refused', async () => {
  const coupon = await createCoupon({ validFrom: new Date(Date.now() + 86400000) });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('the minimum order amount is enforced', async () => {
  const coupon = await createCoupon({ minOrderAmount: 1500 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 800 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('an exhausted usage limit is refused', async () => {
  const coupon = await createCoupon({ usageLimit: 2, usedCount: 2 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a payment-method restricted coupon is refused for other methods', async () => {
  const coupon = await createCoupon({ applicablePaymentMethods: ['UPI'] });

  const cod = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000, paymentMethod: 'COD' } });
  assert.equal(cod.status, 400);

  const upi = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 2000, paymentMethod: 'UPI' } });
  assert.equal(upi.status, 200);
});

test('an unknown coupon code is refused', async () => {
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: 'NOPE123', cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('a malformed coupon code fails validation', async () => {
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: '!!', cartTotal: 2000 } });
  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
});

test('the usage limit holds under concurrent consumption', async () => {
  const coupon = await createCoupon({ usageLimit: 1 });

  const results = await Promise.allSettled([
    couponService.consumeCoupon(coupon.code),
    couponService.consumeCoupon(coupon.code),
    couponService.consumeCoupon(coupon.code),
  ]);

  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'only one redemption may succeed');
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 1);
});

test('releasing a coupon never drives usage below zero', async () => {
  const coupon = await createCoupon();
  await couponService.releaseCoupon(coupon.code);
  await couponService.releaseCoupon(coupon.code);
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);
});

test('the public coupon list hides expired coupons', async () => {
  await createCoupon({ code: 'LIVEONE' });
  await createCoupon({ code: 'DEADONE', expiryDate: new Date(Date.now() - 1000) });

  const { data } = await request('/api/coupons');
  const codes = data.map((coupon) => coupon.code);
  assert.ok(codes.includes('LIVEONE'));
  assert.equal(codes.includes('DEADONE'), false);
});

test('the public coupon list hides future, exhausted and private coupons', async () => {
  await createCoupon({ code: 'PUBLIC10', usedCount: 3 });
  await createCoupon({ code: 'FUTURE10', validFrom: new Date(Date.now() + 86400000) });
  await createCoupon({ code: 'USEDUP10', usageLimit: 2, usedCount: 2 });
  await createCoupon({ code: 'PRIVATE10', isPublic: false });

  const { status, data } = await request('/api/coupons');
  assert.equal(status, 200);
  assert.deepEqual(data.map((coupon) => coupon.code), ['PUBLIC10']);
  assert.equal(Object.hasOwn(data[0], 'usedCount'), false, 'internal usage details are not exposed publicly');
  assert.equal(Object.hasOwn(data[0], 'isActive'), false, 'internal status is not exposed publicly');
});

test('available coupons are evaluated against the bag and sorted by real savings', async () => {
  const product = await createProduct({ price: 2000, stock: 5 });
  await createCoupon({ code: 'TENPERCENT', type: 'Percentage', discountValue: 10 });
  await createCoupon({ code: 'SAVE350', type: 'Flat', discountValue: 350 });
  await createCoupon({ code: 'SPEND3000', type: 'Flat', discountValue: 500, minOrderAmount: 3000 });

  const { status, data } = await request('/api/coupons/available', {
    method: 'POST',
    body: { items: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'COD' },
  });

  assert.equal(status, 200);
  assert.equal(data.cartTotal, 2000);
  assert.equal(data.bestCouponCode, 'SAVE350', JSON.stringify(data));
  assert.equal(data.items[0].code, 'SAVE350');
  assert.equal(data.items[0].estimatedDiscount, 350);
  const unavailable = data.items.find((coupon) => coupon.code === 'SPEND3000');
  assert.equal(unavailable.eligible, false);
  assert.equal(unavailable.amountNeeded, 1000);
});

test('coupon preview ignores prices and totals supplied by the browser', async () => {
  const product = await createProduct({ price: 2000, stock: 5 });
  const coupon = await createCoupon({ code: 'SAFE10', type: 'Percentage', discountValue: 10 });

  const { status, data } = await request('/api/coupons/apply', {
    method: 'POST',
    body: {
      code: coupon.code,
      cartTotal: 1,
      items: [{ product: String(product._id), quantity: 1, price: 1, lineTotal: 1 }],
    },
  });

  assert.equal(status, 200);
  assert.equal(data.discountAmount, 200);
});

test('an anonymous caller cannot list all coupons via the admin flag', async () => {
  await createCoupon({ code: 'HIDDEN1', isActive: false });
  const { data } = await request('/api/coupons?admin=true');
  assert.equal(data.some((coupon) => coupon.code === 'HIDDEN1'), false);
});

test('an admin can list inactive coupons', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'HIDDEN2', isActive: false });
  const { data } = await request('/api/admin/coupons?admin=true', { token });
  assert.equal(data.some((coupon) => coupon.code === 'HIDDEN2'), true);
});

test('the admin coupon endpoint returns management data without a query flag', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'HIDDEN3', isActive: false, usedCount: 4 });
  const { status, data } = await request('/api/admin/coupons', { token });
  assert.equal(status, 200);
  assert.equal(data.find((coupon) => coupon.code === 'HIDDEN3').usedCount, 4);
});

test('a customer cannot create a coupon', async () => {
  const { token } = await createCustomer();
  const { status } = await request('/api/admin/coupons', {
    method: 'POST',
    token,
    body: { code: 'HACK10', type: 'Flat', discountValue: 10, expiryDate: new Date(Date.now() + 86400000) },
  });
  assert.equal(status, 403);
});

test('editing a coupon does not reset its usage count', async () => {
  const { token } = await createAdmin();
  const coupon = await createCoupon({ usedCount: 7 });

  await request(`/api/admin/coupons/${coupon._id}`, { method: 'PUT', token, body: { discountValue: 250, usedCount: 0 } });

  const stored = await Coupon.findById(coupon._id);
  assert.equal(stored.usedCount, 7);
  assert.equal(stored.discountValue, 250);
});

test('a coupon at its usage limit cannot be used for a new order', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ usageLimit: 1, usedCount: 1 });

  const { status, data } = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'INVALID_COUPON');
});

test('creating a coupon ignores usedCount from the client', async () => {
  const { token } = await createAdmin();
  const { status, data } = await request('/api/admin/coupons', {
    method: 'POST',
    token,
    body: {
      code: 'INJECT50',
      type: 'Flat',
      discountValue: 50,
      expiryDate: new Date(Date.now() + 86400000),
      usedCount: 50,
      role: 'admin',
    },
  });

  assert.equal(status, 201);
  assert.equal(data.usedCount, 0);
  assert.equal((await Coupon.findById(data._id)).usedCount, 0);
});

test('coupon administration rejects invalid limits, date ranges and duplicate codes', async () => {
  const { token } = await createAdmin();
  await createCoupon({ code: 'UNIQUE10' });
  const base = { code: 'NEWCODE', type: 'Flat', discountValue: 100, expiryDate: new Date(Date.now() + 86400000) };

  const negative = await request('/api/admin/coupons', { method: 'POST', token, body: { ...base, usageLimit: -1 } });
  assert.equal(negative.status, 400);
  assert.equal(negative.data.code, 'VALIDATION_ERROR');

  const invalidDates = await request('/api/admin/coupons', {
    method: 'POST', token, body: { ...base, validFrom: new Date(Date.now() + 172800000), expiryDate: new Date(Date.now() + 86400000) },
  });
  assert.equal(invalidDates.status, 400);

  const duplicate = await request('/api/admin/coupons', { method: 'POST', token, body: { ...base, code: 'UNIQUE10' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'DUPLICATE_REQUEST');
});

test('coupon updates validate the complete resulting offer', async () => {
  const { token } = await createAdmin();
  const coupon = await createCoupon({ type: 'Flat', discountValue: 500 });

  const { status, data } = await request(`/api/admin/coupons/${coupon._id}`, {
    method: 'PUT', token, body: { type: 'Percentage' },
  });

  assert.equal(status, 400);
  assert.equal(data.code, 'VALIDATION_ERROR');
  assert.equal((await Coupon.findById(coupon._id)).type, 'Flat');
});

test('unused coupons are deleted while redeemed coupons are archived', async () => {
  const { token } = await createAdmin();
  const unused = await createCoupon({ code: 'UNUSED10' });
  const used = await createCoupon({ code: 'USEDONCE', usedCount: 1 });

  const deleted = await request(`/api/admin/coupons/${unused._id}`, { method: 'DELETE', token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.archived, false);
  assert.equal(await Coupon.findById(unused._id), null);

  const archived = await request(`/api/admin/coupons/${used._id}`, { method: 'DELETE', token });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.archived, true);
  const stored = await Coupon.findById(used._id);
  assert.equal(stored.isActive, false);
  assert.equal(stored.isPublic, false);
  assert.equal(stored.usedCount, 1);
});

test('a product-restricted coupon is refused for other products', async () => {
  const { token } = await createCustomer();
  const allowed = await createProduct({ price: 1000, stock: 5 });
  const other = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ applicableProducts: [allowed._id] });

  const refused = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(other._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'INVALID_COUPON');

  const accepted = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(allowed._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.couponDiscount, 100);
});

test('a first-order coupon is refused after the customer has ordered', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ firstOrderOnly: true });

  const first = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  assert.equal(first.status, 201);

  const second = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, 'INVALID_COUPON');
});

test('a per-customer coupon limit is enforced', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 1000, stock: 5 });
  const coupon = await createCoupon({ customerLimit: 1 });

  const first = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(first.status, 201);

  const second = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
      coupon: { code: coupon.code },
    },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.code, 'INVALID_COUPON');
});

test('an automatic free-shipping coupon wins when it saves more than a price coupon', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 500, originalPrice: 500, stock: 5 });
  await createCoupon({ code: 'AUTO50', activationMode: 'AUTOMATIC', type: 'Flat', discountValue: 50, priority: 1 });
  await createCoupon({ code: 'SHIPFREE', activationMode: 'AUTOMATIC', benefitType: 'FREE_SHIPPING', type: 'Flat', discountValue: 0 });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST', token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress(), paymentMethod: 'COD' },
  });
  assert.equal(status, 200);
  assert.equal(data.totals.coupon.code, 'SHIPFREE');
  assert.equal(data.totals.deliveryCharge, 0);
  assert.equal(data.totals.coupon.savingAmount, 99);
});

test('a free-shipping coupon respects its maximum delivery benefit', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ price: 500, originalPrice: 500, stock: 5 });
  await createCoupon({
    code: 'SHIPCAP40', activationMode: 'AUTOMATIC', benefitType: 'FREE_SHIPPING',
    type: 'Flat', discountValue: 0, maxDiscountAmount: 40,
  });

  const { status, data } = await request('/api/orders/quote', {
    method: 'POST', token,
    body: { orderItems: [{ product: String(product._id), quantity: 1 }], shippingAddress: validAddress(), paymentMethod: 'COD' },
  });
  assert.equal(status, 200);
  assert.equal(data.totals.coupon.code, 'SHIPCAP40');
  assert.equal(data.totals.deliveryCharge, 59);
  assert.equal(data.totals.coupon.savingAmount, 40);
});

test('coupon budget and per-customer limits remain atomic during concurrent checkout reservations', async () => {
  const { user } = await createCustomer();
  await CouponCustomerUsage.init();
  const customerCoupon = await createCoupon({ code: 'ONCEONLY', customerLimit: 1 });
  const customerAttempts = await Promise.allSettled([
    couponService.consumeCoupon(customerCoupon.code, { userId: user._id }),
    couponService.consumeCoupon(customerCoupon.code, { userId: user._id }),
    couponService.consumeCoupon(customerCoupon.code, { userId: user._id }),
  ]);
  assert.equal(customerAttempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal((await Coupon.findById(customerCoupon._id)).usedCount, 1);

  const budgetCoupon = await createCoupon({ code: 'BUDGET100', totalBudget: 100 });
  const budgetAttempts = await Promise.allSettled([
    couponService.consumeCoupon(budgetCoupon.code, { discountAmount: 70 }),
    couponService.consumeCoupon(budgetCoupon.code, { discountAmount: 70 }),
  ]);
  assert.equal(budgetAttempts.filter((entry) => entry.status === 'fulfilled').length, 1);
  const stored = await Coupon.findById(budgetCoupon._id);
  assert.equal(stored.usedCount, 1);
  assert.equal(stored.spentAmount, 70);
});

test('a redeemed coupon keeps an immutable code and releases by permanent coupon id', async () => {
  const { token } = await createAdmin();
  const coupon = await createCoupon({ code: 'PERMANENT10', usedCount: 1 });
  const edit = await request(`/api/admin/coupons/${coupon._id}`, {
    method: 'PUT', token, body: { code: 'RENAMED10' },
  });
  assert.equal(edit.status, 400);
  assert.equal((await Coupon.findById(coupon._id)).code, 'PERMANENT10');

  coupon.code = 'INTERNALCHANGE';
  await coupon.save();
  await couponService.releaseCoupon('PERMANENT10', { couponId: coupon._id });
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);
});

test('exclusive coupons skip discounted product lines while stackable coupons include them', () => {
  const items = [{ product: 'one', price: 800, originalPrice: 1000, quantity: 1, lineTotal: 800 }];
  assert.throws(() => couponService.calculateDiscount({ benefitType: 'DISCOUNT', type: 'Percentage', discountValue: 10, stackingMode: 'EXCLUSIVE' }, 800, items), /cannot be combined/i);
  assert.equal(couponService.calculateDiscount({ benefitType: 'DISCOUNT', type: 'Percentage', discountValue: 10, stackingMode: 'ALLOW_PRODUCT_OFFERS' }, 800, items), 80);
});

test('product and category targeting supports explicit any or all matching', () => {
  const items = [{ product: 'product-a', category: 'category-b', price: 500, originalPrice: 500, quantity: 1, lineTotal: 500 }];
  const base = { benefitType: 'DISCOUNT', type: 'Flat', discountValue: 100, applicableProducts: ['product-a'], applicableCategories: ['category-a'], stackingMode: 'ALLOW_PRODUCT_OFFERS' };
  assert.equal(couponService.calculateDiscount({ ...base, scopeMatchMode: 'ANY' }, 500, items), 100);
  assert.throws(() => couponService.calculateDiscount({ ...base, scopeMatchMode: 'ALL' }, 500, items), /does not apply/i);
});

test('coupon preview refuses a saving larger than the remaining campaign budget', async () => {
  const coupon = await createCoupon({ code: 'NEARLIMIT', type: 'Flat', discountValue: 100, totalBudget: 500, spentAmount: 450 });
  const { status, data } = await request('/api/coupons/apply', { method: 'POST', body: { code: coupon.code, cartTotal: 1000 } });
  assert.equal(status, 400);
  assert.match(data.message, /enough campaign budget/i);
});

test('coupon administration paginates the full catalogue and returns global statistics', async () => {
  const { token } = await createAdmin();
  const expiryDate = new Date(Date.now() + 7 * 86400000);
  await Coupon.insertMany(Array.from({ length: 105 }, (_, index) => ({ code: `PAGE${String(index).padStart(3, '0')}`, type: 'Flat', discountValue: 10, expiryDate, isActive: true })));
  const list = await request('/api/admin/coupons?admin=true&page=1&limit=24', { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 24);
  assert.equal(list.data.total, 105);
  assert.equal(list.data.totalPages, 5);
  const stats = await request('/api/admin/coupons/stats', { token });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.total, 105);
  assert.equal(stats.data.live, 105);
});

test('full refunds restore coupon capacity only when the coupon policy allows it', async () => {
  const { user } = await createCustomer();
  const coupon = await createCoupon({ code: 'REFUNDABLE', restoreOnFullRefund: true });
  await couponService.consumeCoupon(coupon.code, { couponId: coupon._id, userId: user._id, discountAmount: 100 });
  const order = await Order.create({
    user: user._id, orderItems: [], shippingAddress: validAddress(), paymentStatus: 'Refunded', paymentState: 'REFUNDED', orderStatus: 'Refunded',
    coupon: { couponId: coupon._id, code: coupon.code, savingAmount: 100, restoreOnFullRefund: true }, couponConsumed: true, finalAmount: 900,
  });
  assert.equal(await couponService.releaseCouponForFullyRefundedOrder(order._id), true);
  assert.equal((await Coupon.findById(coupon._id)).usedCount, 0);
  assert.equal((await Coupon.findById(coupon._id)).spentAmount, 0);
  assert.equal((await Order.findById(order._id)).couponReleased, true);
  assert.equal(await couponService.releaseCouponForFullyRefundedOrder(order._id), false, 'retries do not release twice');
});

test('coupon details expose performance, simulation and code availability to admins', async () => {
  const { token } = await createAdmin();
  const { user } = await createCustomer();
  const coupon = await createCoupon({ code: 'INSIGHT10' });
  await Order.create({
    user: user._id, orderItems: [], shippingAddress: validAddress(), paymentStatus: 'Paid', paymentState: 'PAID', orderStatus: 'Delivered',
    coupon: { couponId: coupon._id, code: coupon.code, savingAmount: 100 }, couponDiscount: 100, couponConsumed: true, finalAmount: 900,
  });
  const insights = await request(`/api/admin/coupons/${coupon._id}/insights?days=30`, { token });
  assert.equal(insights.status, 200);
  assert.equal(insights.data.summary.orders, 1);
  assert.equal(insights.data.summary.paidRevenue, 900);
  assert.equal(insights.data.recentOrders[0].customer.name, user.name);

  const simulation = await request(`/api/admin/coupons/${coupon._id}/simulate`, { method: 'POST', token, body: { cartTotal: 1000 } });
  assert.equal(simulation.status, 200);
  assert.equal(simulation.data.eligible, true);
  assert.equal(simulation.data.effectiveSaving, 100);

  const unavailable = await request('/api/admin/coupons/code-availability?code=INSIGHT10', { token });
  const available = await request('/api/admin/coupons/code-availability?code=NEWCODE10', { token });
  assert.equal(unavailable.data.available, false);
  assert.equal(available.data.available, true);
});
