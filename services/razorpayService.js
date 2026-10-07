const Razorpay = require('razorpay');

let client;

function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function getRazorpayClient() {
  if (!isRazorpayConfigured()) return null;
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

async function createRazorpayOrder({ amountInPaise, receipt, notes = {} }) {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');

  if (process.env.RAZORPAY_MOCK === '1') {
    return {
      id: `order_mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes,
    };
  }

  const razorpay = getRazorpayClient();
  if (!razorpay) throw new Error('Razorpay is not configured');

  try {
    return await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes,
    });
  } catch (error) {
    const message = error?.error?.description || error?.message || 'Razorpay order creation failed';
    const wrapped = new Error(message);
    // Preserve a provider's explicit rejection separately from an ambiguous
    // network/server failure, without changing legacy callers' error shape.
    wrapped.razorpayDefinitiveRejection = [400, 401, 403, 422].includes(Number(error?.statusCode)) && Boolean(error?.error);
    if (Number(error?.statusCode) === 401) {
      wrapped.statusCode = 401;
      wrapped.razorpayAuthError = true;
    } else {
      wrapped.statusCode = 500;
      wrapped.razorpayError = true;
    }
    throw wrapped;
  }
}

async function refundRazorpayPayment({ paymentId, amountInPaise, notes = {}, idempotencyKey }) {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');
  if (!paymentId) throw new Error('The original Razorpay payment ID is missing');
  const safeKey = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(safeKey)) throw new Error('A valid refund idempotency key is required');
  if (process.env.RAZORPAY_MOCK === '1') return { id: `rfnd_mock_${safeKey}`, payment_id: paymentId, amount: amountInPaise, status: 'processed' };
  try {
    const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json', 'X-Refund-Idempotency': safeKey },
      body: JSON.stringify({ amount: amountInPaise, speed: 'normal', receipt: safeKey, notes }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerError = new Error(payload?.error?.description || payload?.error?.reason || 'Razorpay refund failed');
      providerError.statusCode = response.status; throw providerError;
    }
    return payload;
  } catch (error) {
    const message = error?.error?.description || error?.message || 'Razorpay refund failed';
    const wrapped = new Error(message); wrapped.statusCode = Number(error?.statusCode) || 502; wrapped.razorpayError = true; throw wrapped;
  }
}

async function fetchRazorpayRefund(refundId) {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');
  const safeId = String(refundId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(safeId)) throw new Error('A valid Razorpay refund ID is required');
  if (process.env.RAZORPAY_MOCK === '1') return { id: safeId, status: 'processed' };
  try {
    const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetch(`https://api.razorpay.com/v1/refunds/${encodeURIComponent(safeId)}`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerError = new Error(payload?.error?.description || payload?.error?.reason || 'Razorpay refund lookup failed');
      providerError.statusCode = response.status;
      throw providerError;
    }
    return payload;
  } catch (error) {
    const wrapped = new Error(error?.message || 'Razorpay refund lookup failed');
    wrapped.statusCode = Number(error?.statusCode) || 502;
    wrapped.razorpayError = true;
    throw wrapped;
  }
}

async function createRazorpayPaymentLink({ amountInPaise, referenceId, description, customer = {}, expireBy, notes = {} }) {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');
  const reference = String(referenceId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(reference)) throw new Error('A valid payment-link reference is required');
  if (process.env.RAZORPAY_MOCK === '1') return {
    id: `plink_mock_${reference}`,
    reference_id: reference,
    short_url: `https://rzp.io/i/mock-${reference}`,
    amount: amountInPaise,
    status: 'created',
    expire_by: expireBy,
  };
  const razorpay = getRazorpayClient();
  try {
    return await razorpay.paymentLink.create({
      amount: amountInPaise,
      currency: 'INR',
      accept_partial: false,
      reference_id: reference,
      description: String(description || 'Exchange price difference').slice(0, 2048),
      customer: {
        ...(customer.name ? { name: String(customer.name).slice(0, 100) } : {}),
        ...(customer.email ? { email: String(customer.email).slice(0, 254) } : {}),
        ...(customer.contact ? { contact: String(customer.contact).slice(0, 20) } : {}),
      },
      notify: { sms: false, email: false },
      reminder_enable: true,
      expire_by: expireBy,
      notes,
    });
  } catch (error) {
    const wrapped = new Error(error?.error?.description || error?.message || 'Razorpay payment link creation failed');
    wrapped.statusCode = Number(error?.statusCode) || 502;
    wrapped.razorpayError = true;
    throw wrapped;
  }
}

module.exports = {
  createRazorpayOrder,
  createRazorpayPaymentLink,
  refundRazorpayPayment,
  fetchRazorpayRefund,
  isRazorpayConfigured,
};
