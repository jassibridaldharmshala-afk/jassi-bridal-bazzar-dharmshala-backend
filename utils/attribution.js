const ALLOWED_SOURCES = ['instagram', 'facebook', 'youtube', 'whatsapp', 'direct', 'search', 'referral', 'email'];

function readAttribution(body = {}) {
  const source = String(body.source || body.utm_source || '').trim().toLowerCase().slice(0, 80);
  const campaign = String(body.campaign || body.utm_campaign || '').trim().slice(0, 80);
  const reelId = String(body.reelId || body.reel || '').trim().slice(0, 80);
  const capturedAt = body.capturedAt ? new Date(Number(body.capturedAt) || body.capturedAt) : null;
  const expiresAt = body.expiresAt ? new Date(Number(body.expiresAt) || body.expiresAt) : null;
  const attribution = {};
  if (source) attribution.source = ALLOWED_SOURCES.includes(source) ? source : source.replace(/[^a-z0-9_-]/g, '').slice(0, 80);
  if (campaign) attribution.campaign = campaign.replace(/[^\w\s-]/g, '').slice(0, 80);
  if (reelId) attribution.reelId = reelId.replace(/[^\w-]/g, '').slice(0, 80);
  if (capturedAt && !Number.isNaN(capturedAt.getTime()) && capturedAt <= new Date()) attribution.capturedAt = capturedAt;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && (!capturedAt || expiresAt > capturedAt)) attribution.expiresAt = expiresAt;
  if (attribution.expiresAt && attribution.expiresAt <= new Date()) {
    delete attribution.campaign;
    delete attribution.reelId;
  }
  return Object.keys(attribution).length ? attribution : undefined;
}

module.exports = { ALLOWED_SOURCES, readAttribution };
