const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { createPhotoUpload } = require('../middleware/photoUploadMiddleware');
const { cleanupStaging } = require('../services/mediaUploadService');
const uploads = path.join(__dirname, '../uploads');

async function server(t, options) {
  const before = new Set(await fs.readdir(uploads));
  const app = express();
  app.post('/', createPhotoUpload(options).array('images', options?.files || 8), async (req, res) => {
    const sizes = req.files.map(file => file.size);
    await cleanupStaging(req.files);
    res.json({ sizes });
  });
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.errorCode || error.code }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    assert.deepEqual((await fs.readdir(uploads)).filter(name => !before.has(name)), [], 'all staged files must be removed');
  });
  return `http://127.0.0.1:${listener.address().port}/`;
}
function form(bytes, count = 1) {
  const body = new FormData(), photo = new Blob([bytes], { type: 'image/jpeg' });
  for (let i = 0; i < count; i++) body.append('images', photo, `photo-${i}.jpg`);
  return body;
}

test('20 MB originals can be staged without an in-memory batch', async t => {
  const url = await server(t);
  const response = await fetch(url, { method: 'POST', body: form(Buffer.alloc(20 * 1024 * 1024)) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sizes, [20 * 1024 * 1024]);
});

test('streaming aggregate limit rejects a 64 MB batch and cleans already staged files', async t => {
  const url = await server(t, { files: 30 });
  const response = await fetch(url, { method: 'POST', body: form(Buffer.alloc(16 * 1024 * 1024), 4), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'UPLOAD_PHOTO_BATCH_TOO_LARGE');
});

test('per-photo and photo-count limits reject requests and clean staging', async t => {
  const url = await server(t, { files: 1, maxFileBytes: 1024 });
  let response = await fetch(url, { method: 'POST', body: form(Buffer.alloc(1025)) });
  assert.equal((await response.json()).code, 'LIMIT_FILE_SIZE');
  response = await fetch(url, { method: 'POST', body: form(Buffer.alloc(100), 2) });
  assert.equal((await response.json()).code, 'LIMIT_FILE_COUNT');
});

test('an interrupted multipart stream closes its file and removes staged bytes', async t => {
  const http = require('node:http');
  const url = await server(t);
  const before = new Set(await fs.readdir(uploads));
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=photo-test' } });
  req.on('error', () => {});
  req.write('--photo-test\r\nContent-Disposition: form-data; name="images"; filename="interrupted.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
  req.write(Buffer.alloc(1024 * 1024));
  for (let i = 0; i < 100; i++) {
    if ((await fs.readdir(uploads)).some(name => !before.has(name))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await fs.readdir(uploads)).some(name => !before.has(name)));
  req.destroy();
  for (let i = 0; i < 100; i++) {
    if (!(await fs.readdir(uploads)).some(name => !before.has(name))) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual((await fs.readdir(uploads)).filter(name => !before.has(name)), []);
});
