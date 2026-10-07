// Audit data is deliberately smaller than a database document. Never pass a
// request body, headers, credentials or payment instruments to the audit trail.
const PRIVATE_KEY = /password|passwd|otp|token|secret|authorization|cookie|signature|credential|privatekey|apikey|keysecret|accountsid|authkey|session|email|phone|mobile|address|pincode|cardnumber|cardholder|cvv|cvc|bankaccount|iban|aadhaar|pannumber/i;
const PRIVATE_ACTION = /^(MASTER_|WEBSITE_|CLIENT_ADMIN_|ROLE_)/;
const PRIVATE_ENTITIES = ['MasterConfiguration', 'IndustryPreset', 'WebsiteTheme', 'WebsiteThemeVersion'];

function safeText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[parameters omitted]')
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/\b(?:AC|SK)[a-f0-9]{32}\b/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted email]')
    .replace(/(^|\s)\+?\d[\d -]{8,18}\d(?=\s|$)/g, '$1[redacted number]')
    .slice(0, max);
}

function sanitizeAudit(value) {
  const seen = new WeakSet();
  let nodes = 0;
  function visit(item, depth = 0) {
    if (item === undefined || item === null) return item;
    if (++nodes > 600 || depth > 8) return '[truncated]';
    if (typeof item === 'string') return safeText(item, 1000);
    if (typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item !== 'object') return '[omitted]';
    if (item instanceof Date) return Number.isNaN(item.getTime()) ? null : item.toISOString();
    if (typeof item.toHexString === 'function') return item.toHexString();
    if (Buffer.isBuffer(item)) return '[binary omitted]';
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (typeof item.toObject === 'function') item = item.toObject({ depopulate: true, flattenMaps: true });
    if (Array.isArray(item)) {
      const values = item.slice(0, 40).map((entry) => visit(entry, depth + 1));
      if (item.length > 40) values.push('[truncated]');
      return values;
    }
    const entries = item instanceof Map ? [...item.entries()] : Object.entries(item);
    const out = Object.create(null);
    for (const [rawKey, entry] of entries.slice(0, 80)) {
      const key = safeText(rawKey, 100);
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      out[key] = PRIVATE_KEY.test(key.replace(/[_\s-]/g, '')) ? '[redacted]' : visit(entry, depth + 1);
    }
    if (entries.length > 80) out._truncated = true;
    return out;
  }
  return visit(value);
}

function auditSnapshot(document, fields) {
  if (!document) return undefined;
  return sanitizeAudit(Object.fromEntries(fields.map((field) => [field, document[field]])));
}

function changedFields(before, after) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...fields].filter((key) => !['_id', '__v', 'createdAt', 'updatedAt'].includes(key)
    && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).slice(0, 80);
}

function isPrivateAudit({ action, entityType, path = '' }) {
  return PRIVATE_ACTION.test(action || '') || PRIVATE_ENTITIES.includes(entityType)
    || /^\/api\/(master(?:\/|$)|admin\/customization(?:\/|$))/i.test(path)
    || /\/(promote-admin|demote-admin)(?:\/|$)/i.test(path);
}

module.exports = { sanitizeAudit, safeText, auditSnapshot, changedFields, isPrivateAudit, PRIVATE_ACTION, PRIVATE_ENTITIES };
