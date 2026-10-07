const { ApiError } = require('../utils/apiError');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { photoFile } = require('../modules/social-workspace/media');
const { sanitizeProductImages } = require('../utils/imageUtils');
const workerRoot = path.resolve(__dirname, '../../ai-video-worker');
const python = path.join(workerRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const modelDirectory = path.join(workerRoot, '.models');
let localBusy = false;

function hasLocalWorker() { return fsSync.existsSync(python) && fsSync.existsSync(path.join(modelDirectory, 'u2netp.onnx')); }

function runLocal(buffer) {
  if (localBusy) throw new Error('Worker busy');
  localBusy = true;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(workerRoot, 'app/image_background.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, U2NET_HOME: modelDirectory, OMP_NUM_THREADS: '1' },
    });
    let chunks = [], size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Worker timeout')); }, 90000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); localBusy = false; code === 0 && size <= 12 * 1024 * 1024 ? resolve(Buffer.concat(chunks)) : reject(new Error('Worker failed')); });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

async function removeStoredBackground(url) {
  // Reuse the existing media reader: configured storage roots, pinned public DNS,
  // bounded downloads and local-upload path containment. Never fetch arbitrary URLs.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-background-'));
  const file = path.join(directory, 'original');
  try {
    await photoFile(sanitizeProductImages([{ url }])[0].url, file);
    const buffer = await fs.readFile(file);
    if (buffer.length > 3 * 1024 * 1024) throw new ApiError('BACKGROUND_IMAGE_TOO_LARGE', 'Re-upload this photo to optimize it before editing.', { statusCode: 400 });
    return await removeBackground(buffer);
  } finally {
    await fs.unlink(file).catch(() => null);
    await fs.rmdir(directory).catch(() => null);
  }
}

function configuration() {
  return { url: String(process.env.AI_VIDEO_WORKER_URL || '').trim().replace(/\/$/, ''), token: String(process.env.AI_VIDEO_WORKER_SERVICE_TOKEN || '').trim() };
}

function isConfigured() { const { url, token } = configuration(); return Boolean(url && token) || hasLocalWorker(); }

async function removeBackground(buffer, fetchImpl = fetch) {
  const { url, token } = configuration();
  if (!isConfigured()) throw new ApiError('BACKGROUND_UNAVAILABLE', 'Background editing needs the image worker. Ask your administrator to connect it; original uploads still work.', { statusCode: 503 });
  try {
    if (!(url && token) && hasLocalWorker()) {
      const output = await runLocal(buffer);
      return { image: `data:image/png;base64,${output.toString('base64')}` };
    }
    const response = await fetchImpl(`${url}/internal/images/remove-background`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: buffer, signal: AbortSignal.timeout(90000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Worker rejected processing');
    if (!response.headers.get('content-type')?.startsWith('image/png')) throw new Error('Invalid result');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) throw new Error('Result too large');
      chunks.push(chunk);
    }
    const output = Buffer.concat(chunks);
    if (!output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG');
    return { image: `data:image/png;base64,${output.toString('base64')}` };
  } catch {
    throw new ApiError('BACKGROUND_PROCESSING_FAILED', 'Background processing could not finish. Retry shortly or keep the original photo. The image worker must have its background model installed.', { statusCode: 503 });
  }
}

module.exports = { isConfigured, removeBackground, removeStoredBackground };
