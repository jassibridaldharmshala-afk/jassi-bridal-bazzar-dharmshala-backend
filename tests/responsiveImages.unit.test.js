const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { preparePhotoFile, responsivePhotoVariants } = require('../services/photoCompressionService');
const { extract } = require('../services/rentalOwnerNotes');
const { fitting } = require('../services/rentalFitting');
test('responsive versions encode resized master pixels losslessly, keep transparency, and do not alter JPEG master bytes', async () => {
  const pixels = Buffer.alloc(2048 * 256 * 4); for (let i = 0; i < pixels.length; i += 4) { pixels[i] = (i / 4) % 255; pixels[i + 1] = 90; pixels[i + 2] = 160; pixels[i + 3] = 180; }
  const original = await sharp(pixels, { raw: { width: 2048, height: 256, channels: 4 } }).png().toBuffer();
  const file = await preparePhotoFile({ buffer: original, size: original.length, mimetype: 'image/png' });
  const variants = await responsivePhotoVariants(file); assert.deepEqual(variants.map(v => v.width), [320, 640, 1200, 2000]);
  for (const variant of variants) { const expected = await sharp(file.buffer).rotate().resize({ width: variant.width, withoutEnlargement: true }).raw().toBuffer(); assert.deepEqual(await sharp(variant.buffer).raw().toBuffer(), expected); }
  const jpeg = await sharp(original).jpeg({ quality: 98 }).toBuffer(); const master = await preparePhotoFile({ buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' }); await responsivePhotoVariants(master); assert.deepEqual(master.buffer, jpeg);
});
test('small originals are never upscaled and duplicate target widths are removed', async () => { const source = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'red' } }).png().toBuffer(); const rows = await responsivePhotoVariants({ buffer: source }); assert.deepEqual(rows.map(row => [row.width, row.height]), [[100, 200]]); });
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
    assert.equal(version.photo.lossless, true);
  }
});
