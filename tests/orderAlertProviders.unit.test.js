const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'isolated-provider-test';
const { encryptSecret } = require('../utils/secretBox');
const { deliver } = require('../services/orderAlertProviders');
const config = { email: { apiKey: encryptSecret('email-secret'), senderEmail: 'orders@example.com' }, whatsapp: { accessToken: encryptSecret('wa-secret'), phoneNumberId: '123456789', templateName: 'new_order', language: 'en' } };
const message = { storeName: '<b>Brand</b>', number: 'ORD-1', amount: 'INR 999.00', payment: 'Cash on delivery', itemCount: 1, link: 'https://shop.example/admin/orders/detail?id=123' };
test('Brevo uses fixed HTTPS endpoint and escaped minimal order details', async t => {
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(options.headers['api-key'], 'email-secret');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const body = JSON.parse(options.body); assert.equal(body.to[0].email, 'owner@example.com');
    assert.match(body.htmlContent, /&lt;b&gt;Brand/); assert.doesNotMatch(body.htmlContent, /<b>Brand/);
    return { ok: true, json: async () => ({ messageId: 'message-1' }) };
  });
  assert.deepEqual(await deliver('EMAIL', config, 'owner@example.com', message), { messageId: 'message-1' });
});
test('WhatsApp uses five ordered positional template parameters and bearer authentication', async t => {
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/graph.facebook.com\/v\d+\.0\/123456789\/messages$/);
    assert.equal(options.headers.authorization, 'Bearer wa-secret');
    const body = JSON.parse(options.body); assert.equal(body.to, '919876543210'); assert.equal(body.type, 'template');
    assert.deepEqual(body.template.components[0].parameters.map(p => p.text), [message.storeName, message.number, message.amount, message.payment, message.link]);
    return { ok: true, json: async () => ({ messages: [{ id: 'wa-id' }] }) };
  });
  assert.equal((await deliver('WHATSAPP', config, '+919876543210', message)).messageId, 'wa-id');
});
test('provider failures never leak bodies or secrets and only explicit rate limits automatically retry', async t => {
  for (const status of [400, 401, 429, 500]) {
    t.mock.method(global, 'fetch', async () => ({ ok: false, status, json: async () => ({ error: 'wa-secret recipient private' }) }));
    await assert.rejects(deliver('WHATSAPP', config, '+919876543210', message), error => {
      assert.doesNotMatch(error.message, /wa-secret|919876543210/);
      assert.equal(error.retryable, status === 429); assert.equal(error.uncertain, status >= 500); return true;
    });
  }
  t.mock.method(global, 'fetch', async () => { throw new Error('private network error'); });
  await assert.rejects(deliver('EMAIL', config, 'owner@example.com', message), { uncertain: true, retryable: false });
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  await assert.rejects(deliver('EMAIL', config, 'owner@example.com', message), { uncertain: true });
});
