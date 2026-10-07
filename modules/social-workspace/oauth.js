const crypto = require('crypto');
const { OAuth, Connection, Thread, Message, Post, Deletion } = require('./models');
const { encryptSecret, decryptSecret } = require('../../utils/secretBox');
const meta = require('./meta');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const cookieName = 'samira_social_oauth';
const random = () => crypto.randomBytes(32).toString('hex');
function cookieOptions(provider = 'facebook') { const callback = provider === 'instagram' ? meta.config().instagramCallback : meta.config().callback; return { httpOnly: true, secure: callback.startsWith('https:'), sameSite: 'lax', path: '/api/social/oauth', maxAge: 10 * 60000 }; }
function callbackBase(provider = 'facebook') { return (provider === 'instagram' ? meta.config().instagramCallback : meta.config().callback).replace(/\/callback$/, ''); }
function requireConfig(provider = 'facebook') {
  const c = meta.config();
  const appId = provider === 'instagram' ? c.instagramAppId : c.appId;
  const secret = provider === 'instagram' ? c.instagramSecret : c.secret;
  const callback = provider === 'instagram' ? c.instagramCallback : c.callback;
  if (!appId || !secret || !callback || !c.verifyToken) throw meta.fail(`Connect the ${provider === 'instagram' ? 'Instagram' : 'Meta'} developer app in server settings first.`, 400, 'META_NOT_CONFIGURED');
  const url = new URL(callback);
  const expected = provider === 'instagram' ? '/api/social/oauth/instagram/callback' : '/api/social/oauth/callback';
  if (url.pathname !== expected || (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol !== 'https:')) throw meta.fail(`The ${provider} redirect URI must use HTTPS and end with ${expected}.`);
}
async function start(req, res) {
  const provider = req.body.provider === 'instagram' ? 'instagram' : 'facebook';
  requireConfig(provider);
  const state = random(), ticket = random();
  await OAuth.create({ storeId: req.socialStore._id, userId: req.user._id, workspace: req.socialWorkspace, loginProvider: provider, stateHash: meta.hash(state), ticketHash: meta.hash(ticket), nonceHash: '', expiresAt: new Date(Date.now() + 10 * 60000) });
  // Top-level navigation sets a first-party cookie even when API and web origins differ.
  res.json({ url: `${callbackBase(provider)}/start?ticket=${ticket}&state=${state}` });
}
async function navigateFor(req, res, provider) {
  requireConfig(provider);
  const nonce = random();
  const session = await OAuth.findOneAndUpdate({ ticketHash: meta.hash(req.query.ticket), stateHash: meta.hash(req.query.state), phase: 'created', expiresAt: { $gt: new Date() } }, { $set: { phase: 'authorizing', nonceHash: meta.hash(nonce) }, $unset: { ticketHash: 1 } });
  if (!session || session.loginProvider !== provider) throw meta.fail('This connection link expired. Start again from Accounts.');
  res.cookie(cookieName, nonce, cookieOptions(provider));
  const c = meta.config();
  const query = new URLSearchParams({ client_id: provider === 'instagram' ? c.instagramAppId : c.appId, redirect_uri: provider === 'instagram' ? c.instagramCallback : c.callback, state: String(req.query.state), response_type: 'code', scope: (provider === 'instagram' ? meta.INSTAGRAM_SCOPES : meta.SCOPES).join(',') });
  if (provider === 'facebook') query.set('auth_type', 'rerequest');
  res.set('Referrer-Policy', 'no-referrer').redirect(provider === 'instagram' ? `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&${query}` : `https://www.facebook.com/${c.version}/dialog/oauth?${query}`);
}
const navigate = (req, res) => navigateFor(req, res, 'facebook');
const navigateInstagram = (req, res) => navigateFor(req, res, 'instagram');
async function instagramToken(code) {
  const c = meta.config();
  const body = new URLSearchParams({ client_id: c.instagramAppId, client_secret: c.instagramSecret, grant_type: 'authorization_code', redirect_uri: c.instagramCallback, code: String(code) });
  const shortResponse = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const short = await shortResponse.json().catch(() => null);
  if (!shortResponse.ok || !short?.access_token) throw meta.fail('Instagram did not approve this connection.');
  const url = new URL('https://graph.instagram.com/access_token');
  url.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.instagramSecret, access_token: short.access_token });
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  const long = await response.json().catch(() => null);
  if (!response.ok || !long?.access_token) throw meta.fail('Instagram did not return a long-lived access token.');
  return { ...long, userId: String(short.user_id || '') };
}
async function callbackFor(req, res, provider) {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const session = cookie && await OAuth.findOneAndUpdate({ stateHash: meta.hash(req.query.state), nonceHash: meta.hash(cookie), phase: 'authorizing', expiresAt: { $gt: new Date() } }, { $set: { phase: 'exchanging' }, $unset: { nonceHash: 1 } }, { new: true });
  const { maxAge, ...clearOptions } = cookieOptions(provider);
  res.clearCookie(cookieName, clearOptions);
  if (!session || session.loginProvider !== provider) return res.status(400).type('text').send('Connection expired or could not be verified. Return to Social studio and connect again.');
  const destination = `${meta.config().frontend}/${session.workspace}/social?storeId=${session.storeId}`;
  if (req.query.error || !req.query.code) { await session.deleteOne(); return res.redirect(destination + '&socialError=cancelled'); }
  try {
    const c = meta.config();
    if (provider === 'instagram') {
      const long = await instagramToken(req.query.code);
      const identity = await meta.request('me', { host: 'graph.instagram.com', token: long.access_token, params: { fields: 'user_id,username,name' } });
      const accountId = String(identity.user_id || identity.id || long.userId);
      if (!accountId) throw meta.fail('Instagram did not return an account identity.');
      const pages = [{ id: accountId, name: identity.name || identity.username || 'Instagram account', access_token: long.access_token, instagram_business_account: { id: accountId, username: identity.username, name: identity.name }, directInstagram: true }];
      session.encryptedAccounts = encryptSecret(JSON.stringify({ pages, permissions: meta.INSTAGRAM_SCOPES, facebookUserId: '', expiresAt: new Date(Date.now() + Number(long.expires_in || 5184000) * 1000), authMethod: 'instagram' }));
      session.phase = 'ready'; session.expiresAt = new Date(Date.now() + 10 * 60000); await session.save();
      return res.redirect(destination + '&connectionSession=' + session._id);
    }
    const short = await meta.request('oauth/access_token', { params: { client_id: c.appId, client_secret: c.secret, redirect_uri: c.callback, code: req.query.code } });
    const long = await meta.request('oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.secret, fb_exchange_token: short.access_token } });
    if (!long.access_token) throw meta.fail('Meta did not return an access token.');
    const identity = await meta.request('me', { token: long.access_token, params: { fields: 'id' } });
    const grant = await meta.request('me/permissions', { token: long.access_token });
    const permissions = (grant.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    if (!permissions.includes('pages_show_list')) throw meta.fail('Page access was not granted.');
    const pages = []; let after;
    for (let i = 0; i < 10; i++) {
      const result = await meta.request('me/accounts', { token: long.access_token, params: { fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}', limit: 100, after } });
      pages.push(...(result.data || []).filter(p => p.id && p.access_token));
      after = result.paging?.next && result.paging?.cursors?.after;
      if (!after) break;
    }
    session.encryptedAccounts = encryptSecret(JSON.stringify({ pages, permissions, facebookUserId: identity.id, expiresAt: new Date(Date.now() + Number(long.expires_in || 5184000) * 1000) }));
    session.facebookUserId = identity.id; session.phase = 'ready'; session.expiresAt = new Date(Date.now() + 10 * 60000); await session.save();
    return res.redirect(destination + '&connectionSession=' + session._id);
  } catch {
    await session.deleteOne(); return res.redirect(destination + '&socialError=connection');
  }
}
const callback = (req, res) => callbackFor(req, res, 'facebook');
const callbackInstagram = (req, res) => callbackFor(req, res, 'instagram');
async function pending(req, res) {
  const session = await OAuth.findOne({ _id: req.params.id, storeId: req.socialStore._id, userId: req.user._id, phase: 'ready', expiresAt: { $gt: new Date() } }).select('+encryptedAccounts');
  if (!session) throw meta.fail('Account selection expired. Connect again.', 404);
  const { pages, permissions } = JSON.parse(decryptSecret(session.encryptedAccounts));
  res.json({ provider: session.loginProvider, pages: pages.map(p => ({ id: p.id, name: p.name, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null })), missingPermissions: (session.loginProvider === 'instagram' ? meta.INSTAGRAM_SCOPES : meta.SCOPES).filter(p => !permissions.includes(p)) });
}
async function activate(req, res) {
  const pageIds = [...new Set(Array.isArray(req.body.pageIds) ? req.body.pageIds.map(String) : [])];
  if (!pageIds.length || pageIds.length > 20) throw meta.fail('Choose between 1 and 20 accounts.');
  const session = await OAuth.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, userId: req.user._id, phase: 'ready', expiresAt: { $gt: new Date() } }, { $set: { phase: 'activating' } }, { new: true }).select('+encryptedAccounts');
  if (!session) throw meta.fail('Account selection expired or is already connecting.', 409);
  const payload = JSON.parse(decryptSecret(session.encryptedAccounts));
  const results = [];
  try {
    for (const id of pageIds) {
      const page = payload.pages.find(p => p.id === id);
      if (!page) throw meta.fail('Choose a Page returned by your Meta login.');
      const directInstagram = payload.authMethod === 'instagram' || page.directInstagram;
      const accounts = directInstagram
        ? [{ provider: 'instagram', accountId: id, name: page.name, username: page.instagram_business_account?.username, authMethod: 'instagram', apiHost: 'graph.instagram.com' }]
        : [{ provider: 'facebook', accountId: id, name: page.name, authMethod: 'facebook', apiHost: 'graph.facebook.com' }];
      if (!directInstagram && page.instagram_business_account && payload.permissions.includes('instagram_basic')) accounts.push({ provider: 'instagram', accountId: page.instagram_business_account.id, name: page.instagram_business_account.name || page.instagram_business_account.username, username: page.instagram_business_account.username, authMethod: 'facebook', apiHost: 'graph.facebook.com' });
      const conflict = await Connection.exists({ $or: accounts.map(a => ({ provider: a.provider, accountId: a.accountId })), storeId: { $ne: session.storeId } });
      if (conflict) throw meta.fail('One of these accounts already belongs to another store. Disconnect it there first.', 409);
      const host = directInstagram ? 'graph.instagram.com' : 'graph.facebook.com';
      await meta.request(id, { host, token: page.access_token, params: { fields: directInstagram ? 'user_id,username' : 'id' } });
      let subscribed = false;
      try { subscribed = Boolean((await meta.request(`${id}/subscribed_apps`, { host, token: page.access_token, method: 'POST', params: { subscribed_fields: directInstagram ? 'messages,messaging_postbacks,message_reactions,comments' : 'messages,messaging_postbacks,message_reads,message_deliveries,message_reactions,feed' } })).success); } catch { /* Inbox remains available through explicit sync; surface webhook issue. */ }
      for (const account of accounts) {
        const saved = await Connection.findOneAndUpdate({ provider: account.provider, accountId: account.accountId, storeId: session.storeId }, { $set: { ...account, storeId: session.storeId, pageId: id, token: encryptSecret(page.access_token), permissions: payload.permissions, facebookUserId: payload.facebookUserId, expiresAt: payload.expiresAt, status: 'connected', subscribed, lastHealthCheckAt: new Date(), nextHealthCheckAt: new Date(Date.now() + 6 * 3600000), lastError: subscribed ? '' : 'Live updates could not be enabled. Check webhook permissions; use Sync inbox meanwhile.' } }, { new: true, upsert: true });
        results.push(saved._id);
      }
    }
    await session.deleteOne(); res.json({ connected: results });
  } catch (error) { session.phase = 'ready'; await session.save(); throw error; }
}
async function purgeAccount(account) {
  await Connection.deleteOne({ _id: account._id });
  await Message.deleteMany({ connectionId: account._id }); await Thread.deleteMany({ connectionId: account._id });
  await Post.updateMany({ storeId: account.storeId, 'targets.connectionId': account._id }, { $set: { 'targets.$[target].status': 'disconnected', 'targets.$[target].error': 'Account disconnected.' }, $inc: { __v: 1 } }, { arrayFilters: [{ 'target.connectionId': account._id, 'target.status': { $nin: ['published'] } }] });
}
async function disconnect(req, res) {
  const account = await Connection.findOne({ _id: req.params.id, storeId: req.socialStore._id }).select('+token');
  if (!account) throw meta.fail('Account not found.', 404);
  // A Page subscription serves its linked Instagram too. Only remove it for the last local account.
  const sibling = await Connection.exists({ pageId: account.pageId, _id: { $ne: account._id } });
  if (!sibling) await meta.request(`${account.pageId}/subscribed_apps`, { host: account.apiHost, token: decryptSecret(account.token), method: 'DELETE' }).catch(() => {});
  await purgeAccount(account); res.json({ success: true });
}
async function deauthorize(req, res) {
  const data = meta.signedRequest(req.body.signed_request);
  for (const account of await Connection.find({ $or: [{ facebookUserId: String(data.user_id) }, { provider: 'instagram', authMethod: 'instagram', accountId: String(data.user_id) }] })) await purgeAccount(account);
  await OAuth.deleteMany({ facebookUserId: String(data.user_id) });
  const code = crypto.createHmac('sha256', meta.config().secret || meta.config().instagramSecret).update('deleted:' + data.user_id).digest('hex');
  await Deletion.updateOne({ code }, { $set: { expiresAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true });
  const publicApi = String(process.env.PUBLIC_API_URL || meta.config().callback || meta.config().instagramCallback).replace(/\/api\/social\/oauth(?:\/instagram)?\/callback$/, '').replace(/\/$/, '');
  res.json({ url: publicApi + '/api/social/deletion-status/' + code, confirmation_code: code });
}
async function deletionStatus(req, res) {
  const found = /^[a-f0-9]{64}$/.test(req.params.code) && await Deletion.exists({ code: req.params.code, expiresAt: { $gt: new Date() } });
  return found ? res.type('text').send('The requested connected-account data has been removed from Social studio.') : res.sendStatus(404);
}
module.exports = { wrap, start, navigate, navigateInstagram, callback, callbackInstagram, pending, activate, disconnect, deauthorize, deletionStatus };
