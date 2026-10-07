const crypto = require('crypto');

function verifyRazorpaySignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature, secret }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(razorpaySignature));
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function pickOrderFields(body = {}) {
  return {
    shippingAddress: body.shippingAddress,
    paymentMethod: body.paymentMethod,
    paymentProvider: body.paymentProvider,
    coupon: body.coupon,
  };
}

module.exports = {
  pickOrderFields,
  verifyRazorpaySignature,
};
