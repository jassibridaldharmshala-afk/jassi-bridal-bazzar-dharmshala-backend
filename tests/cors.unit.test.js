const test = require('node:test');
const assert = require('node:assert/strict');
const { corsOptions } = require('../config/corsOptions');

function optionsFor(origin) {
  let result;
  corsOptions({ header: () => origin }, (error, options) => {
    assert.equal(error, null);
    result = options;
  });
  return result;
}

test('bridal storefront origin can make credentialed API requests', () => {
  const options = optionsFor('https://jassi-bridal-bazzar-dharmshalas.onrender.com');
  assert.equal(options.origin, true);
  assert.equal(options.credentials, true);
  assert.ok(options.methods.includes('OPTIONS'));
  assert.ok(options.allowedHeaders.includes('Authorization'));
});

test('an unrelated origin remains blocked', () => {
  assert.equal(optionsFor('https://unrelated.example').origin, false);
});
