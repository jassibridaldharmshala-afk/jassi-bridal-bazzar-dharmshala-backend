const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_WEBSITE_CONFIG, normalizeWebsiteConfig } = require('../config/websiteCustomization');
const { applyContent, reconcileContent, sanitizeContent, snapshotContent } = require('../services/storeContentService');

function fixture() {
  return normalizeWebsiteConfig({ ...structuredClone(DEFAULT_WEBSITE_CONFIG),
    colors: { ...DEFAULT_WEBSITE_CONFIG.colors, primary: '#123456' },
    homepage: { ...structuredClone(DEFAULT_WEBSITE_CONFIG.homepage), blocks: [{
      id: 'faq-1', type: 'faq', visible: true, order: 120, title: 'Questions', body: 'Helpful answers',
      items: ['Shipping'], image: 'https://example.com/faq.jpg', productIds: ['507f1f77bcf86cd799439011'],
    }] },
  });
}

test('content patch changes wording while preserving layout, media and catalog references', () => {
  const base = fixture();
  const content = snapshotContent(base);
  content.sections[0].heading = 'Festive arrivals';
  content.blocks[0].title = 'Common questions';
  const result = applyContent(base, content);
  assert.equal(result.homepage.sections[0].heading, 'Festive arrivals');
  assert.equal(result.homepage.blocks[0].title, 'Common questions');
  assert.equal(result.colors.primary, '#123456');
  assert.equal(result.homepage.blocks[0].image, 'https://example.com/faq.jpg');
  assert.deepEqual(result.homepage.blocks[0].productIds, ['507f1f77bcf86cd799439011']);
  assert.equal(result.homepage.blocks[0].visible, true);
});

test('content validation rejects structural injection and unsafe CTA destinations', () => {
  const base = fixture();
  const content = snapshotContent(base);
  assert.throws(() => sanitizeContent({ ...content, colors: { primary: '#000000' } }, base), /Only storefront wording/);
  content.sections[0].buttonLink = 'https://attacker.example';
  assert.throws(() => sanitizeContent(content, base), /safe store path/);
  const injected = snapshotContent(base);
  injected.blocks[0].visible = false;
  assert.throws(() => sanitizeContent(injected, base), /Only custom block wording/);
});

test('scheduled content reconciles with a newer block structure', () => {
  const old = fixture();
  const scheduled = snapshotContent(old);
  scheduled.blocks[0].title = 'Scheduled FAQ';
  const newer = normalizeWebsiteConfig({ ...old, homepage: { ...old.homepage, blocks: [{ id: 'newsletter-1', type: 'newsletter', title: 'Join us', body: 'Weekly edit' }] } });
  const reconciled = reconcileContent(scheduled, newer);
  assert.equal(reconciled.blocks.length, 1);
  assert.equal(reconciled.blocks[0].id, 'newsletter-1');
  assert.equal(reconciled.blocks[0].title, 'Join us');
  const result = applyContent(newer, scheduled);
  assert.equal(result.homepage.blocks[0].type, 'newsletter');
  assert.equal(result.homepage.blocks[0].title, 'Join us');
});
