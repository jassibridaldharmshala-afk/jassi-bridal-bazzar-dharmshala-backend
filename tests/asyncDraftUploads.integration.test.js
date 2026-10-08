const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, request, getBaseUrl } = require('./helpers');
const { createAdmin } = require('./factories');
const ProductDraft = require('../models/ProductDraft');
const Operation = require('../models/UploadOperation');
const { waitForActiveUploads, getUploadStatus } = require('../services/uploadRetryService');
const r2 = require('../services/r2Upload');
const path = '/api/admin/product-drafts/bulk-upload';
const image = Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAIAAUAmJZACdLoAA5gA/vLrfrynxNt/V2J8KCwAAA==', 'base64');
const storageEnv = { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' };
before(startTestEnvironment);
after(async () => { await waitForActiveUploads(); await stopTestEnvironment(); });
beforeEach(resetDatabase);
async function upload(token, key, count = 16) {
  const form = new FormData();
  for (let index = 0; index < count; index++) form.append('images', new Blob([image], { type: 'image/webp' }), `photo-${index}.webp`);
  form.append('groupMode', 'separate'); form.append('asyncUpload', 'true');
  const response = await fetch(getBaseUrl() + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: form });
  return { status: response.status, data: await response.json() };
}
const status = (token, key) => request(path + '/status', { token, headers: { 'Idempotency-Key': key } });
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Upload processing did not reach the expected state.');
}

test('sixteen separate photos are accepted before storage completes, show private progress, and create exactly sixteen recoverable drafts', async () => {
  const admin = await createAdmin(), other = await createAdmin(), key = crypto.randomUUID();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = r2.uploadImageToR2, staged = new Set();
  let writes = 0, active = 0, peak = 0;
  Object.assign(process.env, storageEnv);
  r2.uploadImageToR2 = async (file, options) => {
    writes++; active++; peak = Math.max(peak, active);
    if (file.path) staged.add(file.path);
    try { await gate; return { url: 'https://test.invalid/' + options.uploadId, publicId: options.uploadId, originalName: file.originalname }; }
    finally { active--; }
  };
  try {
    const accepted = await upload(admin.token, key);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
    assert.equal(accepted.data.data.upload.fileCount, 16);
    assert.equal(await ProductDraft.countDocuments(), 0);
    await until(() => writes === 2);
    const progress = await status(admin.token, key);
    assert.equal(progress.status, 200); assert.equal(progress.data.data.upload.status, 'RUNNING');
    assert.equal(progress.data.data.upload.completedFiles, 0);
    assert.equal(progress.data.data.upload.phase, 'storing-original');
    assert.ok([...staged].every(filename => !filename.includes('secret')));
    for (const filename of staged) await fs.access(filename); // originals remain while the worker owns them
    assert.equal((await status(other.token, key)).status, 404);
    assert.equal((await request(path + '/status', { headers: { 'Idempotency-Key': key } })).status, 401);
    const replay = await request(path, { method: 'POST', token: admin.token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true, asyncUpload: true } });
    assert.equal(replay.status, 202); assert.equal(writes, 2);
    const receipt = await Operation.findOne().lean();
    await assert.rejects(getUploadStatus({ user: admin.user, store: { _id: 'foreign-store' }, headers: { 'idempotency-key': key } }, { requestPath: path }), error => error.errorCode === 'NOT_FOUND');
    assert.equal(JSON.stringify(progress.data).includes(receipt._id), false);
    release(); await waitForActiveUploads();
    const complete = await status(admin.token, key);
    assert.equal(complete.status, 200); assert.equal(complete.data.data.drafts.length, 16);
    assert.equal(await ProductDraft.countDocuments(), 16); assert.equal(writes, 32); assert.ok(peak <= 2);
    for (const filename of staged) assert.equal(await fs.access(filename).then(() => true, () => false), false);
    const recovered = await request(path, { method: 'POST', token: admin.token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true, asyncUpload: true } });
    assert.equal(recovered.status, 201);
    assert.deepEqual(recovered.data.data.drafts.map(draft => draft._id), complete.data.data.drafts.map(draft => draft._id));
    assert.equal(writes, 32);
    await ProductDraft.deleteMany({});
    assert.equal((await status(admin.token, key)).status, 409);
  } finally {
    release(); await waitForActiveUploads(); r2.uploadImageToR2 = original;
    for (const name of Object.keys(storageEnv)) delete process.env[name];
  }
});

test('concurrent photo batches have bounded queue admission and only two active storage writes', async () => {
  const { token } = await createAdmin(), original = r2.uploadImageToR2;
  let release, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  Object.assign(process.env, storageEnv);
  r2.uploadImageToR2 = async (file, options) => {
    active++; peak = Math.max(peak, active);
    try { await gate; return { url: 'https://test.invalid/' + options.uploadId, publicId: options.uploadId, originalName: file.originalname }; }
    finally { active--; }
  };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => upload(token, crypto.randomUUID(), 1)));
    assert.equal(results.filter(result => result.status === 202).length, 4);
    const busy = results.filter(result => result.status === 503);
    assert.equal(busy.length, 1); assert.equal(busy[0].data.code, 'UPLOAD_QUEUE_BUSY');
    assert.ok(peak <= 2);
    release(); await waitForActiveUploads();
    assert.equal(await ProductDraft.countDocuments(), 4);
    assert.equal(await Operation.countDocuments({ status: 'PENDING' }), 1);
  } finally { release(); await waitForActiveUploads(); r2.uploadImageToR2 = original; for (const name of Object.keys(storageEnv)) delete process.env[name]; }
});

test('a background draft-save failure reports safe retry guidance and resumes without another photo upload', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  const originalUpload = r2.uploadImageToR2, originalCreate = ProductDraft.create;
  let writes = 0;
  Object.assign(process.env, storageEnv);
  r2.uploadImageToR2 = async (file, options) => { writes++; return { url: 'https://test.invalid/' + options.uploadId, publicId: options.uploadId, originalName: file.originalname }; };
  ProductDraft.create = async () => { throw new Error('private database diagnostic must never appear in status'); };
  try {
    assert.equal((await upload(token, key, 2)).status, 202);
    await waitForActiveUploads();
    const failed = await status(token, key);
    assert.equal(failed.data.data.upload.status, 'PENDING'); assert.equal(failed.data.data.upload.completedFiles, 2);
    assert.match(failed.data.data.upload.message, /Retry with the same photos/);
    assert.equal(JSON.stringify(failed.data).includes('private database'), false);
    assert.equal(await ProductDraft.countDocuments(), 0); assert.equal(writes, 4);
    ProductDraft.create = originalCreate;
    const retry = await request(path, { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true, asyncUpload: true } });
    assert.equal(retry.status, 202);
    await waitForActiveUploads();
    assert.equal((await status(token, key)).data.data.drafts.length, 2); assert.equal(writes, 4);
  } finally {
    ProductDraft.create = originalCreate; await waitForActiveUploads(); r2.uploadImageToR2 = originalUpload;
    for (const name of Object.keys(storageEnv)) delete process.env[name];
  }
});
