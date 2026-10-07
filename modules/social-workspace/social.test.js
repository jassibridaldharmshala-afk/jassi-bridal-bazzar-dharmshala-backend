const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'social-isolated-test-key'; process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
Object.assign(process.env, { META_APP_ID: 'test-app', META_APP_SECRET: 'test-meta-secret', META_WEBHOOK_VERIFY_TOKEN: 'test-verify', META_REDIRECT_URI: 'http://localhost:5000/api/social/oauth/callback', INSTAGRAM_BUSINESS_APP_ID: 'test-instagram-app', INSTAGRAM_BUSINESS_APP_SECRET: 'test-instagram-secret', INSTAGRAM_BUSINESS_REDIRECT_URI: 'http://localhost:5000/api/social/oauth/instagram/callback', FRONTEND_URL: 'http://localhost:3000', PUBLIC_API_URL: 'https://media.example.test', R2_PUBLIC_URL: 'https://media.example.test', R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '' });
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User'), Store = require('../../models/Store'), StoreMember = require('../../models/StoreMember'), Product = require('../../models/Product');
const Order = require('../../models/Order'), CustomerCrm = require('../../models/CustomerCrm');
const { Connection, OAuth, Thread, Message, Post, WebhookEvent } = require('./models');
const { generateToken } = require('../../utils/generateToken');
const { encryptSecret, decryptSecret } = require('../../utils/secretBox');
const meta = require('./meta'), oauth = require('./oauth'), inbox = require('./inbox'), publishing = require('./publishing'), media = require('./media');
const webhookWorker = require('./webhookWorker');

test('signatures, encryption, messaging policy and media URL guards', async t => {
  const raw = Buffer.from('{"entry":[]}'), signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
  assert.equal(meta.verifySignature(raw, signature), true); assert.equal(meta.verifySignature(Buffer.from('{}'), signature), false); assert.equal(meta.verifySignature(raw, ''), false);
  const token = encryptSecret('synthetic-page-token'); assert.notEqual(token, 'synthetic-page-token'); assert.equal(decryptSecret(token), 'synthetic-page-token');
  assert.equal(meta.replyAllowed({ lastInboundAt: new Date(Date.now() - 10000) }), true); assert.equal(meta.replyAllowed({ contextType: 'comment', lastInboundAt: new Date(Date.now() - 10000) }), false); assert.equal(meta.replyAllowed({ lastInboundAt: new Date(Date.now() - 86400000) }), false); assert.equal(meta.replyAllowed({ lastInboundAt: new Date(Date.now() + 1000) }), false); assert.equal(meta.replyAllowed({}), false);
  for (const url of ['http://media.example.test/image.jpg', 'https://evil.test/image.jpg', 'https://media.example.test.evil.test/a', 'https://user:pass@media.example.test/a']) assert.throws(() => media.trustedUrl(url));
  assert.equal(media.trustedUrl('https://media.example.test/a.jpg').hostname, 'media.example.test');
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1']) assert.equal(media.publicIPv4(ip), false);
  assert.equal(media.publicIPv4('8.8.8.8'), true);
});

test('social workspace uses isolated persistence and mocked Meta only', { timeout: 60000 }, async t => {
  let mongo, server, mode = 'normal', calls = [], counter = 0;
  const originalFetch = global.fetch, originalPrepare = media.prepare;
  try {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.14', systemBinary: process.platform === 'win32' ? path.resolve(__dirname, '../../node_modules/.cache/mongodb-binaries/mongod-x64-win32-7.0.14.exe') : undefined } });
    await mongoose.connect(mongo.getUri(), { dbName: 'isolated_social_studio' });
    await Promise.all([Connection, OAuth, Thread, Message, Post, WebhookEvent].map(model => model.init()));
    const [owner, other, support, marketing, customer] = await User.create([
      { phone: '9000000091', activeMode: 'seller', availableModes: ['customer', 'seller'] },
      { phone: '9000000092', activeMode: 'seller', availableModes: ['customer', 'seller'] },
      { phone: '9000000093', activeMode: 'seller', availableModes: ['customer', 'seller'] },
      { phone: '9000000094', activeMode: 'seller', availableModes: ['customer', 'seller'] },
      { phone: '9000000095' },
    ]);
    const store = await Store.create({ name: 'Test store', slug: 'social-test', owner: owner._id });
    const otherStore = await Store.create({ name: 'Other store', slug: 'social-other', owner: other._id });
    await StoreMember.create([{ store: store._id, user: owner._id, role: 'OWNER' }, { store: otherStore._id, user: other._id, role: 'OWNER' }, { store: store._id, user: support._id, role: 'SUPPORT' }, { store: store._id, user: marketing._id, role: 'MARKETING' }]);
    const product = await Product.create({ storeId: store._id, name: 'Rose cotton kurta', slug: 'rose-social', price: 1299, stock: 5, images: [{ url: 'https://media.example.test/photo.jpg' }, { url: 'https://media.example.test/detail.jpg' }] });
    const foreignProduct = await Product.create({ storeId: otherStore._id, name: 'Other product', slug: 'other-social', price: 99, stock: 1 });
    global.fetch = async (url, options = {}) => {
      const address = new URL(url);
      if (address.hostname === '127.0.0.1') return originalFetch(url, options);
      if (address.hostname === 'api.instagram.com') return new Response(JSON.stringify({ access_token: 'synthetic-instagram-short-token', user_id: '30001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (address.hostname === 'graph.instagram.com') {
        const edge = address.pathname.replace(/^\/v\d+\.0\//, '').replace(/^\//, '');
        const data = edge === 'access_token'
          ? { access_token: 'synthetic-instagram-long-token', expires_in: 5184000 }
          : edge === 'me' || edge === '30001'
            ? { user_id: '30001', username: 'directshop', name: 'Direct Shop' }
            : edge === '30001/subscribed_apps'
              ? { success: true }
              : null;
        if (!data) throw new Error('Unexpected Instagram mock API call: ' + edge);
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (address.hostname === 'rupload.facebook.com') { calls.push({ edge: 'reel-upload', method: options.method, params: { file_url: options.headers.file_url } }); return new Response('{"success":true}', { status: 200 }); }
      assert.equal(address.hostname, 'graph.facebook.com', 'Tests must never call other networks');
      const edge = address.pathname.replace(/^\/v\d+\.0\//, ''), method = options.method || 'GET', params = Object.fromEntries(method === 'GET' ? address.searchParams : new URLSearchParams(options.body));
      calls.push({ edge, method, params });
      let data = {};
      if (edge === 'oauth/access_token') data = { access_token: 'synthetic-user-token', expires_in: 3600 };
      else if (edge === 'me') data = { id: '9999' };
      else if (edge === 'me/permissions') data = { data: meta.SCOPES.map(permission => ({ permission, status: 'granted' })) };
      else if (edge === 'me/accounts') data = { data: [{ id: '10001', name: 'Test Page', access_token: 'synthetic-page-token', instagram_business_account: { id: '20001', username: 'testshop' } }] };
      else if (edge.endsWith('/subscribed_apps')) data = { success: true };
      else if (edge === '10001') data = { id: '10001' };
      else if (edge.endsWith('/messages') && method === 'POST') { if (mode === 'send-timeout') throw new Error('synthetic network timeout'); data = { message_id: 'sent-' + (++counter), recipient_id: 'customer1' }; }
      else if (edge.endsWith('/conversations')) data = { data: [{ id: 'thread_external', participants: { data: [{ id: '10001' }, { id: 'customer2', name: 'Second customer' }] }, messages: { data: [{ id: 'history-1', from: { id: 'customer2' }, message: 'Is this available?', created_time: new Date().toISOString() }] } }] };
      else if (edge === 'thread_external/messages' && method === 'GET') {
        if (mode === 'history-failure') throw new Error('synthetic history timeout');
        assert.equal(params.after, 'older-cursor');
        data = { data: [{ id: 'history-older', from: { id: 'customer2' }, message: 'Earlier size enquiry', created_time: new Date(Date.now() - 2 * 86400000).toISOString(), attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://media.example.test/history.jpg' } }] } }] };
      }
      else if (edge.endsWith('/video_reels')) data = params.upload_phase === 'start' ? { video_id: '33333' } : { success: true };
      else if (edge === '33333') data = { status: { uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: mode === 'reel-ready' ? 'complete' : 'not_started' } } };
      else if (edge.endsWith('/media_publish') || edge.endsWith('/feed')) { if (mode === 'publish-timeout') throw new Error('synthetic network timeout'); data = { id: 'published_' + (++counter) }; }
      else if (edge.endsWith('/media') || edge.endsWith('/photos')) data = { id: 'container_' + (++counter) };
      else if (params.fields?.includes('status_code')) data = { status_code: 'FINISHED' };
      else if (params.fields === 'permalink') data = { permalink: 'https://www.instagram.com/p/test/' };
      else throw new Error('Unexpected mock API call: ' + edge);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    media.prepare = async (_post, video) => video ? 'https://media.example.test/reel.mp4' : ['https://media.example.test/prepared.jpg'];
    const app = express();
    app.get('/api/social/oauth/start', oauth.wrap(oauth.navigate)); app.get('/api/social/oauth/callback', oauth.wrap(oauth.callback));
    app.get('/api/social/oauth/instagram/start', oauth.wrap(oauth.navigateInstagram)); app.get('/api/social/oauth/instagram/callback', oauth.wrap(oauth.callbackInstagram));
    app.get('/api/social/webhook', inbox.verifyWebhook); app.post('/api/social/webhook', express.raw({ type: '*/*' }), oauth.wrap(inbox.webhook));
    app.post('/api/social/data-deletion', express.urlencoded({ extended: false }), oauth.wrap(oauth.deauthorize)); app.get('/api/social/deletion-status/:code', oauth.wrap(oauth.deletionStatus));
    app.use(express.json()); app.use('/api/social', require('./routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (route, { method = 'GET', body, user = owner, cookie, raw, signature } = {}) => {
      const response = await fetch(base + '/api/social' + route, { method, redirect: 'manual', headers: { ...(user ? { Authorization: 'Bearer ' + generateToken(user) } : {}), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(signature ? { 'x-hub-signature-256': signature } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
      const text = await response.text(); return { status: response.status, data: (() => { try { return JSON.parse(text); } catch { return text; } })(), headers: response.headers };
    };
    let account, ig, thread, sessionId;
    await t.test('Meta webhook verification returns only a valid subscription challenge', async () => {
      const valid = await request('/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=isolated-challenge', { user: null });
      assert.equal(valid.status, 200); assert.equal(valid.data, 'isolated-challenge');
      assert.equal((await request('/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=isolated-challenge', { user: null })).status, 403);
      assert.equal((await request('/webhook?hub.mode=unsubscribe&hub.verify_token=test-verify&hub.challenge=isolated-challenge', { user: null })).status, 403);
      assert.equal(calls.length, 0, 'verification never contacts Meta or requires a signed-in shopper');
    });
    await t.test('authentication, store membership and role permissions are enforced', async () => {
      assert.equal((await request('/status', { user: null })).status, 401);
      assert.equal((await request('/status', { user: customer })).status, 403);
      assert.equal((await request('/status?storeId=' + otherStore._id)).status, 403);
      const data = (await request('/status')).data; assert.equal(data.store.id, String(store._id)); assert.equal(data.configured, true);
      assert.equal((await request('/connect', { method: 'POST', body: {}, user: support })).status, 403);
      assert.equal((await request('/threads', { user: marketing })).status, 403);
      assert.equal((await request('/posts', { method: 'POST', body: {}, user: support })).status, 403);
    });
    await t.test('OAuth has one-use state, browser binding and owner-only account selection', async () => {
      const started = await request('/connect', { method: 'POST', body: {} }); assert.equal(started.status, 200);
      const startUrl = new URL(started.data.url), state = startUrl.searchParams.get('state');
      const navigated = await request('/oauth/start' + startUrl.search, { user: null }); assert.equal(navigated.status, 302);
      const cookie = navigated.headers.get('set-cookie').split(';')[0];
      assert.match(navigated.headers.get('location'), /facebook\.com/);
      assert.equal((await request('/oauth/callback?state=' + state + '&code=test', { user: null })).status, 400);
      const callback = await request('/oauth/callback?state=' + state + '&code=test', { user: null, cookie }); assert.equal(callback.status, 302);
      const destination = new URL(callback.headers.get('location')); assert.equal(destination.searchParams.get('storeId'), String(store._id)); sessionId = destination.searchParams.get('connectionSession'); assert.ok(sessionId);
      assert.equal((await request('/oauth/callback?state=' + state + '&code=test', { user: null, cookie })).status, 400);
      assert.equal((await request('/pending/' + sessionId, { user: other })).status, 404);
      const pending = await request('/pending/' + sessionId); assert.equal(pending.data.pages.length, 1); assert.ok(!JSON.stringify(pending.data).includes('synthetic-page-token'));
      const activated = await request('/pending/' + sessionId, { method: 'POST', body: { pageIds: ['10001'] } }); assert.equal(activated.status, 200); assert.equal(activated.data.connected.length, 2);
      account = await Connection.findOne({ provider: 'facebook' }); ig = await Connection.findOne({ provider: 'instagram' });
      assert.equal(account.token, undefined); const secret = await Connection.findById(account._id).select('+token'); assert.equal(decryptSecret(secret.token), 'synthetic-page-token');
      assert.equal((await request('/pending/' + sessionId)).status, 404);
      assert.equal((await request('/status', { user: other })).data.accounts.length, 0);
    });
    await t.test('signed webhook delivery is idempotent, tracks unread and resists stale/future events', async () => {
      const sendEvent = async payload => { const raw = JSON.stringify(payload), signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex'); const response = await request('/webhook', { method: 'POST', raw, signature, user: null }); for (let i = 0; i < 50 && await WebhookEvent.exists({ status: { $in: ['pending', 'processing'] } }); i++) { await webhookWorker.tick(); await new Promise(resolve => setTimeout(resolve, 5)); } return response; };
      const payload = { object: 'page', entry: [{ id: '10001', messaging: [{ sender: { id: 'customer1' }, recipient: { id: '10001' }, timestamp: Date.now() - 1000, message: { mid: 'incoming-1', text: 'Do you have medium?', attachments: [{ type: 'image', payload: { url: 'https://media.example.test/customer-photo.jpg' } }, { type: 'file', payload: { url: 'javascript:alert(1)' } }] } }] }] };
      assert.equal((await request('/webhook', { method: 'POST', raw: JSON.stringify(payload), user: null })).status, 403);
      assert.equal((await sendEvent(payload)).status, 200); assert.equal((await sendEvent(payload)).status, 200);
      assert.equal(await Message.countDocuments({ externalId: 'incoming-1' }), 1);
      assert.deepEqual((await Message.findOne({ externalId: 'incoming-1' }).lean()).attachments, [{ type: 'image', url: 'https://media.example.test/customer-photo.jpg' }]);
      thread = await Thread.findOne({ participantId: 'customer1' });
      assert.equal((await request('/threads')).data.unread, 1);
      await request('/threads/' + thread._id + '/read', { method: 'POST', body: { readAt: thread.lastInboundAt } });
      await request('/threads/' + thread._id, { method: 'PATCH', body: { resolved: true } });
      await sendEvent(payload); assert.equal((await request('/threads')).data.unread, 0); assert.equal((await Thread.findById(thread._id)).resolved, true);
      await inbox.record(account, { id: 'stale', participantId: 'customer1', direction: 'inbound', text: 'old', sentAt: Date.now() - 86400000 });
      assert.equal((await Thread.findById(thread._id)).preview, 'Do you have medium?');
      assert.equal(await inbox.record(account, { id: 'future', participantId: 'customer1', direction: 'inbound', sentAt: Date.now() + 86400000 }), null);
      assert.equal((await request('/threads/' + thread._id, { user: other })).status, 404);
    });
    await t.test('sync imports account history without moving messages to another store', async () => {
      const result = await request('/accounts/' + account._id + '/sync', { method: 'POST', body: {} }); assert.equal(result.status, 200);
      assert.equal(await Thread.countDocuments({ storeId: store._id }), 2);
      assert.equal((await request('/accounts/' + account._id + '/sync', { method: 'POST', user: other, body: {} })).status, 409);
    });
    await t.test('messages are ordered by sent time even when older history is imported later', async () => {
      const response = await request('/threads/' + thread._id);
      assert.equal(response.data.messages[0].externalId, 'stale');
      assert.equal(response.data.messages[1].externalId, 'incoming-1');
      const older = await request('/threads/' + thread._id + '?before=' + response.data.messages[1]._id);
      assert.equal(older.data.messages.length, 1); assert.equal(older.data.messages[0].externalId, 'stale');
    });
    await t.test('thread history imports persist older messages once, preserve recent activity and enforce store permissions', async () => {
      const historyThread = await Thread.findOne({ participantId: 'customer2' });
      await Thread.updateOne({ _id: historyThread._id }, { $set: { historyCursor: 'older-cursor' } });
      const beforeCalls = calls.length;
      assert.equal((await request('/threads/' + historyThread._id + '/history', { method: 'POST', body: {}, user: marketing })).status, 403);
      assert.equal((await request('/threads/' + historyThread._id + '/history', { method: 'POST', body: {}, user: other })).status, 400);
      assert.equal(calls.length, beforeCalls, 'unauthorized history requests never reach Meta');
      mode = 'history-failure';
      assert.equal((await request('/threads/' + historyThread._id + '/history', { method: 'POST', body: {} })).status, 400);
      assert.equal((await Thread.findById(historyThread._id)).historyCursor, 'older-cursor');
      assert.equal(await Message.countDocuments({ externalId: 'history-older' }), 0);
      mode = 'normal';
      const imported = await request('/threads/' + historyThread._id + '/history', { method: 'POST', body: {}, user: support });
      assert.equal(imported.status, 200, JSON.stringify(imported.data));
      const saved = await Thread.findById(historyThread._id);
      assert.equal(saved.historyCursor, '');
      assert.equal(saved.preview, historyThread.preview);
      assert.equal(saved.lastInboundAt.getTime(), historyThread.lastInboundAt.getTime());
      const messages = (await request('/threads/' + historyThread._id)).data.messages;
      assert.deepEqual(messages.map(item => item.externalId), ['history-older', 'history-1']);
      assert.equal(messages[0].storeId, String(store._id));
      assert.equal(messages[0].threadId, String(historyThread._id));
      assert.equal(messages[0].attachments[0].url, 'https://media.example.test/history.jpg');
      const afterCalls = calls.length;
      assert.equal((await request('/threads/' + historyThread._id + '/history', { method: 'POST', body: {} })).status, 400);
      assert.equal(calls.length, afterCalls, 'completed history is not downloaded again');
      assert.equal(await Message.countDocuments({ externalId: 'history-older' }), 1);
    });
    await t.test('reply is tenant checked, bounded by customer window and idempotent even after a timeout', async () => {
      const body = { text: 'Yes, medium is available.', clientId: 'reply-test-one-00001' };
      const before = calls.filter(c => c.edge.endsWith('/messages') && c.method === 'POST').length;
      const replies = await Promise.all([1, 2].map(() => request('/threads/' + thread._id + '/reply', { method: 'POST', body })));
      assert.ok(replies.every(r => r.status === 200)); assert.equal(calls.filter(c => c.edge.endsWith('/messages') && c.method === 'POST').length, before + 1);
      assert.equal((await request('/threads/' + thread._id + '/reply', { method: 'POST', user: other, body })).status, 404);
      await Thread.updateOne({ _id: thread._id }, { $set: { lastInboundAt: new Date(Date.now() - 86400001) } });
      assert.equal((await request('/threads/' + thread._id + '/reply', { method: 'POST', body: { text: 'Hello', clientId: 'reply-test-expired-001' } })).data.code, 'REPLY_WINDOW_CLOSED');
      await Thread.updateOne({ _id: thread._id }, { $set: { lastInboundAt: new Date() } }); mode = 'send-timeout';
      const uncertain = await request('/threads/' + thread._id + '/reply', { method: 'POST', body: { text: 'Check stock', clientId: 'reply-test-uncertain-001' } }); assert.equal(uncertain.data.message.status, 'unknown');
      const callCount = calls.length; await request('/threads/' + thread._id + '/reply', { method: 'POST', body: { text: 'Check stock', clientId: 'reply-test-uncertain-001' } }); assert.equal(calls.length, callCount); mode = 'normal';
    });
    await t.test('drafts use current store product data and invalidate generated videos after image changes', async () => {
      assert.equal((await request('/products')).data.products.length, 1);
      assert.equal((await request('/posts', { method: 'POST', body: { productId: foreignProduct._id } })).status, 404);
      assert.equal((await request('/posts', { method: 'POST', body: { productId: product._id, images: ['https://evil.test/a.jpg'] } })).status, 400);
      const created = await request('/posts', { method: 'POST', body: { productId: product._id } }); assert.equal(created.status, 200); assert.match(created.data.post.caption, /1,299/);
      await Post.updateOne({ _id: created.data.post._id }, { $set: { videoStatus: 'ready', videoUrl: 'https://media.example.test/reel.mp4' } });
      const edited = await request('/posts/' + created.data.post._id, { method: 'PUT', body: { productId: product._id, images: ['https://media.example.test/detail.jpg'], caption: 'Updated caption', kind: 'reel' } }); assert.equal(edited.data.post.videoStatus, 'none'); assert.equal(edited.data.post.videoUrl, '');
      assert.equal((await request('/posts/' + created.data.post._id, { user: other })).status, 404);
    });
    await t.test('post list and detail paginate real drafts within their store and reject unsupported roles', async () => {
      const fixtures = await Post.insertMany(Array.from({ length: 22 }, (_, index) => ({ storeId: store._id, productName: 'History product ' + index, caption: 'Draft ' + index, createdAt: new Date(Date.now() + index * 1000) })));
      const foreign = await Post.create({ storeId: otherStore._id, caption: 'Private other store draft' });
      assert.equal((await request('/posts', { user: support })).status, 403);
      const first = await request('/posts');
      assert.equal(first.status, 200); assert.equal(first.data.posts.length, 20); assert.equal(first.data.hasMore, true);
      assert.ok(first.data.posts.every(post => post.storeId === String(store._id)));
      const second = await request('/posts?page=1');
      assert.equal(second.status, 200); assert.equal(second.data.hasMore, false);
      const ids = [...first.data.posts, ...second.data.posts].map(post => post._id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(fixtures.every(post => ids.includes(String(post._id))));
      const detail = await request('/posts/' + fixtures[0]._id, { user: marketing });
      assert.equal(detail.status, 200); assert.equal(detail.data.post.caption, 'Draft 0');
      assert.equal((await request('/posts/' + foreign._id)).status, 404);
      assert.equal((await request('/posts/' + fixtures[0]._id, { user: other })).status, 404);
      assert.equal((await request('/posts/' + fixtures[0]._id, { user: support })).status, 403);
      assert.equal((await request('/posts/not-an-id')).status, 400);
      await Post.deleteMany({ _id: { $in: [...fixtures.map(post => post._id), foreign._id] } });
    });
    await t.test('video request queues the original draft, rejects duplicates and publishes nothing while rendering', async () => {
      const created = await request('/posts', { method: 'POST', body: { productId: product._id, caption: 'Review my video first' } });
      assert.equal(created.status, 200);
      const id = created.data.post._id;
      assert.equal((await request('/posts/' + id + '/video', { method: 'POST', body: {}, user: support })).status, 403);
      assert.equal((await request('/posts/' + id + '/video', { method: 'POST', body: {}, user: other })).status, 409);
      const prepare = media.prepare;
      let releaseRender, renderStarted = false;
      media.prepare = async (post, video) => {
        assert.equal(String(post._id), id); assert.equal(video, true); renderStarted = true;
        return new Promise(resolve => { releaseRender = resolve; });
      };
      try {
        const queued = await request('/posts/' + id + '/video', { method: 'POST', body: {} });
        assert.equal(queued.status, 202); assert.equal(queued.data.post.videoStatus, 'queued'); assert.equal(queued.data.post.kind, 'reel');
        assert.equal((await request('/posts/' + id + '/video', { method: 'POST', body: {} })).status, 409);
        assert.equal((await request('/posts/' + id, { method: 'DELETE' })).status, 409);
        for (let attempt = 0; attempt < 100 && !renderStarted; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(renderStarted, true);
        assert.equal((await Post.findById(id)).status, 'draft');
        releaseRender('https://media.example.test/rendered-by-request.mp4');
        let saved;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          saved = await Post.findById(id);
          if (saved.videoStatus === 'ready' && !saved.workerId) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(saved.videoStatus, 'ready'); assert.equal(saved.status, 'draft');
        assert.equal(saved.videoUrl, 'https://media.example.test/rendered-by-request.mp4');
        assert.equal(saved.caption, 'Review my video first'); assert.equal(saved.targets.length, 0);
        const detail = await request('/posts/' + id); assert.equal(detail.data.post.videoStatus, 'ready');
        assert.equal((await request('/posts/' + id, { method: 'DELETE' })).status, 200);
        assert.equal(await Post.findById(id), null);
      } finally { if (releaseRender) releaseRender('https://media.example.test/rendered-by-request.mp4'); media.prepare = prepare; }
    });
    await t.test('deleting a draft is scoped and leaves published history untouched', async () => {
      const created = await request('/posts', { method: 'POST', body: { productId: product._id } });
      const id = created.data.post._id;
      assert.equal((await request('/posts/' + id, { method: 'DELETE', user: null })).status, 401);
      assert.equal((await request('/posts/' + id, { method: 'DELETE', user: support })).status, 403);
      assert.equal((await request('/posts/' + id, { method: 'DELETE', user: other })).status, 409);
      assert.ok(await Post.findById(id));
      assert.equal((await request('/posts/' + id, { method: 'DELETE' })).status, 200);
      assert.equal((await request('/posts/' + id)).status, 404);
      const published = await Post.create({ storeId: store._id, status: 'published', caption: 'Published history' });
      assert.equal((await request('/posts/' + published._id, { method: 'DELETE' })).status, 409);
      assert.equal((await Post.findById(published._id)).status, 'published');
    });
    await t.test('publishing polls Instagram containers and never duplicates a confirmed post', async () => {
      const post = await Post.create({ storeId: store._id, productId: product._id, productName: product.name, caption: 'Our new kurta', kind: 'photos', images: ['https://media.example.test/photo.jpg'], preparedImages: ['https://media.example.test/prepared.jpg'], status: 'processing', targets: [{ connectionId: ig._id, provider: 'instagram', status: 'queued' }] });
      const target = post.targets[0]; await publishing.publishTarget(post, target); assert.equal(target.status, 'processing'); assert.ok(target.containerId);
      const createCall = calls.find(c => c.edge === '20001/media'); assert.equal(createCall.params.image_url, 'https://media.example.test/prepared.jpg');
      await publishing.publishTarget(post, target); assert.equal(target.status, 'published'); const count = calls.length; await publishing.publishTarget(post, target); assert.equal(calls.length, count);
      post.status = 'published'; await post.save();
      const duplicate = await request('/posts/' + post._id + '/publish', { method: 'POST', body: { connectionIds: [ig._id] } }); assert.equal(duplicate.data.post.status, 'published'); assert.equal(calls.length, count);
    });
    await t.test('ambiguous publishing and interrupted writes require review, not automatic retries', async () => {
      const post = await Post.create({ storeId: store._id, productName: 'Test', caption: 'Test', kind: 'photos', preparedImages: ['https://media.example.test/prepared.jpg'], status: 'processing', targets: [{ connectionId: account._id, provider: 'facebook', status: 'queued' }] });
      mode = 'publish-timeout'; await publishing.publishTarget(post, post.targets[0]); assert.equal(post.targets[0].status, 'unknown'); const count = calls.length;
      await publishing.publishTarget(post, post.targets[0]); assert.equal(calls.length, count);
      post.targets[0].status = 'publishing'; await post.save(); await publishing.publishTarget(post, post.targets[0]); assert.equal(post.targets[0].status, 'unknown'); assert.equal(calls.length, count); post.status = 'review'; await post.save(); mode = 'normal';
      assert.equal((await request('/posts/' + post._id + '/retry', { method: 'POST', body: {} })).status, 400);
    });
    await t.test('Facebook Reel upload is finalized once and marked published only after Meta processing confirms it', async () => {
      const post = await Post.create({ storeId: store._id, caption: 'Our product reel', kind: 'reel', videoUrl: 'https://media.example.test/reel.mp4', status: 'processing', targets: [{ connectionId: account._id, provider: 'facebook', status: 'queued' }] });
      await publishing.publishTarget(post, post.targets[0]); assert.equal(post.targets[0].status, 'verifying');
      assert.equal(calls.find(c => c.edge === 'reel-upload').params.file_url, post.videoUrl);
      const finish = () => calls.filter(c => c.edge === '10001/video_reels' && c.params.upload_phase === 'finish');
      assert.equal(finish().length, 1); await publishing.publishTarget(post, post.targets[0]); assert.equal(finish().length, 1);
      mode = 'reel-ready'; await publishing.publishTarget(post, post.targets[0]); assert.equal(post.targets[0].status, 'published'); assert.equal(finish().length, 1);
      post.status = 'published'; await post.save(); mode = 'normal';
    });
    await t.test('render worker persists a generated video on its original editable draft', async () => {
      const post = await Post.create({ storeId: store._id, productName: product.name, kind: 'reel', images: ['https://media.example.test/photo.jpg'], status: 'draft', videoStatus: 'queued' });
      await publishing.tick();
      const saved = await Post.findById(post._id); assert.equal(saved.videoStatus, 'ready'); assert.equal(saved.status, 'draft'); assert.equal(saved.videoUrl, 'https://media.example.test/reel.mp4'); assert.equal(saved.workerId, undefined);
    });
    await t.test('confirmed failed publication resumes the same post once through the retry API', async () => {
      const post = await Post.create({ storeId: store._id, productId: product._id, productName: product.name, caption: 'Retry reviewed product', kind: 'photos', images: ['https://media.example.test/photo.jpg'], preparedImages: ['https://media.example.test/prepared.jpg'], status: 'failed', targets: [{ connectionId: ig._id, provider: 'instagram', status: 'failed', error: 'Temporary confirmed failure' }] });
      assert.equal((await request('/posts/' + post._id + '/retry', { method: 'POST', body: {}, user: support })).status, 403);
      assert.equal((await request('/posts/' + post._id + '/retry', { method: 'POST', body: {}, user: other })).status, 409);
      const before = calls.filter(call => call.edge === '20001/media_publish').length;
      const resumed = await request('/posts/' + post._id + '/retry', { method: 'POST', body: {}, user: marketing });
      assert.equal(resumed.status, 202); assert.equal(resumed.data.post._id, String(post._id));
      assert.equal(resumed.data.post.status, 'queued'); assert.equal(resumed.data.post.targets[0].status, 'queued');
      assert.equal(resumed.data.post.targets[0].error, '');
      let saved;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await publishing.tick();
        saved = await Post.findById(post._id);
        if (saved.status === 'published' && !saved.workerId) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(saved.status, 'published'); assert.equal(saved.targets[0].status, 'published');
      assert.ok(saved.targets[0].externalId); assert.equal(saved.caption, 'Retry reviewed product');
      assert.equal(calls.filter(call => call.edge === '20001/media_publish').length, before + 1);
      const after = calls.length;
      assert.equal((await request('/posts/' + post._id + '/retry', { method: 'POST', body: {}, user: marketing })).status, 409);
      await publishing.tick();
      assert.equal(calls.length, after); assert.equal(await Post.countDocuments({ _id: post._id }), 1);
    });
    await t.test('team workflow, customer context and real store insights remain tenant scoped', async () => {
      await User.updateOne({ _id: customer._id }, { $set: { name: 'Ananya Customer', email: 'ananya@example.test' } });
      await Order.create({ storeId: store._id, user: customer._id, orderItems: [{ product: product._id, name: product.name, quantity: 1, price: 1299 }], finalAmount: 1299, paymentMethod: 'COD', paymentStatus: 'Pending', orderStatus: 'Confirmed' });
      await CustomerCrm.create({ storeId: store._id, user: customer._id, tags: ['Instagram Customer'] });
      const workflow = await request('/threads/' + thread._id, { method: 'PATCH', user: support, body: { assignedTo: support._id, priority: 'HIGH', labels: ['Sizing', 'VIP'], snoozedUntil: new Date(Date.now() + 3600000) } });
      assert.equal(workflow.status, 200); assert.equal(workflow.data.thread.priority, 'HIGH'); assert.equal(String(workflow.data.thread.assignedTo._id), String(support._id));
      assert.equal((await request('/threads/' + thread._id, { method: 'PATCH', user: marketing, body: { resolved: true } })).status, 403);
      assert.equal((await request('/threads/' + thread._id + '/notes', { method: 'POST', user: support, body: { text: 'Customer asked for medium size.' } })).status, 200);
      const search = await request('/customers?search=Ananya', { user: support }); assert.equal(search.data.customers.length, 1);
      assert.equal((await request('/threads/' + thread._id + '/customer', { method: 'PUT', user: support, body: { customerId: customer._id } })).status, 200);
      const context = await request('/threads/' + thread._id + '/context', { user: support }); assert.equal(context.data.customer.name, 'Ananya Customer'); assert.equal(context.data.orders.length, 1);
      assert.equal((await request('/threads/' + thread._id + '/context', { user: other })).status, 404);
      const insight = await request('/insights?days=30', { user: support }); assert.equal(insight.status, 200); assert.ok(insight.data.messages.inbound >= 1);
      const workspace = await request('/status', { user: support }); assert.ok(workspace.data.agents.some(agent => String(agent.id) === String(support._id)));
    });
    await t.test('delivery, read, reaction and postback webhooks update the durable conversation state', async () => {
      const outgoing = await Message.create({ storeId: store._id, threadId: thread._id, connectionId: account._id, externalId: 'receipt-1', direction: 'outbound', text: 'Hello', status: 'sent', sentAt: new Date(Date.now() - 1000) });
      const payload = { object: 'page', entry: [{ id: '10001', messaging: [
        { sender: { id: '10001' }, recipient: { id: 'customer1' }, timestamp: Date.now(), delivery: { mids: ['receipt-1'], watermark: Date.now() } },
        { sender: { id: 'customer1' }, recipient: { id: '10001' }, timestamp: Date.now(), read: { watermark: Date.now() } },
        { sender: { id: 'customer1' }, recipient: { id: '10001' }, timestamp: Date.now(), reaction: { mid: 'receipt-1', action: 'react', emoji: '❤' } },
        { sender: { id: 'customer1' }, recipient: { id: '10001' }, timestamp: Date.now(), postback: { title: 'View product', payload: 'PRODUCT_1' } },
      ] }] };
      const raw = JSON.stringify(payload), signature = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
      assert.equal((await request('/webhook', { method: 'POST', raw, signature, user: null })).status, 200);
      for (let i = 0; i < 50 && await WebhookEvent.exists({ status: { $in: ['pending', 'processing'] } }); i++) { await webhookWorker.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
      const saved = await Message.findById(outgoing._id); assert.equal(saved.status, 'read'); assert.equal(saved.reaction.action, 'react');
      assert.equal(await Message.countDocuments({ externalId: { $regex: '^postback:' } }), 1);
    });
    await t.test('channel captions can be scheduled safely and cancelled before execution', async () => {
      const created = await request('/posts', { method: 'POST', user: marketing, body: { productId: product._id, images: ['https://media.example.test/photo.jpg'], caption: 'Main caption', channelCaptions: { instagram: 'Instagram caption', facebook: 'Facebook caption' }, campaign: 'Festive launch' } });
      const scheduledFor = new Date(Date.now() + 3600000).toISOString(), before = calls.length;
      const scheduled = await request('/posts/' + created.data.post._id + '/publish', { method: 'POST', user: marketing, body: { connectionIds: [ig._id], scheduledFor } });
      assert.equal(scheduled.status, 202); assert.equal(scheduled.data.post.status, 'scheduled'); assert.equal(scheduled.data.post.targets[0].caption, 'Instagram caption');
      await publishing.tick(); assert.equal(calls.length, before);
      const cancelled = await request('/posts/' + created.data.post._id + '/cancel-schedule', { method: 'POST', user: marketing, body: {} });
      assert.equal(cancelled.status, 200); assert.equal(cancelled.data.post.status, 'draft'); assert.equal(cancelled.data.post.targets.length, 0);
    });
    await t.test('direct Instagram Login completes one-use OAuth without exposing its token', async () => {
      assert.equal((await request('/connect', { method: 'POST', user: support, body: { provider: 'instagram' } })).status, 403);
      const response = await request('/connect', { method: 'POST', body: { provider: 'instagram' } }); assert.equal(response.status, 200);
      const startUrl = new URL(response.data.url), state = startUrl.searchParams.get('state');
      const navigated = await request('/oauth/instagram/start' + startUrl.search, { user: null }); assert.equal(navigated.status, 302); assert.match(navigated.headers.get('location'), /instagram\.com\/oauth\/authorize/);
      const cookie = navigated.headers.get('set-cookie').split(';')[0];
      const callback = await request('/oauth/instagram/callback?state=' + state + '&code=test-direct', { user: null, cookie }); assert.equal(callback.status, 302);
      const selectionId = new URL(callback.headers.get('location')).searchParams.get('connectionSession'); assert.ok(selectionId);
      const pending = await request('/pending/' + selectionId); assert.equal(pending.data.provider, 'instagram'); assert.equal(pending.data.pages[0].instagram.username, 'directshop'); assert.ok(!JSON.stringify(pending.data).includes('synthetic-instagram'));
      const activated = await request('/pending/' + selectionId, { method: 'POST', body: { pageIds: ['30001'] } }); assert.equal(activated.status, 200, JSON.stringify(activated.data));
      const direct = await Connection.findOne({ accountId: '30001' }).select('+token'); assert.equal(direct.authMethod, 'instagram'); assert.equal(direct.apiHost, 'graph.instagram.com'); assert.equal(decryptSecret(direct.token), 'synthetic-instagram-long-token'); assert.equal(meta.capabilities(direct).publish, true);
      assert.equal((await request('/oauth/instagram/callback?state=' + state + '&code=test-direct', { user: null, cookie })).status, 400);
    });
    await t.test('disconnect erases tenant account messages and token, preserving sibling account', async () => {
      assert.equal((await request('/accounts/' + account._id, { method: 'DELETE', user: other })).status, 404);
      assert.equal((await request('/accounts/' + account._id, { method: 'DELETE' })).status, 200);
      assert.equal(await Message.countDocuments({ connectionId: account._id }), 0); assert.equal(await Thread.countDocuments({ connectionId: account._id }), 0); assert.equal(await Connection.countDocuments({ _id: account._id }), 0); assert.equal(await Connection.countDocuments({ _id: ig._id }), 1);
    });
    await t.test('Meta data deletion requires a valid signature and returns a verifiable receipt', async () => {
      const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '9999' })).toString('base64url');
      const signature = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(payload).digest('base64url');
      const response = await originalFetch(base + '/api/social/data-deletion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ signed_request: signature + '.' + payload }) });
      assert.equal(response.status, 200); const receipt = await response.json(); assert.ok(receipt.confirmation_code);
      assert.equal(await Connection.countDocuments({ _id: ig._id }), 0);
      assert.equal((await request('/deletion-status/' + receipt.confirmation_code, { user: null })).status, 200);
      assert.equal((await request('/deletion-status/' + 'f'.repeat(64), { user: null })).status, 404);
    });
  } finally {
    publishing.stopWorker(); global.fetch = originalFetch; media.prepare = originalPrepare;
    if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if (mongo) await mongo.stop();
  }
});

test('real product video rendering produces a playable vertical H.264 MP4', { timeout: 60000 }, async t => {
  // Rendering is isolated from the closed database used by the HTTP suite.
  t.mock.method(Post, 'updateOne', async () => ({ matchedCount: 1 }));
  const folder = path.resolve(__dirname, '../../uploads'); await fs.mkdir(folder, { recursive: true });
  const source = path.join(folder, 'social-isolated-test-' + crypto.randomUUID() + '.png'); let output;
  try {
    await media.run(['-f', 'lavfi', '-i', 'color=c=0xb26783:s=640x800', '-frames:v', '1', source], folder);
    const url = await media.prepare({ _id: new mongoose.Types.ObjectId(), storeId: new mongoose.Types.ObjectId(), productName: 'Test cotton kurta', productPrice: 1299, images: ['/uploads/' + path.basename(source)] }, true);
    output = path.resolve(folder, path.basename(new URL(url).pathname));
    assert.ok(output.startsWith(folder + path.sep));
    const info = await require('../../services/videoMetadata.service').inspectVideo(output);
    assert.equal(info.width, 720); assert.equal(info.height, 1280); assert.equal(info.codec, 'h264'); assert.ok(info.durationSeconds >= 3.9 && info.durationSeconds <= 4.2);
  } finally { await fs.unlink(source).catch(() => {}); if (output) await fs.unlink(output).catch(() => {}); }
});
