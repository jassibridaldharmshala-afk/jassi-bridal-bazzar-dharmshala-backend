const jwt = require('jsonwebtoken');
const InstagramConnection = require('../models/InstagramConnection');
const { asyncHandler } = require('../middleware/validate');
const { getJwtSecret } = require('../config/env');
const { encryptSecret, decryptSecret } = require('../utils/secretBox');

const GRAPH_VERSION = 'v21.0';

function configured() {
  return Boolean(String(process.env.INSTAGRAM_APP_ID || '').trim() && String(process.env.INSTAGRAM_APP_SECRET || '').trim());
}

function redirectUri() {
  const explicit = String(process.env.INSTAGRAM_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const api = String(process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  if (api) return `${api}/api/instagram/oauth/callback`;
  return '';
}

function frontendInstagramUrl(query = '') {
  const origin = String(process.env.FRONTEND_URL || process.env.PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${origin}/seller/instagram${query}`;
}

function publicView(doc) {
  return {
    status: doc?.status || 'DISCONNECTED',
    username: doc?.username || '',
    connectedAt: doc?.connectedAt || null,
    lastError: doc?.lastError || '',
    configured: configured(),
    messagingEnabled: false,
    note: configured()
      ? 'Connect with the official Instagram Graph API. Direct messaging is not simulated.'
      : 'Instagram is not connected. Official API credentials are required before a live link can be added.',
  };
}

async function upsertConnection(storeId, update) {
  return InstagramConnection.findOneAndUpdate(
    { storeId },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

exports.status = asyncHandler(async (req, res) => {
  const doc = await InstagramConnection.findOne({ storeId: req.store._id });
  res.json(publicView(doc));
});

exports.connectUrl = asyncHandler(async (req, res) => {
  if (!configured() || !redirectUri()) {
    return res.json({
      configured: false,
      authUrl: null,
      note: 'Instagram OAuth is not configured. Set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, and INSTAGRAM_REDIRECT_URI. The store stays disconnected until a real Graph API token exchange succeeds.',
    });
  }

  const state = jwt.sign(
    { storeId: String(req.store._id), purpose: 'instagram-oauth' },
    getJwtSecret(),
    { expiresIn: '10m' },
  );
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', String(process.env.INSTAGRAM_APP_ID).trim());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'instagram_basic,pages_show_list');

  res.json({
    configured: true,
    authUrl: url.toString(),
    note: 'This opens Facebook Login for Instagram Graph API. The store is marked connected only after a real token is returned.',
  });
});

/**
 * Public OAuth callback. CONNECTED is set only after Graph returns an access token.
 * Failures are stored as ERROR and never pretended to be a live Instagram session.
 */
exports.oauthCallback = asyncHandler(async (req, res) => {
  const fail = async (storeId, message) => {
    if (storeId) {
      await upsertConnection(storeId, {
        status: 'ERROR',
        lastError: message,
      });
    }
    res.redirect(frontendInstagramUrl('?ig=error'));
  };

  const code = String(req.query.code || '').trim();
  const stateToken = String(req.query.state || '').trim();
  if (!configured()) return fail(null, 'Instagram API credentials are not configured.');
  if (!code || !stateToken) return fail(null, 'OAuth callback is missing code or state.');

  let storeId = '';
  try {
    const decoded = jwt.verify(stateToken, getJwtSecret());
    if (decoded.purpose !== 'instagram-oauth' || !decoded.storeId) {
      return fail(null, 'OAuth state is invalid.');
    }
    storeId = decoded.storeId;
  } catch {
    return fail(null, 'OAuth state expired or is invalid.');
  }

  const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  tokenUrl.searchParams.set('client_id', String(process.env.INSTAGRAM_APP_ID).trim());
  tokenUrl.searchParams.set('client_secret', String(process.env.INSTAGRAM_APP_SECRET).trim());
  tokenUrl.searchParams.set('redirect_uri', redirectUri());
  tokenUrl.searchParams.set('code', code);

  let tokenBody;
  try {
    const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
    tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody.access_token) {
      return fail(storeId, tokenBody.error?.message || 'Instagram did not return an access token.');
    }
  } catch {
    return fail(storeId, 'Could not reach Instagram to exchange the OAuth code.');
  }

  let username = '';
  let accountId = '';
  try {
    const profileUrl = new URL('https://graph.instagram.com/me');
    profileUrl.searchParams.set('fields', 'id,username');
    profileUrl.searchParams.set('access_token', tokenBody.access_token);
    const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(8000) });
    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      username = String(profile.username || '').trim();
      accountId = String(profile.id || '').trim();
    }
  } catch {
    // Username is optional; a real access token is enough to mark connected.
  }

  await upsertConnection(storeId, {
    status: 'CONNECTED',
    username,
    accountId,
    encryptedAccessToken: encryptSecret(tokenBody.access_token),
    tokenExpiresAt: tokenBody.expires_in
      ? new Date(Date.now() + Number(tokenBody.expires_in) * 1000)
      : undefined,
    connectedAt: new Date(),
    lastError: '',
  });

  res.redirect(frontendInstagramUrl('?ig=connected'));
});

exports.media = asyncHandler(async (req, res) => {
  const doc = await InstagramConnection.findOne({ storeId: req.store._id }).select('+encryptedAccessToken');
  if (!doc || doc.status !== 'CONNECTED' || !doc.encryptedAccessToken) {
    return res.json({
      items: [],
      note: 'Instagram is not connected. Complete the official OAuth handshake before media can be listed. Direct messaging is not enabled.',
    });
  }

  try {
    const token = decryptSecret(doc.encryptedAccessToken);
    const url = new URL('https://graph.instagram.com/me/media');
    url.searchParams.set('fields', 'id,caption,media_type,permalink,timestamp');
    url.searchParams.set('access_token', token);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.json({
        items: [],
        note: 'Instagram media could not be loaded from Graph API. Direct messaging is not enabled.',
      });
    }
    const body = await response.json();
    return res.json({
      items: Array.isArray(body.data) ? body.data : [],
      messagingEnabled: false,
      note: 'Direct Instagram messaging is not enabled in this build.',
    });
  } catch {
    return res.json({
      items: [],
      note: 'Instagram media could not be loaded from Graph API.',
    });
  }
});

/**
 * Structure-only save. Tokens are encrypted at rest and never returned.
 * Without INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET the connection stays
 * disconnected — this endpoint does not pretend a live Instagram session exists.
 */
exports.saveStub = asyncHandler(async (req, res) => {
  if (!configured()) {
    const doc = await upsertConnection(req.store._id, {
      status: 'DISCONNECTED',
      lastError: 'Official Instagram API credentials are not configured on the server.',
      encryptedAccessToken: req.body?.accessToken ? encryptSecret(req.body.accessToken) : undefined,
    });
    return res.json(publicView(doc));
  }

  const doc = await upsertConnection(req.store._id, {
    status: 'PENDING',
    username: String(req.body?.username || '').trim(),
    lastError: 'Complete the official OAuth handshake to finish connecting.',
    encryptedAccessToken: req.body?.accessToken ? encryptSecret(req.body.accessToken) : undefined,
  });
  res.json(publicView(doc));
});
