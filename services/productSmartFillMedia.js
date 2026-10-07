const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns/promises');
const { publicAddress } = require('../modules/social-product-import/socialImport.network');
const { ApiError } = require('../utils/apiError');

const MAX_BYTES = 4 * 1024 * 1024;
const uploads = path.resolve(__dirname, '../uploads');
const blocked = () => new ApiError('SMART_FILL_MEDIA', 'Choose photos uploaded through this product form. Re-upload any photo that is no longer available.');
const parseUrl = (value) => { try { return new URL(value); } catch { return null; } };

function mediaLocation(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\u0000-\u001f]/.test(value)) throw blocked();
  const ownApi = parseUrl(process.env.PUBLIC_API_URL);
  const url = parseUrl(value);
  const local = !url ? value : (['localhost', '127.0.0.1'].includes(url.hostname) || ownApi?.origin === url.origin) ? url.pathname : '';
  if (/^\/uploads\/[a-zA-Z0-9_.-]+$/.test(local) && !local.includes('..') && (!url || !url.username && !url.password)) {
    return { file: path.join(uploads, local.slice('/uploads/'.length)) };
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) throw blocked();
  const r2 = parseUrl(process.env.R2_PUBLIC_URL);
  const cloud = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const inR2 = r2 && r2.origin === url.origin && url.pathname.startsWith(r2.pathname.replace(/\/$/, '') + '/');
  const inCloud = cloud && url.hostname === 'res.cloudinary.com' && url.pathname.startsWith('/' + encodeURIComponent(cloud) + '/image/');
  if (!inR2 && !inCloud) throw blocked();
  return { url };
}

function verifiedImage(buffer) {
  if (!buffer.length || buffer.length > MAX_BYTES) throw blocked();
  const mimeType = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? 'image/jpeg'
    : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '';
  if (!mimeType) throw blocked();
  return { buffer, mimeType };
}

async function readProductPhoto(value, signal, redirects = 0) {
  const location = mediaLocation(value);
  signal?.throwIfAborted();
  if (location.file) {
    const [root, resolved] = await Promise.all([fs.realpath(uploads), fs.realpath(location.file)]);
    if (path.dirname(resolved).toLowerCase() !== root.toLowerCase()) throw blocked();
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw blocked();
      const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, stat.size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return verifiedImage(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }
  const { url } = location;
  // Pin the checked address for the request to prevent DNS rebinding.
  const records = await dns.lookup(url.hostname, { all: true, family: 4 });
  signal?.throwIfAborted();
  if (!records.length || records.some(record => !publicAddress(record.address))) throw blocked();
  const selected = records[0];
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal: requestSignal, headers: { Accept: 'image/jpeg,image/png,image/webp', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, resolve);
    request.on('error', reject);
  });
  try {
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (redirects >= 2 || !response.headers.location) throw blocked();
      response.destroy();
      return await readProductPhoto(new URL(response.headers.location, url).href, signal, redirects + 1);
    }
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) throw blocked();
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BYTES) throw blocked();
      chunks.push(chunk);
    }
    return verifiedImage(Buffer.concat(chunks));
  } finally { response.destroy(); }
}

module.exports = { mediaLocation, verifiedImage, readProductPhoto };
