const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { preparePhotoFile, responsivePhotoVariants, PHOTO_TOTAL_MAX_BYTES } = require('../services/photoCompressionService');
const { extract } = require('../services/rentalOwnerNotes');
const { fitting } = require('../services/rentalFitting');
test('responsive copies keep transparency and have separate byte budgets', async () => {
  const pixels = Buffer.alloc(2048 * 256 * 4); for (let i = 0; i < pixels.length; i += 4) { pixels[i] = (i / 4) % 255; pixels[i + 1] = 90; pixels[i + 2] = 160; pixels[i + 3] = 180; }
  const original = await sharp(pixels, { raw: { width: 2048, height: 256, channels: 4 } }).png().toBuffer();
  const file = await preparePhotoFile({ buffer: original, size: original.length, mimetype: 'image/png' });
  const variants = await responsivePhotoVariants(file); assert.deepEqual(variants.map(v => v.width), [160, 360, 720]);
  const budgets = [8, 22, 60].map(kb => kb * 1024);
  for (const [index, variant] of variants.entries()) { assert.ok(variant.size <= budgets[index]); assert.equal((await sharp(variant.buffer).metadata()).hasAlpha, true); }
  assert.ok(file.size + variants.reduce((sum, row) => sum + row.size, 0) <= PHOTO_TOTAL_MAX_BYTES);
  const jpeg = await sharp(original).jpeg({ quality: 98 }).toBuffer(); const master = await preparePhotoFile({ buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' }); assert.equal(master.mimetype, 'image/webp'); assert.ok(master.size <= 220 * 1024);
});
test('small originals reuse their master without uploading a duplicate or enlarging them', async () => { const source = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'red' } }).png().toBuffer(); const rows = await responsivePhotoVariants({ buffer: source }); assert.deepEqual(rows, []); });
test('rental commercial values come only from explicit owner labels; ambiguous prices and inventory are not invented', () => {
  const result = extract('Daily rent: ₹1,500\nSecurity deposit: 2000\nBooking advance: 30%\nSet contents: Lehenga, blouse, dupatta\nStock: 50');
  assert.equal(result.value.dailyRatePaise, 150000); assert.equal(result.value.depositPaise, 200000); assert.equal(result.value.advancePercent, 30); assert.equal(result.value.fitting.includedItems, 'Lehenga, blouse, dupatta'); assert.equal(result.value.stock, undefined);
  assert.equal(extract('Daily rent: from 500\nDeposit: 1000-2000').value.dailyRatePaise, undefined);
});
test('owner fitting ranges remain optional, validate ranges and keep exact set contents', () => { assert.throws(() => fitting({ type: 'LEHENGA', measurements: { waistMin: 40, waistMax: 30 } }), /minimum/); assert.equal(fitting({ type: 'BRIDAL_SET', includedItems: 'Necklace, two earrings' }).includedItems, 'Necklace, two earrings'); assert.equal(fitting({ adjustable: true }).measurements, undefined); });

test('generated display versions are already prepared and providers reuse the exact output', async () => {
  const original = await sharp({ create: { width: 800, height: 400, channels: 4, background: '#bc637880' } }).png().toBuffer();
  const versions = await responsivePhotoVariants(await preparePhotoFile({ buffer: original, mimetype: 'image/png', size: original.length }));
  for (const version of versions) {
    assert.equal(await preparePhotoFile(version), version);
    assert.equal(version.photo.lossless, false);
  }
});
