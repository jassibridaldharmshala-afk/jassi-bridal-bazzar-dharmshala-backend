const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertProductionSecrets,
  getJwtRefreshSecret,
  getJwtSecret,
  isDemoOtpMode,
  missingProductionSecrets,
  productionConfigurationIssues,
} = require('../config/env');

function withEnv(overrides, work) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production refuses to start when JWT secrets or MONGO_URI are missing', () => {
  withEnv({
    NODE_ENV: 'production',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
    MONGO_URI: undefined,
  }, () => {
    assert.deepEqual(missingProductionSecrets().sort(), ['JWT_REFRESH_SECRET', 'JWT_SECRET', 'MONGO_URI']);
    assert.throws(() => assertProductionSecrets(), /JWT_SECRET/);
  });
});

test('production JWT helpers refuse to fall back to a development secret', () => {
  withEnv({
    NODE_ENV: 'production',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
  }, () => {
    assert.throws(() => getJwtSecret(), /JWT_SECRET is required in production/);
    assert.throws(() => getJwtRefreshSecret(), /JWT_REFRESH_SECRET is required in production/);
  });
});

test('development may fall back to a local-only JWT secret', () => {
  withEnv({
    NODE_ENV: 'development',
    JWT_SECRET: undefined,
    JWT_REFRESH_SECRET: undefined,
  }, () => {
    assert.match(getJwtSecret(), /dev_only/);
    assert.match(getJwtRefreshSecret(), /dev_only/);
  });
});

test('strict production validation rejects weak secrets and incomplete required providers', () => {
  withEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'change_before_production',
    JWT_REFRESH_SECRET: 'change_before_production',
    MONGO_URI: 'mongodb://example.invalid/store',
    REQUIRE_MEDIA_STORAGE: 'true',
    REQUIRE_REDIS: 'true',
    PAYMENTS_ENABLED: 'true',
    R2_ACCOUNT_ID: undefined,
    CLOUDINARY_CLOUD_NAME: undefined,
    REDIS_URL: undefined,
    RAZORPAY_KEY_ID: undefined,
    RAZORPAY_KEY_SECRET: undefined,
    RAZORPAY_WEBHOOK_SECRET: undefined,
  }, () => {
    const issues = productionConfigurationIssues();
    assert.ok(issues.some((item) => item.includes('JWT_SECRET')));
    assert.ok(issues.some((item) => item.includes('different')));
    assert.ok(issues.some((item) => item.includes('media storage')));
    assert.ok(issues.some((item) => item.includes('REDIS_URL')));
    assert.ok(issues.some((item) => item.includes('Razorpay')));
  });
});

test('OTP_MODE=demo is the default and is distinct from production mode', () => {
  withEnv({ OTP_MODE: undefined }, () => {
    assert.equal(isDemoOtpMode(), true);
  });
  withEnv({ OTP_MODE: 'production' }, () => {
    assert.equal(isDemoOtpMode(), false);
  });
});

test('server keeps local owner demo loopback-only and hosted operation public', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const keys = ['LOCAL_OWNER_DEMO', 'OTP_MODE', 'PORT', 'SERVER_PORT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => keys.forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }));
  for (const [localDemo, mode, production, host] of [
    ['true', 'demo', false, '127.0.0.1'],
    ['true', 'demo', true, '0.0.0.0'],
    ['false', 'demo', true, '0.0.0.0'],
    ['true', 'production', false, '0.0.0.0'],
  ]) {
    Object.assign(process.env, { LOCAL_OWNER_DEMO: localDemo, OTP_MODE: mode, PORT: '10000', SERVER_PORT: '5000' });
    const listening = await new Promise((resolve, reject) => {
      const app = { locals: {}, listen(port, address, callback) { callback(); resolve({ port, address, local: app.locals.localOwnerDemo }); } };
      const dependencies = {
        dotenv: { config() {} }, path, './app': app, './config/db': async () => {},
        './services/r2Upload': { isR2Configured: () => true },
        './services/cloudinaryUpload': { isCloudinaryConfigured: () => false },
        './config/env': { assertProductionSecrets() {}, getOtpMode: () => mode, isProduction: () => production },
        './config/localOwnerDemo': require('../config/localOwnerDemo'),
        mongoose: { connection: { readyState: 0 } },
        './queues/reelImport.queue': {}, './services/reelImportProgress.service': {},
      };
      vm.runInNewContext(source, {
        __dirname: path.join(__dirname, '..'), console: { log() {}, warn() {}, error: reject },
        process: { env: process.env, on() {}, exit: () => reject(new Error('Unexpected server exit')) },
        require: name => { if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; },
      });
    });
    assert.equal(listening.port, '10000');
    assert.equal(listening.address, host);
    assert.equal(listening.local, host === '127.0.0.1');
  }
});
