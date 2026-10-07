const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, getBaseUrl, request } = require('./helpers');
const { createAdmin, createProduct } = require('./factories');
const ProductDraft = require('../models/ProductDraft');
const Banner = require('../models/Banner');
const ReelImport = require('../models/ReelImport');
const ReelCandidate = require('../models/ReelCandidate');
const Operation = require('../models/UploadOperation');
const { Post } = require('../modules/social-workspace/models');
const storage = require('../services/mediaStorage.service');
const metadata = require('../services/videoMetadata.service');
const queue = require('../queues/reelImport.queue');
let videoUploads = 0, queueFails = false, queueCalls = 0;
test.before(async () => {
  test.mock.method(metadata, 'inspectVideo', async () => ({ durationSeconds: 2, width: 160, height: 240 }));
  test.mock.method(storage, 'uploadOriginalVideo', async (_file, options) => { videoUploads++; return { provider: 'r2', storageKey: `fixture/${options.uploadId || crypto.randomUUID()}.mp4`, url: 'https://test.invalid/video.mp4' }; });
  test.mock.method(storage, 'objectExists', async source => source.storageKey.startsWith('fixture/'));
  test.mock.method(queue, 'enqueueReelImport', async payload => { queueCalls++; if (queueFails) throw Object.assign(new Error('synthetic queue outage'), { code: 'REEL_QUEUE_UNAVAILABLE', statusCode: 503 }); return { queueJobId: `fixture-${payload.jobId}` }; });
  await startTestEnvironment();
});
test.after(async () => { await stopTestEnvironment(); test.mock.restoreAll(); });
test.beforeEach(async () => { await resetDatabase(); videoUploads = 0; queueCalls = 0; queueFails = false; });
const headers = key => ({ 'Idempotency-Key': key });

test('normal draft retries return one current record, reject changed payloads and never resurrect deletion', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID(), body = { name: 'Retry-safe draft', sku: 'RETRY-ONE' };
  const one = await request('/api/admin/product-drafts', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(one.status, 201, JSON.stringify(one.data));
  const id = one.data.data._id;
  const two = await request('/api/admin/product-drafts', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(two.status, 201); assert.equal(two.data.data._id, id); assert.equal(await ProductDraft.countDocuments(), 1);
  assert.equal((await request('/api/admin/product-drafts', { method: 'POST', token, body: { ...body, name: 'Changed' }, headers: headers(key) })).status, 409);
  await request(`/api/admin/product-drafts/${id}/archive`, { method: 'PATCH', token });
  assert.equal((await request(`/api/admin/product-drafts/${id}?confirm=${encodeURIComponent(body.name)}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await request('/api/admin/product-drafts', { method: 'POST', token, body, headers: headers(key) })).status, 409);
  assert.equal(await ProductDraft.countDocuments(), 0);
});

test('a saved record survives receipt-completion failure without a second insert', async t => {
  const { token } = await createAdmin(), key = crypto.randomUUID(), body = { name: 'Committed draft' };
  const original = Operation.updateOne.bind(Operation); let fail = true;
  t.mock.method(Operation, 'updateOne', (filter, update, ...rest) => {
    if (fail && update.$set?.status === 'COMPLETE') { fail = false; throw new Error('synthetic receipt completion failure'); }
    return original(filter, update, ...rest);
  });
  assert.equal((await request('/api/admin/product-drafts', { method: 'POST', token, body, headers: headers(key) })).status, 500);
  assert.equal(await ProductDraft.countDocuments(), 1);
  assert.equal((await request('/api/admin/product-drafts', { method: 'POST', token, body, headers: headers(key) })).status, 201);
  assert.equal(await ProductDraft.countDocuments(), 1);
});

test('banner retries reuse their campaign/record identity and replays reflect current state', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID(), body = { title: 'One banner', image: '/uploads/one.jpg' };
  const one = await request('/api/admin/banners', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(one.status, 201, JSON.stringify(one.data));
  await Banner.updateOne({ _id: one.data._id }, { $set: { title: 'Edited after creation' } });
  const two = await request('/api/admin/banners', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(two.status, 201); assert.equal(two.data._id, one.data._id); assert.equal(two.data.title, 'Edited after creation');
  assert.equal(two.data.campaignKey, one.data.campaignKey); assert.equal(await Banner.countDocuments(), 1);
});

test('social draft lost-response retries create one post and deletion invalidates the receipt', async () => {
  const { token } = await createAdmin(), product = await createProduct({ images: [{ url: '/uploads/one.jpg', primary: true }] });
  const key = crypto.randomUUID(), body = { productId: String(product._id), images: ['/uploads/one.jpg'], caption: 'One post' };
  const one = await request('/api/social/posts', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  const two = await request('/api/social/posts', { method: 'POST', token, body, headers: headers(key) });
  assert.equal(two.status, 200); assert.equal(two.data.post._id, one.data.post._id); assert.equal(await Post.countDocuments(), 1);
  assert.equal((await request(`/api/social/posts/${one.data.post._id}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await request('/api/social/posts', { method: 'POST', token, body, headers: headers(key) })).status, 409);
  assert.equal(await Post.countDocuments(), 0);
});

async function reel(token, key, bytes = 'synthetic-video') {
  const form = new FormData(); form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'one.mp4');
  const response = await fetch(`${getBaseUrl()}/api/admin/reel-imports`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers(key) }, body: form });
  return { status: response.status, data: await response.json() };
}
test('a queue outage returns the existing recoverable reel; multipart/JSON retries upload and create only once', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID(); queueFails = true;
  const one = await reel(token, key); assert.equal(one.status, 202, JSON.stringify(one.data)); assert.equal(one.data.data.status, 'failed');
  queueFails = false;
  const two = await reel(token, key);
  assert.equal(two.status, 202); assert.equal(two.data.data.id, one.data.data.id);
  const resumed = await request('/api/admin/reel-imports', { method: 'POST', token, headers: headers(key), body: { resumeUpload: true } });
  assert.equal(resumed.status, 202); assert.equal(resumed.data.data.id, one.data.data.id);
  assert.equal(videoUploads, 1); assert.equal(queueCalls, 1); assert.equal(await ReelImport.countDocuments(), 1);
  assert.equal((await reel(token, key, 'changed-video')).status, 409);
  const retry = await request(`/api/admin/reel-imports/${one.data.data.id}/retry`, { method: 'POST', token, body: {} });
  assert.equal(retry.status, 202); assert.equal(videoUploads, 1); assert.equal(queueCalls, 2);
});

test('reel insert failure resumes the uploaded video without requiring the video bytes', async t => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  const original = ReelImport.create.bind(ReelImport); let fail = true;
  t.mock.method(ReelImport, 'create', (...args) => { if (fail) { fail = false; throw new Error('synthetic insert outage'); } return original(...args); });
  assert.equal((await reel(token, key)).status, 500);
  const resumed = await request('/api/admin/reel-imports', { method: 'POST', token, headers: headers(key), body: { resumeUpload: true } });
  assert.equal(resumed.status, 202, JSON.stringify(resumed.data)); assert.equal(videoUploads, 1); assert.equal(await ReelImport.countDocuments(), 1);
});

test('stored-source imports reuse legacy default-store records instead of creating another job after upgrade', async () => {
  const { user, token } = await createAdmin();
  const sourceVideo = { provider: 'r2', storageKey: 'fixture/legacy.mp4', url: 'https://test.invalid/legacy.mp4', originalFilename: 'legacy.mp4', mimeType: 'video/mp4', sizeBytes: 12, durationSeconds: 2 };
  const old = await ReelImport.create({ createdBy: user._id, sourceVideo, status: 'review_required' });
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' });
  try {
    const result = await request('/api/admin/reel-imports', { method: 'POST', token, body: { sourceVideo } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.data.id, String(old._id));
    assert.equal(await ReelImport.countDocuments(), 1); assert.equal(queueCalls, 0);
  } finally { for (const name of Object.keys(process.env)) if (name.startsWith('R2_')) delete process.env[name]; }
});

test('a fully uploaded image receipt resumes through the authenticated upload endpoint without multipart bytes', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID(), form = new FormData();
  const bytes = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  form.append('images', new Blob([bytes], { type: 'image/webp' }), 'one.webp');
  let publicId;
  try {
    const response = await fetch(`${getBaseUrl()}/api/admin/uploads?folder=products`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers(key) }, body: form });
    assert.equal(response.status, 201); const one = await response.json(); publicId = one.files[0].publicId;
    const two = await request('/api/admin/uploads?folder=products', { method: 'POST', token, headers: headers(key), body: { resumeUpload: true } });
    assert.equal(two.status, 201); assert.equal(two.data.files[0].publicId, publicId);
    const other = await createAdmin(); assert.equal((await request('/api/admin/uploads?folder=products', { method: 'POST', token: other.token, headers: headers(key), body: { resumeUpload: true } })).status, 404);
  } finally { if (publicId) await fs.unlink(path.join(__dirname, '..', 'uploads', publicId)).catch(() => {}); }
});

for (const checkpointFails of [false, true]) test(`Social Studio resumes partial generated photos (checkpoint failure: ${checkpointFails})`, { timeout: 60000 }, async t => {
  const media = require('../modules/social-workspace/media');
  const r2 = require('../services/r2Upload');
  const owner = await createAdmin(), store = await require('../services/storeService').ensureDefaultStore();
  const source = path.join(__dirname, '..', 'uploads', `test-social-retry-${crypto.randomUUID()}.png`);
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' });
  const client = r2.getR2Client(), keys = new Set(); let writes = 0, fail = true;
  t.mock.method(client, 'send', async command => {
    if (command.constructor.name === 'HeadObjectCommand') { if (!keys.has(command.input.Key)) throw Object.assign(new Error('missing'), { name: 'NotFound' }); return {}; }
    if (command.constructor.name === 'PutObjectCommand') {
      if (!checkpointFails && fail && keys.size === 1) { fail = false; throw new Error('synthetic second photo failure'); }
      writes++; keys.add(command.input.Key); return {};
    }
    throw new Error('unexpected storage action');
  });
  if (checkpointFails) {
    const original = Post.updateOne.bind(Post);
    t.mock.method(Post, 'updateOne', (filter, update, ...rest) => { if (fail && Object.keys(update.$set || {}).some(key => key.startsWith('generationAssets.'))) { fail = false; throw new Error('synthetic checkpoint outage'); } return original(filter, update, ...rest); });
  }
  try {
    await media.run(['-f', 'lavfi', '-i', 'color=c=0xb26783:s=320x400', '-frames:v', '1', source], path.dirname(source));
    const post = await Post.create({ storeId: store._id, createdBy: owner.user._id, images: [`/uploads/${path.basename(source)}`, `/uploads/${path.basename(source)}`], productName: 'Retry photos' });
    await assert.rejects(media.prepare(post, false), /synthetic/);
    const resumed = await Post.findById(post._id), urls = await media.prepare(resumed, false);
    assert.equal(urls.length, 2); assert.equal(keys.size, 2); assert.equal(writes, 2);
    const cached = await Post.findById(post._id);
    assert.deepEqual(await media.prepare(cached, false), urls); assert.equal(writes, 2);
    assert.equal(media.generatedAssets(cached).length, 2);
  } finally { await fs.unlink(source).catch(() => {}); for (const name of Object.keys(process.env)) if (name.startsWith('R2_')) delete process.env[name]; }
});

async function workerFixture(overrides = {}) {
  const { user } = await createAdmin();
  const job = await ReelImport.create({ createdBy: user._id, status: 'queued', sourceVideo: { provider: 'r2', storageKey: 'fixture/worker.mp4', url: 'https://test.invalid/worker.mp4', originalFilename: 'worker.mp4', mimeType: 'video/mp4', sizeBytes: 12, durationSeconds: 2 }, ...overrides });
  return { job, input: { jobId: String(job._id), storageKey: 'fixture/worker.mp4' } };
}
function workerResult() {
  return { candidates: [1, 2].map(groupNumber => ({ groupNumber, frames: [{ provider: 'r2', storageKey: `fixture/frame-${groupNumber}.jpg`, url: `https://test.invalid/frame-${groupNumber}.jpg`, timestampSeconds: groupNumber, qualityScore: 90 }], suggestions: { name: `Product ${groupNumber}` } })) };
}
test('concurrent reel workers cannot reprocess the same live job; queue retries are delayed rather than completed', async t => {
  const local = require('../services/localReelProcessor.service');
  const worker = require('../workers/reelImport.processor');
  const { input } = await workerFixture(); let entered, release, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(local, 'processReelLocally', async () => { calls++; entered(); await new Promise(resolve => { release = resolve; }); return workerResult(); });
  const processing = worker.processReelImportJob(input);
  try {
    await started;
    assert.deepEqual(await worker.processReelImportJob(input), { busy: true });
    let delayed = false;
    await assert.rejects(worker.processQueuedReelImport({ data: input, moveToDelayed: async (at, token) => { delayed = true; assert.equal(token, 'test-lock'); assert.ok(at > Date.now()); } }, 'test-lock'), error => error instanceof require('bullmq').DelayedError);
    assert.equal(delayed, true); assert.equal(calls, 1);
  } finally { release(); await processing; }
  assert.equal(await ReelCandidate.countDocuments(), 2);
});

test('a partial candidate insert is filled on retry without duplicating or overwriting the first group', async t => {
  const local = require('../services/localReelProcessor.service');
  const worker = require('../workers/reelImport.processor');
  t.mock.method(local, 'processReelLocally', async () => workerResult());
  const original = ReelCandidate.bulkWrite.bind(ReelCandidate); let fail = true;
  t.mock.method(ReelCandidate, 'bulkWrite', async operations => { if (fail) { fail = false; await original(operations.slice(0, 1)); throw new Error('synthetic partial insert'); } return original(operations); });
  const { job, input } = await workerFixture();
  await assert.rejects(worker.processReelImportJob(input), /synthetic partial insert/);
  assert.equal(await ReelCandidate.countDocuments(), 1);
  const first = await ReelCandidate.findOne({ job: job._id, groupNumber: 1 });
  await ReelCandidate.updateOne({ _id: first._id }, { $set: { 'suggestions.name': 'Already reviewed' } });
  await worker.processReelImportJob(input);
  assert.equal(await ReelCandidate.countDocuments(), 2);
  assert.equal((await ReelCandidate.findById(first._id)).suggestions.name, 'Already reviewed');
  assert.equal((await ReelImport.findById(job._id)).status, 'review_required');
});

test('an expired crashed-worker lease recovers on the same job rather than creating another job', async t => {
  const local = require('../services/localReelProcessor.service');
  t.mock.method(local, 'processReelLocally', async () => workerResult());
  const { job, input } = await workerFixture({ status: 'processing', activeRunId: 'crashed-worker', lastHeartbeatAt: new Date(Date.now() - 120000), attemptCount: 1 });
  await require('../workers/reelImport.processor').processReelImportJob(input);
  const recovered = await ReelImport.findById(job._id);
  assert.equal(recovered.status, 'review_required'); assert.equal(recovered.attemptCount, 2); assert.equal(await ReelImport.countDocuments(), 1);
});
