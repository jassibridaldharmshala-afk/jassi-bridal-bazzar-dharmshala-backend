const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEffectivePricing, effectiveUnitPrice, productAvailableForSale, scheduledSaleActive } = require('../services/productPricingService');

test('scheduled product sale activates only inside its configured window', () => {
  const product = { price: 1000, originalPrice: 1400, salePrice: 800, saleStartAt: '2030-01-01T00:00:00.000Z', saleEndAt: '2030-01-03T00:00:00.000Z' };
  assert.equal(scheduledSaleActive(product, new Date('2029-12-31T23:59:59.000Z')), false);
  assert.equal(scheduledSaleActive(product, new Date('2030-01-02T00:00:00.000Z')), true);
  assert.equal(scheduledSaleActive(product, new Date('2030-01-03T00:00:00.000Z')), false);
  assert.equal(effectiveUnitPrice(product, { price: 1250 }, new Date('2030-01-02T00:00:00.000Z')), 1000);
  const publicProduct = applyEffectivePricing({ ...product, variants: [{ price: 1250 }] }, new Date('2030-01-02T00:00:00.000Z'));
  assert.equal(publicProduct.basePrice, 1000);
  assert.equal(publicProduct.price, 800);
  assert.equal(publicProduct.variants[0].basePrice, 1250);
  assert.equal(publicProduct.variants[0].price, 1000);
});

test('future-published products cannot be purchased early', () => {
  assert.equal(productAvailableForSale({ isActive: true, publishAt: '2030-01-01T00:00:00.000Z' }, new Date('2029-12-31T00:00:00.000Z')), false);
  assert.equal(productAvailableForSale({ isActive: true, publishAt: '2030-01-01T00:00:00.000Z' }, new Date('2030-01-01T00:00:00.000Z')), true);
  assert.equal(productAvailableForSale({ isActive: false }), false);
});
