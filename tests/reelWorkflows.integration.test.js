const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin } = require('./factories');
const ReelImport = require('../models/ReelImport');
const ReelCandidate = require('../models/ReelCandidate');
const ProductDraft = require('../models/ProductDraft');
const storage = require('../services/mediaStorage.service');
const queue = require('../queues/reelImport.queue');
const queued = [], removed = [], deleted = [];

test.before(async () => {
  test.mock.method(storage, 'getStorageProvider', () => 'r2');
  test.mock.method(storage, 'objectExists', async source => source.storageKey.startsWith('fixture/'));
  test.mock.method(storage, 'deleteObject', async source => { deleted.push(source.storageKey); });
  test.mock.method(queue, 'enqueueReelImport', async payload => { queued.push(payload); return { queueJobId: `fixture-${payload.jobId}-${payload.attemptNumber}` }; });
  test.mock.method(queue, 'removeQueuedReelImport', async id => { removed.push(id); return true; });
  await startTestEnvironment();
});
test.after(async () => { await stopTestEnvironment(); test.mock.restoreAll(); });
test.beforeEach(async () => { await resetDatabase(); queued.length = 0; removed.length = 0; deleted.length = 0; });

async function call(method, route, body, token, status = 200) {
  const result = await request(route, { method, body, token });
  assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const sourceVideo = { provider: 'r2', storageKey: 'fixture/original.mp4', url: 'https://media.example.test/original.mp4', originalFilename: 'Fixture Reel.mp4', mimeType: 'video/mp4', sizeBytes: 1024, durationSeconds: 12 };
async function seedCandidates(owner) {
  const job = await ReelImport.create({ createdBy: owner.user._id, status: 'review_required', sourceVideo });
  const frame = number => ({ provider: 'r2', storageKey: `fixture/frame-${number}.jpg`, url: `https://media.example.test/frame-${number}.jpg`, timestampSeconds: number, qualityScore: 90 - number, selected: true });
  const first = await ReelCandidate.create({ job: job._id, groupNumber: 1, frames: [frame(1),frame(2),frame(3)], suggestions: { name: 'Rose Saree', sizingMode: 'free-size' }, confidence: { overall: 0.9 } });
  const second = await ReelCandidate.create({ job: job._id, groupNumber: 2, frames: [frame(4),frame(5)], suggestions: { name: 'Wine Saree', sizingMode: 'free-size' }, confidence: { overall: 0.8 } });
  return { job, first, second };
}

test('stored reel creation, list/detail, cancellation, retry and deletion preserve ownership and queue state', async () => {
  const owner = await createAdmin(), other = await createAdmin();
  const capabilities = await call('GET', '/api/admin/social-imports/capabilities', undefined, owner.token);
  assert.equal(typeof capabilities.photoAnalysis, 'boolean');
  const created = await call('POST', '/api/admin/reel-imports', { sourceVideo }, owner.token, 202);
  const id = created.data.id;
  assert.equal(created.data.status, 'queued'); assert.equal(queued.length, 1);
  const duplicate = await call('POST', '/api/admin/reel-imports', { sourceVideo }, owner.token);
  assert.equal(duplicate.data.id, id); assert.equal(queued.length, 1);
  assert.equal((await call('GET', '/api/admin/reel-imports?search=Fixture', undefined, owner.token)).data.length, 1);
  assert.equal((await call('GET', `/api/admin/reel-imports/${id}/candidates`, undefined, owner.token)).data.length, 0);
  await call('GET', `/api/admin/reel-imports/${id}`, undefined, other.token, 404);
  await call('POST', `/api/admin/reel-imports/${id}/retry`, {}, owner.token, 409);
  assert.equal((await call('POST', `/api/admin/reel-imports/${id}/cancel`, {}, owner.token)).data.status, 'cancelled');
  assert.equal(removed.length, 1);
  assert.equal((await call('POST', `/api/admin/reel-imports/${id}/retry`, {}, owner.token, 202)).data.status, 'queued');
  assert.equal(queued.length, 2);
  await call('POST', `/api/admin/reel-imports/${id}/cancel`, {}, owner.token);
  await call('DELETE', `/api/admin/reel-imports/${id}`, undefined, other.token, 404);
  await call('DELETE', `/api/admin/reel-imports/${id}`, undefined, owner.token);
  assert.deepEqual(deleted, [sourceVideo.storageKey]);
  assert.equal(await ReelImport.countDocuments(), 0);
  await call('GET', `/api/admin/reel-imports/${id}`, undefined, owner.token, 404);
});

test('reel grouping can merge, split and move photos while retaining frame identities and review history', async () => {
  const owner = await createAdmin(), other = await createAdmin();
  const { job, first, second } = await seedCandidates(owner);
  const base = `/api/admin/reel-imports/${job._id}`;
  await call('POST', `${base}/candidates/merge`, { candidateIds: [first._id,second._id] }, other.token, 404);
  const merged = (await call('POST', `${base}/candidates/merge`, { candidateIds: [first._id,second._id] }, owner.token, 201)).data;
  assert.equal(merged.frames.length, 5);
  assert.equal(merged.frames.filter(frame => frame.selected).length, 4);
  assert.equal((await ReelCandidate.findById(first._id)).status, 'merged');
  assert.equal(merged.suggestions.name, 'Rose Saree');
  const frameIds = merged.frames.slice(0,2).map(frame => frame._id);
  const split = (await call('POST', `${base}/candidates/${merged.id}/split`, { frameIds }, owner.token, 201)).data;
  assert.equal(split.source.frames.length, 3); assert.equal(split.created.frames.length, 2);
  const moved = (await call('POST', `${base}/candidates/${split.created.id}/move-frame`, { frameId: split.created.frames[0]._id, targetCandidateId: split.source.id }, owner.token)).data;
  assert.equal(moved.source.frames.length, 1); assert.equal(moved.target.frames.length, 4);
  const allIds = [...moved.source.frames,...moved.target.frames].map(frame => frame._id);
  assert.equal(new Set(allIds).size, 5);
  assert.deepEqual(new Set(allIds), new Set(merged.frames.map(frame => frame._id)));
  assert.equal((await ReelCandidate.findById(moved.source.id)).audit.at(-1).action, 'frame_moved_out');
  const candidates = await call('GET', `${base}/candidates`, undefined, owner.token);
  assert.equal(candidates.data.length, 4);
  await call('DELETE', base, undefined, owner.token);
  assert.equal(await ReelCandidate.countDocuments({ job: job._id }), 0);
});

test('reel photos cannot move into the same group or away from a saved product draft', async () => {
  const owner = await createAdmin();
  const { job, first, second } = await seedCandidates(owner);
  const route = `/api/admin/reel-imports/${job._id}/candidates/${first._id}/move-frame`;
  await call('POST', route, { frameId: first.frames[0]._id, targetCandidateId: first._id }, owner.token, 400);
  await call('POST', route, { frameId: first.frames[0]._id, targetCandidateId: 'malformed-group-id' }, owner.token, 400);
  const draft = await ProductDraft.create({ name: 'Saved Saree', sourceJobId: job._id, sourceCandidateId: first._id, sourceType: 'reel-import' });
  first.productDraft = draft._id; first.status = 'draft_created'; await first.save();
  await call('POST', route, { frameId: first.frames[0]._id, targetCandidateId: second._id }, owner.token, 409);
  assert.equal((await ReelCandidate.findById(first._id)).frames.length, 3);
  assert.equal((await ReelCandidate.findById(second._id)).frames.length, 2);
  await call('DELETE', `/api/admin/reel-imports/${job._id}`, undefined, owner.token, 409);
});
