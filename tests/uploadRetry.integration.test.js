const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, getBaseUrl, request } = require('./helpers');
const { createAdmin } = require('./factories');
const { runUploadRequest, invalidateStoredUpload, persistLocal } = require('../services/uploadRetryService');
const Operation = require('../models/UploadOperation');
const ProductDraft = require('../models/ProductDraft');
const r2 = require('../services/r2Upload');
const cloud = require('../services/cloudinaryUpload');
test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

function req(key = crypto.randomUUID(), overrides = {}) {
  return { headers: { 'idempotency-key': key }, user: { _id: new mongoose.Types.ObjectId() }, store: { _id: new mongoose.Types.ObjectId() },
    originalUrl: '/api/admin/uploads', query: { folder: 'products' }, body: {}, files: [{ buffer: Buffer.from('one'), mimetype: 'image/webp', originalname: 'one.webp' }], ...overrides };
}
function save(counter) { return async ({ uploadId }) => { counter.calls += 1; return { url: `https://test.invalid/${uploadId}`, publicId: uploadId, provider: 'r2' }; }; }

test('a failed database/save step retries without re-uploading the completed media', async () => {
  const request = req(), counter = { calls: 0 };
  await assert.rejects(runUploadRequest(request, async context => { await context.upload(request.files[0], 0, save(counter)); throw new Error('draft insert failed'); }), /draft insert failed/);
  const result = await runUploadRequest(request, async context => ({ files: [await context.upload(request.files[0], 0, save(counter))] }));
  assert.equal(counter.calls, 1);
  assert.equal(result.files.length, 1);
  assert.equal((await Operation.findOne()).status, 'COMPLETE');
});
test('partial batches reuse completed files and replay a lost successful response', async () => {
  const request = req(); request.files.push({ ...request.files[0], buffer: Buffer.from('two'), originalname: 'two.webp' });
  const first = { calls: 0 }, second = { calls: 0 };
  await assert.rejects(runUploadRequest(request, async context => { await context.upload(request.files[0], 0, save(first)); throw new Error('second failed'); }));
  const work = async context => ({ files: [await context.upload(request.files[0], 0, save(first)), await context.upload(request.files[1], 1, save(second))] });
  const result = await runUploadRequest(request, work);
  assert.deepEqual(await runUploadRequest(request, () => { throw new Error('must not run'); }), result);
  assert.equal(first.calls, 1); assert.equal(second.calls, 1);
});
test('concurrent clicks cannot claim the same upload; crashed leases recover with the same storage identity', async () => {
  const request = req(); let unlock; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = runUploadRequest(request, async context => { entered(); await new Promise(resolve => { unlock = resolve; }); return context.upload(request.files[0], 0, async options => ({ url: 'https://test.invalid/one', publicId: options.uploadId, provider: 'r2' })); });
  await started;
  await assert.rejects(runUploadRequest(request, () => {}), error => error.errorCode === 'UPLOAD_IN_PROGRESS');
  unlock(); const result = await pending;
  await Operation.updateOne({}, { $set: { status: 'RUNNING', files: [], leaseUntil: new Date(0), owner: 'crashed' }, $unset: { result: '' } });
  const recovered = await runUploadRequest(request, context => context.upload(request.files[0], 0, async options => {
    assert.equal(options.recovering, true);
    return { url: 'https://test.invalid/one', publicId: options.uploadId, provider: 'r2' };
  }));
  assert.equal(recovered.publicId, result.publicId);
});
test('payload changes are rejected, while different actors/stores/intents never share media', async () => {
  const request = req(), counter = { calls: 0 };
  const work = request => context => context.upload(request.files[0], 0, save(counter));
  const original = await runUploadRequest(request, work(request));
  await assert.rejects(runUploadRequest({ ...request, body: { groupMode: 'single' } }, work(request)), error => error.errorCode === 'UPLOAD_RETRY_CONFLICT');
  await assert.rejects(runUploadRequest({ ...request, files: [{ ...request.files[0], buffer: Buffer.from('changed') }] }, work(request)), error => error.errorCode === 'UPLOAD_RETRY_CONFLICT');
  const actor = { ...request, user: { _id: new mongoose.Types.ObjectId() } };
  const store = { ...request, store: { _id: new mongoose.Types.ObjectId() } };
  const intent = { ...request, headers: { 'idempotency-key': crypto.randomUUID() } };
  for (const other of [actor, store, intent]) assert.notEqual((await runUploadRequest(other, work(other))).publicId, original.publicId);
  assert.equal(counter.calls, 4);
});
test('removed media receipts cannot resurrect deleted objects, and old clients still work', async () => {
  const request = req(), counter = { calls: 0 };
  const result = await runUploadRequest(request, context => context.upload(request.files[0], 0, save(counter)));
  await invalidateStoredUpload('r2', result.publicId);
  await assert.rejects(runUploadRequest(request, () => {}), error => error.errorCode === 'UPLOAD_RETRY_CONFLICT');
  assert.equal(await runUploadRequest({ headers: {} }, async context => { assert.equal(context.managed, false); return 'legacy'; }), 'legacy');
});

const image = Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAIAAUAmJZACdLoAA5gA/vLrfrynxNt/V2J8KCwAAA==', 'base64');
async function multipart(token, key, endpoint = '/api/admin/product-drafts/bulk-upload') {
  const form = new FormData(); form.append('images', new Blob([image], { type: 'image/webp' }), 'one.webp'); form.append('groupMode', 'single');
  const response = await fetch(`${getBaseUrl()}${endpoint}`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key } });
  return { status: response.status, data: await response.json() };
}
test('real draft upload survives insert failure, response loss and deliberate draft deletion', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  const originalCreate = ProductDraft.create;
  const originalUpload = r2.uploadImageToR2;
  const counter = { calls: 0 };
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' });
  r2.uploadImageToR2 = async (file, options) => ({ ...await save(counter)(options), originalName: file.originalname });
  try {
    ProductDraft.create = async () => { throw new Error('simulated draft insert failure'); };
    const failed = await multipart(token, key); assert.equal(failed.status, 500, JSON.stringify(failed.data));
    ProductDraft.create = originalCreate;
    const created = await request('/api/admin/product-drafts/bulk-upload', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const replay = await request('/api/admin/product-drafts/bulk-upload', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true } });
    assert.equal(replay.status, 201, JSON.stringify(replay.data));
    assert.equal(replay.data.data.drafts[0]._id, created.data.data.drafts[0]._id);
    assert.equal(await ProductDraft.countDocuments(), 1);
    const media = created.data.data.drafts[0].images[0];
    assert.equal(media.variants.length, 1); assert.equal(media.variants[0].width, (await require('sharp')(image).metadata()).width);
    assert.deepEqual(replay.data.data.drafts[0].images[0].variants, media.variants);
    assert.equal(counter.calls, 1 + media.variants.length);
    assert.equal(created.data.data.drafts[0].uploadOperationId, undefined);
    await ProductDraft.deleteMany({});
    const removed = await multipart(token, key); assert.equal(removed.status, 409);
    assert.equal(await ProductDraft.countDocuments(), 0); assert.equal(counter.calls, 1 + media.variants.length);
  } finally { ProductDraft.create = originalCreate; r2.uploadImageToR2 = originalUpload; for (const name of Object.keys(process.env)) if (name.startsWith('R2_')) delete process.env[name]; }
});
test('local retries retain one durable file and remove all disposable staging copies', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  let publicId;
  try {
    const created = await multipart(token, key, '/api/admin/uploads?folder=products'); assert.equal(created.status, 201, JSON.stringify(created.data));
    publicId = created.data.files[0].publicId;
    const replay = await multipart(token, key, '/api/admin/uploads?folder=products'); assert.equal(replay.status, 201);
    assert.equal(replay.data.files[0].publicId, publicId);
    const bytes = await fs.readFile(path.join(__dirname, '..', 'uploads', publicId)); assert.deepEqual(bytes, image);
    await fs.unlink(path.join(__dirname, '..', 'uploads', publicId));
    assert.equal((await multipart(token, key, '/api/admin/uploads?folder=products')).status, 409);
  } finally { if (publicId) await fs.unlink(path.join(__dirname, '..', 'uploads', publicId)).catch(() => {}); }
});
test('interrupted local copies never expose a partial file, and recovery repairs an old incomplete target', async () => {
  const uploadId = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
  const source = path.join(__dirname, '..', 'uploads', `test-${crypto.randomUUID()}.webp`);
  const target = path.join(__dirname, '..', 'uploads', `retry-${uploadId}.webp`);
  const nativeCopy = fs.copyFile;
  let staging;
  try {
    await fs.writeFile(source, image);
    const file = { path: source, originalname: 'one.webp', mimetype: 'image/webp', size: image.length };
    fs.copyFile = async (_source, destination) => {
      staging = destination;
      await fs.writeFile(destination, image.subarray(0, 5));
      throw new Error('synthetic interrupted copy');
    };
    await assert.rejects(persistLocal(file, { uploadId, recovering: true }), /interrupted copy/);
    assert.equal(await fs.access(target).then(() => true, () => false), false);
    assert.equal(await fs.access(staging).then(() => true, () => false), false);
    fs.copyFile = nativeCopy;
    // A partial target from an older release must not be mistaken for success.
    await fs.writeFile(target, image.subarray(0, 5));
    const recovered = await persistLocal(file, { uploadId, recovering: true });
    assert.equal(recovered.publicId, path.basename(target));
    assert.deepEqual(await fs.readFile(target), image);
    const replay = await persistLocal(file, { uploadId, recovering: true });
    assert.equal(replay.publicId, recovered.publicId);
  } finally {
    fs.copyFile = nativeCopy;
    for (const filename of [source, target, staging].filter(Boolean)) await fs.unlink(filename).catch(() => {});
  }
});
test('permanent draft deletion invalidates its upload receipt and a retry cannot recreate it', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  const created = await multipart(token, key); assert.equal(created.status, 201);
  const draft = created.data.data.drafts[0];
  const internal = await ProductDraft.findById(draft._id).select('+uploadOperationId');
  assert.ok(internal.uploadOperationId);
  assert.equal((await request(`/api/admin/product-drafts/${draft._id}/archive`, { method: 'PATCH', token })).status, 200);
  const removed = await request(`/api/admin/product-drafts/${draft._id}?confirm=${draft._id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await Operation.findById(internal.uploadOperationId)).status, 'REMOVED');
  const replay = await request('/api/admin/product-drafts/bulk-upload', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true } });
  assert.equal(replay.status, 409); assert.equal(await ProductDraft.countDocuments(), 0);
});
test('Cloudinary uses a signed non-overwriting identity and recovers a committed upload without sending bytes again', async () => {
  const filePath = path.join(__dirname, '..', 'uploads', `test-${crypto.randomUUID()}.webp`);
  const nativeFetch = global.fetch;
  const uploadId = 'a'.repeat(64); const calls = [];
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test' });
  try {
    await fs.writeFile(filePath, image);
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ secure_url: 'https://test.invalid/photo', public_id: `samira-products/retry-${uploadId}` }) };
    };
    const file = { path: filePath, mimetype: 'image/webp', originalname: 'one.webp' };
    await cloud.uploadImage(file, { uploadId });
    const form = calls[0].options.body;
    assert.equal(form.get('overwrite'), 'false'); assert.equal(form.get('public_id'), `retry-${uploadId}`);
    const signature = crypto.createHash('sha1').update(`folder=samira-products&overwrite=false&public_id=retry-${uploadId}&timestamp=${form.get('timestamp')}test`).digest('hex');
    assert.equal(form.get('signature'), signature);
    await cloud.uploadImage(file, { uploadId, recovering: true });
    assert.equal(calls.length, 2); assert.equal(calls[1].options.body, undefined);
  } finally { global.fetch = nativeFetch; for (const name of Object.keys(process.env)) if (name.startsWith('CLOUDINARY_')) delete process.env[name]; await fs.unlink(filePath).catch(() => {}); }
});

test('R2 recovers an ambiguous committed write by checking its stable object key, not uploading another object', async () => {
  const filePath = path.join(__dirname, '..', 'uploads', `test-${crypto.randomUUID()}.webp`);
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' });
  const client = r2.getR2Client(), nativeSend = client.send; const calls = []; const keys = new Set();
  try {
    await fs.writeFile(filePath, image);
    client.send = async command => {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'PutObjectCommand') { keys.add(command.input.Key); throw new Error('response lost after commit'); }
      if (!keys.has(command.input.Key)) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    };
    const file = { path: filePath, mimetype: 'image/webp', originalname: 'one.webp', size: image.length };
    const options = { uploadId: 'b'.repeat(64), folder: 'products' };
    await assert.rejects(r2.uploadImageToR2(file, options), /response lost/);
    const recovered = await r2.uploadImageToR2(file, { ...options, recovering: true });
    assert.equal(keys.size, 1); assert.ok(keys.has(recovered.publicId));
    assert.deepEqual(calls, ['PutObjectCommand', 'HeadObjectCommand']);
    client.send = async () => { throw Object.assign(new Error('forbidden'), { $metadata: { httpStatusCode: 403 } }); };
    await assert.rejects(r2.uploadImageToR2(file, { ...options, recovering: true }), /forbidden/);
  } finally { client.send = nativeSend; for (const name of Object.keys(process.env)) if (name.startsWith('R2_')) delete process.env[name]; await fs.unlink(filePath).catch(() => {}); }
});

test('removing a display version invalidates its receipt without recreating it on replay', async () => {
  const counter = { calls: 0 }, input = req();
  const stored = await runUploadRequest(input, context => context.upload(input.files[0], 0, async options => ({ ...await save(counter)(options), variants: [{ provider: 'r2', publicId: 'display-one', url: 'https://test.invalid/display-one' }] })));
  await invalidateStoredUpload('r2', stored.variants[0].publicId);
  await assert.rejects(runUploadRequest(input, () => { throw new Error('Must not re-upload'); }), error => error.errorCode === 'UPLOAD_RETRY_CONFLICT');
  assert.equal(counter.calls, 1);
});
