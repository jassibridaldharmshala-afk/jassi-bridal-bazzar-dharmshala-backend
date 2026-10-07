const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSocialUrl, validateDraftReview } = require('../modules/social-product-import/socialImport.validation');
const { checkedUrl, publicAddress } = require('../modules/social-product-import/socialImport.network');
const { parsePublicPage, suggestFromCaption } = require('../modules/social-product-import/socialImport.source');
const { imageType } = require('../modules/social-product-import/socialImport.media');

test('normalizes Instagram posts and reels without tracking parameters', () => {
  assert.equal(normalizeSocialUrl('http://instagram.com/p/ABC_123/?igsh=tracking#x').url, 'https://www.instagram.com/p/ABC_123/');
  assert.equal(normalizeSocialUrl('https://www.instagram.com/reels/ABC-123/').url, 'https://www.instagram.com/reel/ABC-123/');
});
test('supports Facebook photo, reel, watch, post and share URL forms', () => {
  for (const value of ['https://m.facebook.com/photo.php?fbid=123&set=foo', 'https://facebook.com/reel/123/', 'https://facebook.com/watch/?v=123', 'https://facebook.com/shop/posts/pfbid123/', 'https://facebook.com/share/p/abc123/', 'https://fb.watch/ABC_123/', 'https://facebook.com/shop/photos/a.123/456/', 'https://facebook.com/permalink.php?story_fbid=123&id=456']) assert.equal(normalizeSocialUrl(value).platform, 'facebook', value);
});
test('rejects non-post URLs, lookalike domains, credentials, ports and unsupported schemes', () => {
  for (const value of ['file:///secret', 'https://localhost/p/123', 'https://instagram.com.evil.test/p/123', 'https://user:pass@instagram.com/p/123', 'https://instagram.com:8443/p/123', 'https://instagram.com/myshop/', 'https://instagram.com/stories/myshop/123/', 'https://facebook.com/login', 'javascript:alert(1)', { url: 'https://instagram.com/p/x' }]) assert.throws(() => normalizeSocialUrl(value), undefined, String(value));
});
test('media downloads accept only Meta CDNs and public IPv4 destinations', () => {
  assert.equal(checkedUrl('https://scontent-a.cdninstagram.com/photo.jpg?token=x', true).hostname, 'scontent-a.cdninstagram.com');
  for (const url of ['https://127.0.0.1/file', 'https://fbcdn.net.evil.test/file', 'http://scontent-a.fbcdn.net/file', 'https://scontent-a.fbcdn.net:8000/file', 'https://user@fbcdn.net/file', 'https://facebook.com/redirect?url=http://localhost']) assert.throws(() => checkedUrl(url, true));
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('31.13.70.52'), true);
});
test('reads all carousel media while excluding profile images and unrelated post shortcodes', () => {
  const page = { graphql: { shortcode_media: { shortcode: 'ABC', edge_media_to_caption: { edges: [{ node: { text: 'Name: Wine Kurti\nPrice: Rs. 1299\nFabric: Cotton\nSizes: S, M' } }] },
    owner: { display_url: 'https://scontent.fbcdn.net/avatar.jpg' }, edge_sidecar_to_children: { edges: [
      { node: { display_url: 'https://scontent.fbcdn.net/front.jpg' } },
      { node: { display_resources: [{ src: 'https://scontent.fbcdn.net/small.jpg', config_width: 150 }, { src: 'https://scontent.fbcdn.net/back.jpg', config_width: 1080 }] } },
    ] } }, related_media: { shortcode: 'OTHER', display_url: 'https://scontent.fbcdn.net/other.jpg' } } };
  const data = parsePublicPage(`<script type="application/json">${JSON.stringify(page)}</script>`, normalizeSocialUrl('https://instagram.com/p/ABC/'));
  assert.deepEqual(data.images.map((image) => image.url), ['https://scontent.fbcdn.net/front.jpg', 'https://scontent.fbcdn.net/back.jpg']);
  assert.match(data.caption, /Wine Kurti/);
});
test('public Facebook metadata reads caption, cover and MP4 video without executing HTML', () => {
  const html = '<meta content="Name: Blue Saree &amp; Blouse" property="og:description"><meta property="og:image" content="https://scontent.fbcdn.net/cover.jpg"><meta property="og:video:secure_url" content="https://video.fbcdn.net/video.mp4"><script>throw new Error("must not run")</script>';
  const data = parsePublicPage(html, normalizeSocialUrl('https://facebook.com/reel/123/'));
  assert.equal(data.images.length, 1); assert.equal(data.videos.length, 1);
  assert.equal(data.caption, 'Name: Blue Saree & Blouse');
});
test('login walls and malicious embedded URLs do not become product photos', () => {
  const data = parsePublicPage('<meta property="og:title" content="Instagram"><meta property="og:image" content="http://169.254.169.254/secret"><meta property="og:description" content="Log in to continue">', normalizeSocialUrl('https://instagram.com/p/ABC/'));
  assert.equal(data.images.length, 0); assert.equal(data.title, ''); assert.equal(data.caption, '');
});
test('caption extraction uses stated fields and never invents stock or ambiguous prices', () => {
  const result = suggestFromCaption('Name: Wine Cotton Kurti\nFabric: Cotton\nColors: Wine, Pink\nSizes: S, M\nRs. 1,299\n#kurti #cotton');
  assert.equal(result.name, 'Wine Cotton Kurti'); assert.equal(result.fabric, 'Cotton'); assert.equal(result.price, 1299);
  assert.deepEqual(result.sizes, ['S', 'M']); assert.equal(result.stock, undefined);
  const sale = suggestFromCaption('MRP Rs 2000; now Rs 1299');
  assert.equal(sale.price, 1299); assert.equal(sale.originalPrice, 2000);
  assert.equal(suggestFromCaption('Rs 999 or Rs 1299 depending on design').price, undefined);
  assert.equal(suggestFromCaption('Beautiful festive outfit').fabric, '');
});
test('draft review chooses only server-owned images, validates numbers and keeps primary image', () => {
  const job = { images: [{ id: 'a', url: '/uploads/a.webp' }, { id: 'b', url: '/uploads/b.webp' }] };
  const value = validateDraftReview({ name: 'Wine Kurti', imageIds: ['b', 'a'], primaryImageId: 'b', images: [{ url: 'https://evil.test/x' }], stock: '0', price: '', colors: 'Wine, Pink' }, job);
  assert.equal(value.images[0].primary, true); assert.equal(value.image, '/uploads/b.webp'); assert.equal(value.stock, 0); assert.equal(value.price, undefined);
  assert.deepEqual(value.colors, ['Wine', 'Pink']);
  for (const body of [{ imageIds: ['unknown'] }, { stock: 1.5 }, { stock: -1 }, { price: Infinity }, { stock: true }, { price: [] }, { price: ' ' }, { price: 200, originalPrice: 100 }]) assert.throws(() => validateDraftReview({ name: 'Wine Kurti', imageIds: ['a'], ...body }, job));
});
test('image magic bytes reject disguised HTML and SVG payloads', () => {
  assert.equal(imageType(Buffer.from([255, 216, 255, 0])), 'jpg');
  assert.equal(imageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  for (const value of ['<svg onload="attack">', '<html>login</html>']) assert.throws(() => imageType(Buffer.from(value)));
});
