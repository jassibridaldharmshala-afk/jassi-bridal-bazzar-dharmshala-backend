#!/usr/bin/env node
/**
 * Fast, dependency-free checks for the pure payment helpers.
 * Run: npm run test:payments
 *
 * The database-backed payment flow (verification against the stored order,
 * webhook idempotency, stock movement) is covered by `npm test`, which boots
 * an in-memory MongoDB replica set.
 */
const assert = require('assert');
const crypto = require('crypto');
const { verifyRazorpaySignature, pickOrderFields } = require('../utils/paymentUtils');

function testSignatureVerification() {
  const secret = 'test_secret_key';
  const orderId = 'order_abc123';
  const paymentId = 'pay_xyz789';
  const validSignature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
    secret,
  }), true);

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: 'invalid',
    secret,
  }), false);

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: '',
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
    secret,
  }), false);

  assert.strictEqual(verifyRazorpaySignature({
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
    secret: 'a_different_secret',
  }), false);

  console.log('\u2713 Razorpay signature verification');
}

function testPickOrderFields() {
  const fields = pickOrderFields({
    shippingAddress: { fullName: 'Jassi User', city: 'Jaipur' },
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    coupon: { code: 'SAVE10', discount: 100 },
    extraField: 'should-not-leak',
  });

  assert.deepStrictEqual(fields, {
    shippingAddress: { fullName: 'Jassi User', city: 'Jaipur' },
    paymentMethod: 'UPI',
    paymentProvider: 'Razorpay',
    coupon: { code: 'SAVE10', discount: 100 },
  });
  assert.strictEqual(fields.extraField, undefined);
  console.log('\u2713 pickOrderFields whitelist');
}

function testCouponDiscountRules() {
  const { calculateDiscount } = require('../services/couponService');

  assert.strictEqual(calculateDiscount({ type: 'Percentage', discountValue: 10 }, 2000), 200);
  assert.strictEqual(calculateDiscount({ type: 'Percentage', discountValue: 50, maxDiscountAmount: 300 }, 5000), 300);
  assert.strictEqual(calculateDiscount({ type: 'Flat', discountValue: 5000 }, 800), 800, 'discount cannot exceed the cart total');
  assert.strictEqual(calculateDiscount(null, 800), 0);
  console.log('\u2713 Coupon discount calculation');
}

function testPaymentSettingRules() {
  const { assertPaymentMethodAllowed, resolveCodCharge, resolveDeliveryCharge } = require('../services/paymentSettingsService');

  assert.strictEqual(resolveCodCharge('COD', { codCharge: 49 }), 49);
  assert.strictEqual(resolveCodCharge('UPI', { codCharge: 49 }), 0);
  assert.strictEqual(resolveDeliveryCharge(1500, { deliveryCharge: 99, freeShippingMinAmount: 999 }), 0);
  assert.strictEqual(resolveDeliveryCharge(500, { deliveryCharge: 99, freeShippingMinAmount: 999 }), 99);

  assert.throws(
    () => assertPaymentMethodAllowed('COD', { codEnabled: false }, { razorpayConfigured: true }),
    /Cash on Delivery is currently unavailable/,
  );
  assert.throws(
    () => assertPaymentMethodAllowed('COD', { codEnabled: true, codMaxAmount: 1000 }, { razorpayConfigured: true, orderAmount: 2000 }),
    /up to Rs. 1000/,
  );
  assert.throws(
    () => assertPaymentMethodAllowed('UPI', { razorpayEnabled: true }, { razorpayConfigured: false }),
    /Online payment is not available/,
  );
  assert.throws(
    () => assertPaymentMethodAllowed('CRYPTO', { codEnabled: true }, { razorpayConfigured: true }),
    /valid payment method/,
  );

  assertPaymentMethodAllowed('UPI', { razorpayEnabled: true, upiEnabled: true }, { razorpayConfigured: true });
  assertPaymentMethodAllowed('COD', { codEnabled: true, codMaxAmount: 5000 }, { razorpayConfigured: false, orderAmount: 2000 });
  console.log('\u2713 Payment method and charge rules');
}

function run() {
  testSignatureVerification();
  testPickOrderFields();
  testCouponDiscountRules();
  testPaymentSettingRules();
  console.log('\nAll payment helper tests passed. Run "npm test" for the full database-backed suite.');
}

try {
  run();
} catch (error) {
  console.error('\nPayment flow test failed:', error.message);
  process.exit(1);
}
