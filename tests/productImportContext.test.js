const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { run } = require('../services/productFrameSelection.service');
const { captionPrices, captionSuggestion, normalizeContext, prepareContextVideo, analyzeProductContext } = require('../services/productImportContext.service');
const categories = [{ _id: 'sarees', name: 'Sarees' }, { _id: 'kurtis', name: 'Kurtis' }];

test('catalog Smart Fill sends bounded in-memory photos and retains evidence checks', async (t) => {
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'isolated-smart-fill';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const request = t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts.filter(part => part.inlineData).length, 2);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...raw, sizes: ['M'], fabric: 'Silk', fieldSources: { price: { source: 'caption', quote: 'Price: 1299' }, sizes: { source: 'visual', quote: 'Looks medium' }, fabric: { source: 'visual', quote: 'Looks silky' } } }) }] } }] }) };
  });
  const images = [1, 2].map(() => ({ mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 1]) }));
  const result = await analyzeProductContext({ caption: 'Name: Wine Saree\nPrice: 1299', images, categories });
  assert.equal(result.contextStatus, 'completed'); assert.equal(result.contextInputs.photos, true);
  assert.equal(result.price, 1299); assert.equal(result.fabric, ''); assert.deepEqual(result.sizes, []);
  assert.equal(request.mock.callCount(), 1);
});

test('catalog Smart Fill blocks arbitrary URLs and only accepts image bytes from configured storage', (t) => {
  const { mediaLocation, verifiedImage } = require('../services/productSmartFillMedia');
  const previous = process.env.R2_PUBLIC_URL; process.env.R2_PUBLIC_URL = 'https://catalog.example/products';
  t.after(() => { if (previous === undefined) delete process.env.R2_PUBLIC_URL; else process.env.R2_PUBLIC_URL = previous; });
  assert.equal(mediaLocation('https://catalog.example/products/a.webp').url.hostname, 'catalog.example');
  assert.ok(mediaLocation('/uploads/product.jpg').file.endsWith('product.jpg'));
  for (const url of ['http://169.254.169.254/latest/meta-data', 'https://catalog.example.evil.test/products/a.jpg', 'https://catalog.example/private/a.jpg', 'https://user:secret@catalog.example/products/a.jpg', '/uploads/../.env', '/uploads/%2e%2e%2f.env', 'file:///etc/passwd', '/uploads/a\\b.jpg']) assert.throws(() => mediaLocation(url));
  assert.equal(verifiedImage(Buffer.from([255, 216, 255, 1])).mimeType, 'image/jpeg');
  assert.throws(() => verifiedImage(Buffer.from('<svg></svg>')));
  assert.throws(() => verifiedImage(Buffer.alloc(4 * 1024 * 1024 + 1)));
});

test('catalog Smart Fill controller scopes categories, returns notes fallback and never writes a product', async (t) => {
  const { EventEmitter } = require('node:events');
  const Category = require('../models/Category');
  const Configuration = require('../models/MasterConfiguration');
  const Product = require('../models/Product');
  const controller = require('../controllers/productSmartFillController');
  const previous = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.GEMINI_API_KEY = previous; });
  let query;
  t.mock.method(Category, 'find', value => { query = value; return { select() { return this; }, limit() { return this; }, lean: async () => categories }; });
  t.mock.method(Configuration, 'findById', () => ({ lean: async () => ({ structure: { features: { sizing: true }, attributes: [{ key: 'lining', label: 'Lining material' }] } }) }));
  const write = t.mock.method(Product, 'create', () => { throw new Error('Must never create products'); });
  const res = new EventEmitter(); res.json = value => { res.body = value; res.writableEnded = true; };
  let error;
  await controller.fill({ user: { _id: 'admin-test' }, tenantFilter: { storeId: 'store-test' }, body: { notes: 'Name: Wine Saree\nFabric: Cotton\nPrice: 899\nShipping: Rs 99\nLining material: Cotton', existing: { stock: 100, price: 500, apiKey: 'never-send' }, imageUrls: [] } }, res, value => { error = value; });
  assert.equal(error, undefined); assert.ok(JSON.stringify(query).includes('store-test'));
  assert.equal(res.body.mode, 'notes'); assert.equal(res.body.suggestion.price, 899);
  assert.equal(res.body.suggestion.category, 'sarees'); assert.equal(res.body.suggestion.stock, undefined);
  assert.equal(res.body.suggestion.attributeValues.lining, 'Cotton');
  assert.equal(write.mock.callCount(), 0); assert.equal(res.listenerCount('close'), 0);
  assert.ok(!JSON.stringify(res.body).includes('never-send'));
});

test('catalog Smart Fill validates requests before doing database or AI work', async (t) => {
  const Category = require('../models/Category');
  const controller = require('../controllers/productSmartFillController');
  const lookup = t.mock.method(Category, 'find', () => { throw new Error('Must not query'); });
  for (const body of [{ notes: {} }, { notes: 'a'.repeat(7001) }, { imageUrls: ['a', 'b', 'c', 'd'] }, { imageUrls: [null] }]) {
    let error; await controller.fill({ user: { _id: 'test' }, body }, {}, value => { error = value; });
    assert.equal(error.errorCode, 'VALIDATION_ERROR');
  }
  assert.equal(lookup.mock.callCount(), 0);
});
const raw = { name: 'Wine Embroidered Saree', description: 'A wine saree with an embroidered border.', category: 'sarees', multipleProducts: false, priceAmbiguous: false, currency: 'INR', price: 1299, originalPrice: 1999, fieldSources: { price: { source: 'speech', quote: 'Selling price is 1299 rupees', timestampSeconds: 4 }, originalPrice: { source: 'on_screen', quote: 'MRP ₹1999' } } };

test('caption autofill separates the selling price, MRP and delivery fees', () => {
  const value = captionSuggestion('Name: Wine Cotton Saree\nFabric: Cotton\nColours: Wine, Gold\nMRP ₹1,999; offer ₹1,299\nShipping Rs 99\n#saree', '', categories);
  assert.equal(value.price, 1299); assert.equal(value.originalPrice, 1999);
  assert.equal(value.category, 'sarees'); assert.equal(value.sizingMode, 'free-size');
  assert.equal(value.stock, undefined); assert.equal(value.fabric, 'Cotton');
  assert.ok(!value.description.includes('Shipping')); assert.equal(value.fieldSources.price.source, 'caption');
  assert.equal(captionPrices('Price: ८९९').price, 899);
});

test('ambiguous, starting, bundle and multiple prices never become one selling price', () => {
  for (const text of ['From Rs 999', 'Starting at ₹499', '₹999–1299', '2 for ₹999', 'Red Rs 999\nBlue Rs 1299', 'Rs 999 or Rs 1499 depending on design', 'EMI ₹99 per month', 'Price: 199 USD']) assert.equal(captionPrices(text).price, undefined, text);
  assert.equal(captionPrices('MRP ₹1999').price, undefined);
  assert.equal(captionPrices('Shipping ₹99').price, undefined);
  assert.equal(captionPrices('Call 9812345678 for details').price, undefined);
});

test('reel context accepts sourced prices and rejects estimates or mismatched evidence', () => {
  const value = normalizeContext(raw, { categories, videoCount: 1 });
  assert.equal(value.price, 1299); assert.equal(value.originalPrice, 1999);
  assert.equal(value.fieldSources.price.timestampSeconds, 4);
  for (const change of [{ currency: 'USD' }, { multipleProducts: true }, { priceAmbiguous: true }, { fieldSources: { price: { source: 'visual', quote: 'Looks like 1299' } } }, { price: 1499 }]) assert.equal(normalizeContext({ ...raw, ...change }, { categories, videoCount: 1 }).price, undefined);
  assert.equal(normalizeContext(raw, { categories, videoCount: 0 }).price, undefined);
  for (const quote of ['Shipping ₹1299', 'MRP ₹1299', 'Discount ₹1299', 'USD 1299']) assert.equal(normalizeContext({ ...raw, fieldSources: { price: { source: 'on_screen', quote } } }, { categories }).price, undefined, quote);
  assert.equal(normalizeContext({ ...raw, fieldSources: { price: { source: 'caption', quote: '₹1299' } } }, { categories, caption: 'Starting from ₹1299' }).price, undefined);
  assert.throws(() => normalizeContext({}, { categories }), /Incomplete/);
});

test('fabric, sizes, measurements and custom fields require stated evidence', () => {
  const value = normalizeContext({ ...raw, fabric: 'Cotton', sizes: ['M'], stock: 99, category: 'invented', categoryName: 'Kurtis', sizeChart: { unit: 'in', rows: [{ size: 'M', bust: 38, invented: 42 }] }, attributeValues: { lining: 'Cotton', unexpected: 'no' }, fieldSources: { ...raw.fieldSources, fabric: { source: 'visual', quote: 'Looks cotton' }, sizes: { source: 'on_screen', quote: 'Available M' }, sizeChart: { source: 'on_screen', quote: 'M bust 38 inches' }, 'attribute.lining': { source: 'on_screen', quote: 'Cotton lining' } } }, { categories, videoCount: 1, attributes: [{ key: 'lining' }] });
  assert.equal(value.fabric, undefined); assert.deepEqual(value.sizes, ['M']); assert.equal(value.stock, undefined);
  assert.equal(value.category, 'kurtis'); assert.equal(value.sizeChart.rows[0].bust, 38); assert.equal(value.sizeChart.rows[0].invented, undefined);
  assert.deepEqual(value.attributeValues, { lining: 'Cotton' });
  assert.equal(normalizeContext({ ...raw, fieldSources: { price: { source: 'caption', quote: '₹1299' } } }, { categories, caption: 'No price here' }).price, undefined);
});

test('real context preparation retains audio and the AI request uses the video with selected photos', { timeout: 30000 }, async (t) => {
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'isolated-fixture-key';
  const root = path.resolve(__dirname, '../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'context-test-'));
  t.after(async () => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; if (path.dirname(path.resolve(directory)) === root && path.basename(directory).startsWith('context-test-')) await fs.rm(directory, { recursive: true, force: true }); });
  const video = path.join(directory, 'source.mp4'); const photo = path.join(directory, 'source.jpg');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x480:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', video, '-frames:v', '1', photo]);
  const prepared = await prepareContextVideo(video, directory);
  const metadata = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', prepared.path])).stdout);
  assert.ok(metadata.streams.some((stream) => stream.codec_type === 'audio'));
  assert.ok(prepared.size < 12 * 1024 * 1024); await fs.unlink(prepared.path);
  let requestBody;
  const provider = t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/')); assert.ok(!url.includes('isolated-fixture-key'));
    assert.equal(options.headers['x-goog-api-key'], 'isolated-fixture-key'); requestBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] }) };
  });
  const result = await analyzeProductContext({ videoFiles: [{ path: video }], filePaths: [photo], directory, categories });
  assert.equal(result.contextStatus, 'completed'); assert.equal(result.price, 1299); assert.equal(result.contextInputs.video, true);
  const media = requestBody.contents[0].parts.filter((part) => part.inlineData).map((part) => part.inlineData);
  assert.deepEqual(media.map((item) => item.mimeType), ['video/mp4', 'image/jpeg']); assert.ok(media.every((item) => Buffer.from(item.data, 'base64').length > 0));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['source.jpg', 'source.mp4']);
  provider.mock.mockImplementation(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  const quota = await analyzeProductContext({ caption: 'Name: Wine Saree\nPrice: 899', categories });
  assert.equal(quota.contextStatus, 'failed'); assert.equal(quota.contextErrorCode, 'AI_QUOTA_EXCEEDED'); assert.equal(quota.price, 899);
  provider.mock.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  assert.equal((await analyzeProductContext({ caption: 'Wine Saree', categories })).contextErrorCode, 'AI_ACCESS_DENIED');
});

test('caption autofill remains available without an AI key', async (t) => {
  const previous = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const request = t.mock.method(global, 'fetch', () => { throw new Error('Must not call AI'); });
  const value = await analyzeProductContext({ caption: 'Name: Cotton Kurti\nPrice: 899\nSizes: S, M', categories });
  assert.equal(value.price, 899); assert.equal(value.category, 'kurtis'); assert.equal(value.contextStatus, 'caption'); assert.equal(request.mock.callCount(), 0);
  assert.equal(captionSuggestion('Selling price: 899\nFabric: Cotton', '', categories).name, '');
});
