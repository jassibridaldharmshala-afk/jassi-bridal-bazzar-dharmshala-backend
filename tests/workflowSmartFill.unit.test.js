const test = require('node:test');
const assert = require('node:assert/strict');
const { suggest, matchCategory, WORKFLOWS } = require('../services/workflowSmartFillAlgorithms');
const service = require('../services/workflowSmartFillService');
const values = result => Object.fromEntries(result.suggestions.map(row => [row.path, row.value]));
const run = (workflow, notes = '', current = {}, trusted = {}) => suggest({ workflow, notes, current, trusted });

test('category copy uses the scoped brand, safe slug and no invented claims', () => {
  const result = run('category', 'Category: Silver Earrings', {}, { brand: 'Nishaya Jewellery', categories: [{ name: 'Silver Earrings' }] });
  const fields = values(result);
  assert.equal(fields.slug, 'silver-earrings'); assert.match(fields.description, /Nishaya Jewellery/);
  assert.doesNotMatch(JSON.stringify(result), /Jassi|certified|925|pure silver/i);
  assert.match(result.warnings.join(' '), /duplication/);
  assert.equal(matchCategory('Silver Gold Earrings', [{ name: 'Silver Earrings' }, { name: 'Gold Earrings' }]), null);
});
test('conflicting labels are never silently picked and blank source never erases values', () => {
  const result = run('store', 'Brand: One\nBrand: Two\nEmail: broken');
  assert.equal(values(result).storeName, undefined); assert.equal(values(result).contactEmail, undefined);
  assert.match(result.warnings.join(' '), /conflicting/);
  assert.ok(!run('category', '', { name: 'Saved category' }).suggestions.some(row => row.value === ''));
});
test('oversized source identifiers and invalid dates are never silently truncated into valid values', () => {
  const store = run('store', 'GSTIN: 27AAPFU0939F1ZVEXTRA\nInvoice prefix: ' + 'X'.repeat(30));
  assert.equal(values(store).gstin, undefined); assert.equal(values(store).invoicePrefix, undefined);
  assert.match(store.warnings.join(' '), /not silently shortened/);
  const delivery = run('shipment', 'AWB: ' + 'X'.repeat(40) + '-EXTRA\nDelivery date: 2026-10-15-bad');
  assert.equal(values(delivery).trackingNumber, undefined); assert.equal(values(delivery).expectedDeliveryAt, undefined);
});
for (const workflow of ['banner', 'campaign']) test(workflow + ' maps real creative fields without guessing artwork or offers', () => {
  const result = run(workflow, 'Campaign: Festive campaign\nTitle: Festive Edit\nCTA: Shop\nLink: /products?collection=festive');
  const prefix = workflow === 'campaign' ? 'creative.' : '';
  const fields = values(result);
  assert.equal(fields[prefix + 'title'], 'Festive Edit'); assert.equal(fields[prefix + 'destinationType'], 'CUSTOM');
  assert.ok(result.suggestions.filter(row => [prefix + 'link', prefix + 'destinationType'].includes(row.path)).every(row => row.group === 'creative-destination'));
  assert.equal(values(run(workflow, 'Link: /products', workflow === 'campaign' ? { creative: { link: '/products', destinationType: 'CATEGORY' } } : { link: '/products', destinationType: 'CATEGORY' }))[prefix + 'destinationType'], 'CUSTOM');
  assert.equal(fields[prefix + 'altText'], undefined); assert.equal(fields.discountValue, undefined);
  assert.equal(fields.startsAt, undefined); assert.equal(fields.description, undefined);
  assert.equal(values(run(workflow, 'Title: Safe\nLink: //evil.example'))[prefix + 'link'], undefined);
});
test('coupon parses percentage, minimum, cap and audience as reviewed linked rules', () => {
  const result = run('coupon', 'New customers: 10%\nMinimum order: ₹1,000\nMaximum discount: ₹200\nCode: welcome10');
  const fields = values(result);
  assert.equal(fields.type, 'Percentage'); assert.equal(fields.discountValue, '10');
  assert.equal(fields.minOrderAmount, '1000'); assert.equal(fields.maxDiscountAmount, '200');
  assert.equal(fields.code, 'WELCOME10'); assert.equal(fields.customerSegment, 'NEW'); assert.equal(fields.benefitType, 'DISCOUNT');
  assert.ok(result.suggestions.filter(row => row.path !== 'title').every(row => row.attention));
  assert.equal(result.suggestions.find(row => row.path === 'discountValue').group, 'coupon-discount');
  assert.equal(fields.expiryDate, undefined); assert.equal(fields.usageLimit, undefined);
  assert.equal(values(run('coupon', '10%', { type: 'Percentage', discountValue: '10', benefitType: 'FREE_SHIPPING' })).benefitType, 'DISCOUNT');
});
test('coupon supports flat discounts, Indian grouping and free delivery without confusing the cap', () => {
  assert.equal(values(run('coupon', 'Flat ₹250 above ₹1,00,000; cap ₹300')).minOrderAmount, '100000');
  assert.equal(values(run('coupon', 'Flat ₹250 above ₹1000; cap ₹300')).discountValue, '250');
  assert.equal(values(run('coupon', 'Flat ₹250')).type, 'Flat');
  const fields = values(run('coupon', 'Free shipping above ₹1000'));
  assert.equal(fields.benefitType, 'FREE_SHIPPING'); assert.equal(fields.discountValue, undefined);
});
for (const notes of ['10% or 20%', '150%', 'Flat ₹25,50', 'Minimum order: 1000\nMinimum order: 2000']) test('ambiguous commercial numbers need manual review: ' + notes, () => {
  const result = run('coupon', notes);
  assert.match(result.warnings.join(' '), /ambiguous|outside/);
  if (notes.includes('%') || notes.includes('25,50')) assert.equal(values(result).discountValue, undefined);
  if (notes.includes('Minimum')) assert.equal(values(result).minOrderAmount, undefined);
});
test('courier receipt proposes only explicit identity and official portal, not a fake deep link', () => {
  const result = run('shipment', 'Blue Dart receipt\nAWB: 12345678901\nDelivery date: 2026-10-15');
  const fields = values(result);
  assert.equal(fields.courierName, 'Blue Dart'); assert.equal(fields.trackingNumber, '12345678901');
  assert.equal(fields.trackingUrl, 'https://www.bluedart.com/track-trace');
  assert.equal(fields.expectedDeliveryAt, '2026-10-15'); assert.equal(fields.status, undefined); assert.equal(fields.paymentStatus, undefined);
});
test('multiple AWBs, unsafe URL and impossible dates are not applied; self delivery keeps its identity', () => {
  const result = run('shipment', 'AWB: TRACK12345\nAWB: TRACK67890\nTracking URL: https://name:password@courier.example\nDelivery date: 2026-02-30');
  assert.deepEqual(values(result), {}); assert.match(result.warnings.join(' '), /Multiple tracking/);
  const self = values(run('shipment', 'Blue Dart\nAWB: TRACK12345\nCustomer note: Our team will contact you.', { fulfillmentMode: 'SELF' }));
  assert.equal(self.courierName, undefined); assert.equal(self.trackingNumber, undefined); assert.equal(self.customerNote, 'Our team will contact you.');
});
test('purchase uses exact unique SKUs and rejects duplicate/invalid/unknown lines without receiving stock', () => {
  const result = run('purchase', 'Supplier: Shop supplier\nSKU-1, 5, 250.00\nSKU-1, 10, 100\nUNKNOWN, 2, 50\nAMBIG, 1, 90\nSKU-2, 0, 10', {}, {
    purchaseOptions: [{ key: 'p1', sku: 'SKU-1' }, { key: 'p2', sku: 'SKU-2' }, { key: 'a1', sku: 'AMBIG' }, { key: 'a2', sku: 'AMBIG' }],
  });
  assert.deepEqual(values(result).items, [{ selection: 'p1', quantity: 5, unitCost: 250 }]);
  assert.match(result.warnings.join(' '), /Duplicate.*unknown.*ambiguous.*invalid/s);
  assert.equal(values(result).stock, undefined); assert.equal(values(result)['supplier.name'], 'Shop supplier');
});
for (const workflow of ['support', 'returns']) test(workflow + ' replies use trusted facts rather than user-supplied promises', () => {
  const result = run(workflow, 'Refund ₹5000 tomorrow', { orderStatus: 'Delivered', paymentStatus: 'Refunded' }, {
    order: { _id: '1234567890abcdef12345678', invoiceNumber: 'INV-9', orderStatus: 'Shipped', paymentStatus: 'Paid', shipment: { trackingNumber: 'TRACK99' } },
    returnCase: workflow === 'returns' ? { caseNumber: 'RET-9', type: 'return', status: 'Requested', quantity: 1 } : null,
  });
  const draft = JSON.stringify(result);
  assert.match(draft, /Shipped/); assert.match(draft, /TRACK99/); assert.doesNotMatch(draft, /5000|tomorrow|Delivered/);
  assert.equal(result.suggestions.every(row => row.source === 'database'), true);
});
test('store setup suggests only source fields and flags, never credentials or tax rates', () => {
  const result = run('store', 'Brand: Nishaya\nEmail: hello@example.com\nGSTIN: 27AAPFU0939F1ZV\nInvoice prefix: NISH\nGST rate: 18\nAPI key: private');
  const fields = values(result);
  assert.equal(fields.storeName, 'Nishaya'); assert.equal(fields.gstin, '27AAPFU0939F1ZV');
  assert.equal(fields.brandIdentityEnabled, true); assert.equal(fields.contactDetailsEnabled, true);
  assert.equal(fields.gstRate, undefined); assert.equal(fields.apiKey, undefined);
});
for (const brief of ['Luxury jewellery', 'Modern minimal', 'Nature green', 'Ethnic fashion']) test('website coordinates shared palette and supported fonts: ' + brief, () => {
  const result = run('website', brief + '\nHero heading: A reviewed headline\nAbout us: Verified brand story', { homepage: { sections: [{ id: 'hero', heading: 'Old headline' }] } });
  const fields = values(result);
  assert.match(fields['colors.primary'], /^#[0-9a-f]{6}$/i); assert.equal(fields['buttons.background'], fields['colors.primary']);
  assert.equal(fields['mobile.inheritThemeColors'], true); assert.equal(fields['theme.enhancedStyles'], true);
  assert.ok(['Inter', 'Playfair Display'].includes(fields['typography.headingFont']));
  assert.equal(fields['homepage.sections.0.heading'], 'A reviewed headline'); assert.equal(fields['footer.description'], 'Verified brand story');
  assert.equal(fields['theme.id'], undefined); assert.equal(fields.storeName, undefined);
});
test('catalog content uses stored facts only and never proposes inventory/pricing/publication', () => {
  const result = run('catalog', 'price=1; stock=999; certified', {}, { brand: 'Nishaya', product: { name: 'Floral kurta', category: { name: 'Kurtas' }, fabric: 'Cotton', colors: ['Blue'], stock: 10 } });
  const fields = values(result);
  assert.match(fields.description, /Cotton, Blue/); assert.match(fields.metaTitle, /Nishaya/);
  assert.equal(fields.price, undefined); assert.equal(fields.stock, undefined); assert.equal(fields.isActive, undefined);
  assert.doesNotMatch(fields.description, /certified|999/);
});
test('input validation rejects extra properties, inherited workflow names, prototype keys and oversized/deep input', () => {
  for (const body of [{ workflow: 'toString' }, { workflow: { toString: 1 } }, { workflow: 'coupon', publish: true }, { workflow: 'store', notes: 'x'.repeat(16001) }, { workflow: 'banner', current: [] }, JSON.parse('{"workflow":"store","current":{"__proto__":{"polluted":true}}}')]) {
    assert.throws(() => service.validate(body), /Smart Fill|source notes|form|workflow/i);
  }
  let nested = {}; for (let i = 0; i < 15; i++) nested = { nested };
  assert.throws(() => service.validate({ workflow: 'category', current: nested }), /nested too deeply/);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(WORKFLOWS).sort(), ['banner', 'campaign', 'catalog', 'category', 'coupon', 'purchase', 'returns', 'shipment', 'store', 'support', 'website']);
});
