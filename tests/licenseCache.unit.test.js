const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('a cached licence for another installation does not block fresh validation', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const makeEnvelope = (installationId) => {
    const payload = Buffer.from(JSON.stringify({
      installationId,
      status: 'ACTIVE',
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      graceUntil: new Date(Date.now() + 120_000).toISOString(),
    })).toString('base64url');
    return {
      algorithm: 'Ed25519', payload,
      signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url'),
    };
  };
  const previous = {};
  const settings = {
    CONTROL_PLANE_URL: 'https://example.invalid',
    CLIENT_INSTALLATION_ID: 'current-installation',
    CLIENT_LICENSE_KEY: 'test-key',
    LICENSE_SIGNING_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  for (const [key, value] of Object.entries(settings)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const staleEnvelope = makeEnvelope('previous-installation');
  const currentEnvelope = makeEnvelope('current-installation');
  const modelPath = require.resolve('../models/RuntimeLicense');
  const originalModel = require.cache[modelPath];
  require.cache[modelPath] = {
    id: modelPath, filename: modelPath, loaded: true,
    exports: {
      findOne: () => ({ lean: async () => staleEnvelope }),
      findOneAndUpdate: async () => ({}),
    },
  };
  t.after(() => {
    if (originalModel) require.cache[modelPath] = originalModel;
    else delete require.cache[modelPath];
  });
  const { licenseStatus } = require('../services/controlPlaneClient');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://example.invalid/api/platform/validate');
    requests += 1;
    return { ok: true, json: async () => currentEnvelope };
  });

  const status = await licenseStatus();
  assert.equal(status.source, 'platform');
  assert.equal(status.installationId, 'current-installation');
  assert.equal(requests, 1);
});
