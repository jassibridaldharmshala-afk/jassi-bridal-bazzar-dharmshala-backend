const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const zlib = require('node:zlib');
const { ApiError } = require('../../utils/apiError');
const { SOCIAL_HOSTS } = require('./socialImport.validation');

const mediaHost = (host) => ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'].some((domain) => host === domain || host.endsWith('.' + domain));
function checkedUrl(value, media = false) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError('SOCIAL_URL_BLOCKED', 'The post contains an unsupported media link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 8192
    || !(media ? mediaHost(url.hostname) : SOCIAL_HOSTS.has(url.hostname))) throw new ApiError('SOCIAL_URL_BLOCKED', 'The post contains an unsupported media link.');
  return url;
}
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) || a >= 224);
  }
  // Use publicly routed IPv4 only; IPv6 and mapped forms never bypass checks.
  return false;
}
async function safeRead(value, { media = false, maxBytes = 3 * 1024 * 1024, signal, redirects = 0 } = {}) {
  if (signal?.aborted) throw new ApiError('SOCIAL_CANCELLED', 'Import cancelled.');
  const url = checkedUrl(value, media);
  const records = await dns.lookup(url.hostname, { all: true, family: 4 });
  if (!records.length || records.some((record) => !publicAddress(record.address))) throw new ApiError('SOCIAL_URL_BLOCKED', 'This media address is not allowed.');
  const selected = records[0];
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      signal: requestSignal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SamiraProductImport/1.0)', 'Accept-Encoding': 'gzip, deflate', Accept: media ? '*/*' : 'text/html,application/xhtml+xml' },
      lookup: (hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
    }, resolve);
    req.setTimeout(20000, () => req.destroy(new Error('Source timed out')));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 4 || !response.headers.location) throw new ApiError('SOCIAL_UNAVAILABLE', 'The shared link could not be resolved. Paste the original post link.');
    return safeRead(new URL(response.headers.location, url).href, { media, maxBytes, signal, redirects: redirects + 1 });
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new ApiError('SOCIAL_UNAVAILABLE', 'The platform did not make this post available. Check the link or upload the product media instead.', { statusCode: 422 });
  }
  if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw new ApiError('SOCIAL_MEDIA_TOO_LARGE', 'This media file is too large to import.'); }
  const encoding = response.headers['content-encoding'];
  const stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : encoding === 'deflate' ? response.pipe(zlib.createInflate()) : response;
  if (stream !== response) response.on('error', (error) => stream.destroy(error));
  const chunks = []; let size = 0;
  const timer = setTimeout(() => response.destroy(new Error('Source timed out')), 30000);
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new ApiError('SOCIAL_MEDIA_TOO_LARGE', 'This media file is too large to import.');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0], url: url.href };
  } finally { clearTimeout(timer); stream.destroy(); response.destroy(); }
}
module.exports = { safeRead, checkedUrl, publicAddress, mediaHost };
