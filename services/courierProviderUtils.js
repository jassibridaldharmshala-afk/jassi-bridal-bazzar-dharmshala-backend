const { ApiError } = require('../utils/apiError');

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

function providerError(provider, message, { ambiguous = false, statusCode = 503 } = {}) {
  const error = new ApiError('SHIPPING_UNAVAILABLE', `${provider}: ${message}`, { statusCode });
  error.ambiguous = ambiguous;
  return error;
}

async function responseBuffer(response, limit, provider, write) {
  const chunks = [];
  let size = 0;
  if (response.body && response.body[Symbol.asyncIterator]) {
    for await (const chunk of response.body) {
      const value = Buffer.from(chunk);
      size += value.length;
      if (size > limit) throw providerError(provider, 'the carrier response was too large.', { ambiguous: write });
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > limit) throw providerError(provider, 'the carrier response was too large.', { ambiguous: write });
  return value;
}

async function request(provider, url, options = {}, { write = false, limit = MAX_JSON_BYTES } = {}) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      throw providerError(provider, auth ? 'authentication or API access was rejected. Check the backend credentials and account permissions.' : 'the carrier could not complete this request. Please try again later.', { statusCode: auth ? 503 : response.status >= 500 ? 503 : 400, ambiguous: write && response.status >= 500 });
    }
    return { response, buffer: await responseBuffer(response, limit, provider, write) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw providerError(provider, 'the carrier could not be reached. Please try again later.', { ambiguous: write });
  }
}

async function requestJson(provider, url, options = {}, write = false) {
  const { buffer } = await request(provider, url, options, { write });
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw providerError(provider, 'the carrier returned an unreadable response.', { ambiguous: write }); }
}

function trustedDownloadUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === 'https:' && [
      'shiprocket.in', 'amazonaws.com', 'amazonaws.com.cn', 'storage.googleapis.com',
      'delhivery.com', 'xpressbees.com', 'xbees.in',
    ].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
    return allowed ? url.href : '';
  } catch { return ''; }
}

async function downloadPdf(provider, url) {
  const safe = trustedDownloadUrl(url);
  if (!safe) throw providerError(provider, 'the label download address was not trusted. Download the original label from the carrier dashboard.');
  const { response, buffer } = await request(provider, safe, { headers: { Accept: 'application/pdf' } }, { limit: MAX_PDF_BYTES });
  if (!trustedDownloadUrl(response.url || safe) || buffer.subarray(0, 5).toString() !== '%PDF-') throw providerError(provider, 'the carrier did not return a readable PDF label. Download it from the carrier dashboard.');
  return buffer;
}

function safeText(value, max = 250) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function statusFromText(value) {
  const status = safeText(value).toUpperCase();
  if (/RTO.*DELIVER|RETURNED TO (ORIGIN|SHIPPER)|RETURN DELIVER/.test(status)) return 'RETURNED';
  if (/RTO|RETURN TO (ORIGIN|SHIPPER)|RETURN IN TRANSIT/.test(status)) return 'RTO_IN_TRANSIT';
  if (/CANCEL/.test(status)) return 'CANCELLED';
  if (/DELIVERED/.test(status)) return 'DELIVERED';
  if (/OUT FOR DELIVERY|OFD/.test(status)) return 'OUT_FOR_DELIVERY';
  if (/PICKED|PICKUP DONE|PICKUP COMPLETE/.test(status)) return 'PICKED_UP';
  if (/PICKUP.*SCHEDULE|PICKUP.*GENERAT|READY TO SHIP|MANIFEST/.test(status)) return 'PICKUP_SCHEDULED';
  if (/SHIPPED|IN TRANSIT|DISPATCH|REACHED|ARRIVED|DEPARTED|CONNECTED/.test(status)) return 'IN_TRANSIT';
  if (/UNDELIVERED|ATTEMPT|EXCEPTION|FAILED|DELAY|HELD|DAMAGED|LOST|NDR|REFUSED/.test(status)) return 'EXCEPTION';
  return null;
}

function providerEnv(prefix, key) {
  return String(process.env[`${prefix}_${key}`] || '').trim();
}

module.exports = { dateValue, downloadPdf, providerEnv, providerError, request, requestJson, safeText, statusFromText, trustedDownloadUrl };
