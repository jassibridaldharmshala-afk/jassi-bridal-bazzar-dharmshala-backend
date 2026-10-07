const test = require('node:test');
const assert = require('node:assert/strict');

const { corsOptions } = require('../config/corsOptions');

const storefrontOrigin = 'https://jassi-bridal-bazzar-dharmshalas.onrender.com';

test('bridal storefront origin is accepted without trusting other Render services', () => {
  const optionsFor = (origin) => {
    let options;
    corsOptions({ header: (name) => name === 'Origin' ? origin : undefined }, (_error, value) => { options = value; });
    return options;
  };

  const accepted = optionsFor(storefrontOrigin);
  assert.equal(accepted.origin, true);
  assert.equal(accepted.credentials, true);
  assert.ok(accepted.methods.includes('OPTIONS'));
  assert.ok(accepted.allowedHeaders.includes('x-store-slug'));
  assert.equal(optionsFor('https://untrusted-client.onrender.com').origin, false);
});
