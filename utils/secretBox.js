const crypto = require('crypto');
const { getJwtSecret } = require('../config/env');

function key(value = process.env.DATA_ENCRYPTION_KEY || getJwtSecret()) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function legacyKey() {
  return crypto.createHash('sha256').update(getJwtSecret()).digest();
}

function encryptSecret(plain) {
  const text = String(plain || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(payload) {
  const parts = String(payload || '').split(':');
  const versioned = parts[0] === 'v2';
  const [ivHex, tagHex, dataHex] = versioned ? parts.slice(1) : parts;
  if (!ivHex || !tagHex || !dataHex) return '';
  const candidates = versioned
    ? [process.env.DATA_ENCRYPTION_KEY || getJwtSecret(), ...String(process.env.DATA_ENCRYPTION_PREVIOUS_KEYS || '').split(',').map(value => value.trim()).filter(Boolean)].map(key)
    : [legacyKey()];
  let lastError;
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidate, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Encrypted value could not be read.');
}

module.exports = { decryptSecret, encryptSecret };
