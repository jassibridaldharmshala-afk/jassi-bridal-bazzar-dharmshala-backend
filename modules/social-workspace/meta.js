const crypto = require('crypto');
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_messaging', 'pages_manage_posts', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_content_publish'];
const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_content_publish'];
function config() {
  return {
    appId: process.env.META_APP_ID || '', secret: process.env.META_APP_SECRET || '',
    version: /^v\d+\.0$/.test(process.env.META_GRAPH_VERSION || '') ? process.env.META_GRAPH_VERSION : 'v23.0',
    callback: process.env.META_REDIRECT_URI || '', verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    instagramAppId: process.env.INSTAGRAM_BUSINESS_APP_ID || '',
    instagramSecret: process.env.INSTAGRAM_BUSINESS_APP_SECRET || '',
    instagramCallback: process.env.INSTAGRAM_BUSINESS_REDIRECT_URI || '',
    frontend: String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
  };
}
function fail(message, status = 400, code = 'SOCIAL_ERROR') { return Object.assign(new Error(message), { statusCode: status, code }); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function equal(a, b) { const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || '')); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function verifySignature(body, signature) {
  if (!Buffer.isBuffer(body)) return false;
  return [config().secret, config().instagramSecret].filter(Boolean).some(secret => equal(signature, 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')));
}
function signedRequest(value) {
  const [signature, payload, extra] = String(value || '').split('.');
  const secrets = [config().secret, config().instagramSecret].filter(Boolean);
  if (!signature || !payload || extra || !secrets.length) throw fail('Invalid signed request.', 403);
  if (!secrets.some(secret => equal(signature, crypto.createHmac('sha256', secret).update(payload).digest('base64url')))) throw fail('Invalid signed request.', 403);
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.algorithm !== 'HMAC-SHA256' || !data.user_id) throw fail('Invalid signed request.', 403);
  return data;
}
function apiError(response, data, write) {
  const code = Number(data?.error?.code);
  let message = 'Meta could not complete this request. Please try again later.';
  if ([190, 102].includes(code)) message = 'This account connection expired. Reconnect it in Accounts.';
  else if ([10, 200, 294].includes(code)) message = 'Meta has not granted the required permission. Check app access and reconnect this account.';
  else if ([4, 17, 32, 613].includes(code) || response.status === 429) message = 'Meta rate limit reached. Wait a few minutes before trying again.';
  else if (data?.error?.error_user_msg) message = String(data.error.error_user_msg).slice(0, 400);
  return Object.assign(fail(message, 400, 'META_REQUEST_FAILED'), { metaCode: code, ambiguous: Boolean(write && response.status >= 500) });
}
async function request(path, { token, method = 'GET', params = {}, host = 'graph.facebook.com' } = {}) {
  // Callers supply IDs/edges only. Never follow provider paging URLs containing tokens.
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.includes('..') || !['graph.facebook.com', 'graph.instagram.com', 'rupload.facebook.com'].includes(host)) throw fail('Invalid Meta request.');
  const versioned = ['graph.facebook.com', 'graph.instagram.com'].includes(host);
  const url = new URL(`https://${host}/${versioned ? config().version + '/' : ''}${path}`);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const values = { ...params };
  const proofSecret = host === 'graph.instagram.com' ? config().instagramSecret : config().secret;
  if (token && proofSecret && host !== 'rupload.facebook.com') values.appsecret_proof = crypto.createHmac('sha256', proofSecret).update(token).digest('hex');
  const body = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== '') body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value)); });
  if (method === 'GET') url.search = body.toString();
  else headers['Content-Type'] = 'application/x-www-form-urlencoded';
  let response;
  try { response = await fetch(url, { method, headers, ...(method === 'GET' ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw Object.assign(fail(method === 'GET' ? 'Meta is temporarily unreachable.' : 'Meta did not confirm the request. Check the account before sending again.', 400), { ambiguous: method !== 'GET' }); }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) throw apiError(response, data, method !== 'GET');
  if (!data) throw Object.assign(fail('Meta returned an unreadable response.'), { ambiguous: method !== 'GET' });
  return data;
}
async function uploadReel(videoId, videoUrl, token) {
  if (!/^\d+$/.test(videoId)) throw fail('Invalid reel identifier.');
  let response;
  try {
    response = await fetch(`https://rupload.facebook.com/video-upload/${config().version}/${videoId}`, {
      method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch { throw fail('The video upload was not confirmed. Check the publishing history.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) throw apiError(response, data, true);
}
function capabilities(connection) {
  const has = permission => connection.permissions?.includes(permission);
  const direct = connection.authMethod === 'instagram';
  return {
    inbox: has(connection.provider === 'instagram' ? (direct ? 'instagram_business_manage_messages' : 'instagram_manage_messages') : 'pages_messaging'),
    publish: has(connection.provider === 'instagram' ? (direct ? 'instagram_business_content_publish' : 'instagram_content_publish') : 'pages_manage_posts'),
    comments: connection.provider === 'instagram' ? has(direct ? 'instagram_business_manage_comments' : 'instagram_manage_comments') : has('pages_read_engagement'),
  };
}
function replyAllowed(thread, now = Date.now()) {
  // Comment events are useful context, but this module does not pretend that a
  // Messenger text send is a comment reply. Continue those threads on Meta.
  if (thread.contextType === 'comment') return false;
  const date = new Date(thread.lastInboundAt || 0).getTime();
  return date > 0 && date <= now && now - date < 24 * 60 * 60 * 1000;
}
module.exports = { SCOPES, INSTAGRAM_SCOPES, config, fail, hash, equal, verifySignature, signedRequest, request, uploadReel, capabilities, replyAllowed };
