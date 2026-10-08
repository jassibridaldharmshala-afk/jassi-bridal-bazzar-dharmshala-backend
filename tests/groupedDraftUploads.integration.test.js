const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestEnvironment, stopTestEnvironment, resetDatabase, getBaseUrl, request } = require('./helpers');
const { createAdmin } = require('./factories');
const ProductDraft = require('../models/ProductDraft');
const Operation = require('../models/UploadOperation');
const r2 = require('../services/r2Upload');

before(async () => {
  // Test only: authenticate through the real app without external licence traffic.
  mock.method(require('../services/controlPlaneClient'), 'licenseStatus', async () => ({ managed: false, status: 'ACTIVE' }));
  await startTestEnvironment();
});
after(async () => { await stopTestEnvironment(); mock.restoreAll(); });
beforeEach(resetDatabase);

const image = Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAIAAUAmJZACdLoAA5gA/vLrfrynxNt/V2J8KCwAAA==', 'base64');
const groups = [
  { name: 'Lehenga', photoIndexes: [0, 1, 2, 3], coverIndex: 2 },
  { name: 'Jewellery', photoIndexes: [4, 5, 6, 7, 8, 9], coverIndex: 7 },
  { name: 'Jaimala', photoIndexes: [10, 11], coverIndex: 11 },
];
const storageEnv = { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test', R2_PUBLIC_URL: 'https://test.invalid' };
async function upload(token, key, photoGroups) {
  const form = new FormData();
  for (let index = 0; index < 12; index += 1) form.append('images', new Blob([image], { type: 'image/webp' }), `view-${index}.webp`);
  form.append('groupMode', 'grouped'); form.append('photoGroups', JSON.stringify(photoGroups));
  const response = await fetch(`${getBaseUrl()}/api/admin/product-drafts/bulk-upload`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key } });
  return { status: response.status, data: await response.json() };
}

test('mixed 4/6/2 product groups survive an interrupted save and receipt replay', async () => {
  const { token } = await createAdmin(), key = crypto.randomUUID();
  const nativeCreate = ProductDraft.create, nativeUpload = r2.uploadImageToR2;
  let mediaWrites = 0, inserts = 0;
  Object.assign(process.env, storageEnv);
  r2.uploadImageToR2 = async (file, options) => { mediaWrites += 1; return { url: `https://test.invalid/${file.originalname}`, publicId: options.uploadId, originalName: file.originalname }; };
  try {
    ProductDraft.create = async (...args) => { inserts += 1; if (inserts === 2) throw new Error('interrupted group insert'); return nativeCreate.apply(ProductDraft, args); };
    const failed = await upload(token, key, groups);
    assert.equal(failed.status, 500, JSON.stringify(failed.data));
    assert.equal(await ProductDraft.countDocuments(), 0);
    ProductDraft.create = nativeCreate;
    const created = await request('/api/admin/product-drafts/bulk-upload', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.data.drafts.map((draft) => draft.images.length), [4, 6, 2]);
    assert.deepEqual(created.data.data.drafts.map((draft) => draft.name), ['Lehenga', 'Jewellery', 'Jaimala']);
    assert.deepEqual(created.data.data.drafts.map((draft) => draft.image), ['https://test.invalid/view-2.webp', 'https://test.invalid/view-7.webp', 'https://test.invalid/view-11.webp']);
    for (const draft of created.data.data.drafts) assert.equal(draft.images.filter((photo) => photo.primary).length, 1);
    const replay = await request('/api/admin/product-drafts/bulk-upload', { method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { resumeUpload: true } });
    assert.deepEqual(replay.data.data.drafts.map((draft) => draft._id), created.data.data.drafts.map((draft) => draft._id));
    assert.equal(await ProductDraft.countDocuments(), 3);
    assert.equal(mediaWrites, 24);
    const list = await request('/api/admin/product-drafts', { token });
    assert.equal(list.data.meta.photoGrouping.version, 1);
  } finally {
    ProductDraft.create = nativeCreate; r2.uploadImageToR2 = nativeUpload;
    for (const key of Object.keys(storageEnv)) delete process.env[key];
  }
});

test('duplicate photo assignments are rejected before media or drafts are stored', async () => {
  const { token } = await createAdmin(), nativeUpload = r2.uploadImageToR2;
  let mediaWrites = 0;
  Object.assign(process.env, storageEnv);
  r2.uploadImageToR2 = async () => { mediaWrites += 1; throw new Error('must not upload'); };
  try {
    const result = await upload(token, crypto.randomUUID(), [{ ...groups[0], photoIndexes: [0, 1, 2, 3, 4] }, groups[1], groups[2]]);
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.equal(result.data.code, 'VALIDATION_ERROR');
    assert.equal(mediaWrites, 0);
    assert.equal(await ProductDraft.countDocuments(), 0);
    assert.equal((await Operation.findOne()).files.filter(Boolean).length, 0);
  } finally { r2.uploadImageToR2 = nativeUpload; for (const key of Object.keys(storageEnv)) delete process.env[key]; }
});
