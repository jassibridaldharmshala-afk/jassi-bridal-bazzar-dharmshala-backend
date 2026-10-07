const crypto = require('crypto');
const { ApiError } = require('../utils/apiError');

let developmentPair;

function readPrivateKey() {
  const configured = String(process.env.LICENSE_SIGNING_PRIVATE_KEY || '').trim();
  if (configured) {
    try { return crypto.createPrivateKey({ key: Buffer.from(configured, 'base64'), format: 'der', type: 'pkcs8' }); }
    catch { throw new ApiError('SERVICE_UNAVAILABLE', 'The platform licence signing key is invalid'); }
  }
  if (process.env.NODE_ENV === 'production') throw new ApiError('SERVICE_UNAVAILABLE', 'Platform licence signing is not configured');
  if (!developmentPair) developmentPair = crypto.generateKeyPairSync('ed25519');
  return developmentPair.privateKey;
}

function readPublicKey(value = process.env.LICENSE_SIGNING_PUBLIC_KEY) {
  const configured = String(value || '').trim();
  if (configured) {
    try { return crypto.createPublicKey({ key: Buffer.from(configured, 'base64'), format: 'der', type: 'spki' }); }
    catch { throw new ApiError('SERVICE_UNAVAILABLE', 'The platform licence verification key is invalid'); }
  }
  const privateKey = readPrivateKey();
  return crypto.createPublicKey(privateKey);
}

function publicKeyBase64() {
  return readPublicKey().export({ format: 'der', type: 'spki' }).toString('base64');
}

function signingReady() {
  try {
    const message = Buffer.from('samira-license-key-pair-check');
    return crypto.verify(null, message, readPublicKey(), crypto.sign(null, message, readPrivateKey()));
  } catch { return false; }
}

function signPayload(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payload), readPrivateKey()).toString('base64url');
  return { algorithm: 'Ed25519', payload, signature };
}

function verifyEnvelope(envelope, publicKey = process.env.LICENSE_SIGNING_PUBLIC_KEY) {
  if (!envelope?.payload || !envelope?.signature || envelope.algorithm !== 'Ed25519') return null;
  const valid = crypto.verify(
    null,
    Buffer.from(String(envelope.payload)),
    readPublicKey(publicKey),
    Buffer.from(String(envelope.signature), 'base64url'),
  );
  if (!valid) return null;
  try { return JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')); }
  catch { return null; }
}

module.exports = { publicKeyBase64, signPayload, signingReady, verifyEnvelope };
