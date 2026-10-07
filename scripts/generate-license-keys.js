const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const values = {
  LICENSE_SIGNING_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  LICENSE_SIGNING_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  PLATFORM_CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
};

process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
