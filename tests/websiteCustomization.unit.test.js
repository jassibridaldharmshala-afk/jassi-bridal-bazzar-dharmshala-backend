// Pure tests: no server, credentials, external API or database is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_WEBSITE_CONFIG, normalizeWebsiteConfig, getPresetList } = require('../config/websiteCustomization');

test('all premium and industry presets have complete, independent configurations and coordinated palettes', () => {
  const presets = getPresetList();
  assert.equal(presets.length, 21);
  for (const preset of presets) {
    assert.equal(preset.config.theme.preset, preset.id);
    assert.equal(preset.config.mobile.enabled, false);
    assert.equal(preset.config.tablet.enabled, false);
    assert.ok(preset.description);
    assert.ok(preset.collection);
    assert.equal(preset.swatches.primary, preset.config.colors.primary);
    assert.equal(preset.config.homepage.sections.length, 14);
    if (preset.id !== 'default') {
      assert.equal(preset.config.buttons.background, preset.config.colors.primary);
      assert.equal(preset.config.header.background, preset.config.colors.background);
      assert.equal(preset.config.theme.enhancedStyles, true);
    }
  }
  presets[0].config.branding.websiteName = 'Changed';
  assert.equal(DEFAULT_WEBSITE_CONFIG.branding.websiteName, 'Jassi General Store');
});

test('lightweight gallery presets keep the same appearance with no repeated business content', () => {
  const full = getPresetList();
  const compact = getPresetList({ appearanceOnly: true });
  assert.equal(compact.length, full.length);
  for (const [index, preset] of compact.entries()) {
    assert.equal(preset.config.branding, undefined);
    assert.equal(preset.config.homepage, undefined);
    assert.equal(preset.config.footer.menus, undefined);
    const normalized = normalizeWebsiteConfig(preset.config);
    for (const key of ['colors', 'typography', 'productCards', 'buttons', 'theme']) assert.deepEqual(normalized[key], full[index].config[key]);
    assert.equal(normalized.theme.preset, preset.id);
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * 0.3);
});

test('legacy normalization does not enable handheld overrides or enhanced desktop styling', () => {
  const config = normalizeWebsiteConfig({ schemaVersion: 2, header: { sticky: false } });
  assert.equal(config.mobile.enabled, false);
  assert.equal(config.tablet.enabled, false);
  assert.equal(config.theme.enhancedStyles, false);
  assert.equal(config.header.sticky, false);
});

test('mobile sections are bounded, known-only, independently ordered and normalized', () => {
  const config = normalizeWebsiteConfig({
    mobile: { enabled: true, columns: 22.5, gridGap: -30, headerText: 'red',
      sections: [null, { id: 'hero', order: 0, visible: false }, { id: 'unknown', visible: true }] },
    tablet: { enabled: true, columns: 2.8, gridGap: 999 },
    layout: { productsPerRow: { desktop: 2.8 } },
  });
  assert.equal(config.mobile.columns, 2);
  assert.equal(config.mobile.gridGap, 8);
  assert.equal(config.tablet.columns, 3);
  assert.equal(config.tablet.gridGap, 32);
  assert.equal(config.layout.productsPerRow.desktop, 3);
  assert.equal(config.mobile.sections.length, 14);
  assert.deepEqual(config.mobile.sections[0], { id: 'hero', order: 0, visible: false, heading: '' });
  assert.equal(config.homepage.sections[0].visible, true);
});

test('unsafe URLs are removed and catalog values survive normalization', () => {
  const config = normalizeWebsiteConfig({
    branding: { logo: 'javascript:alert(1)', favicon: '/uploads/favicon.png' },
    homepage: { sections: [null, { id: 'hero', buttonLink: '/\\evil.test', image: 'data:text/html,unsafe', backgroundImage: 'https://images.example.com/hero.jpg' }],
      blocks: [{ id: 'campaign-hero', type: 'hero', image: '/uploads/hero.webp', altText: 'Campaign' }, { id: 'categories', type: 'category-carousel', categoryIds: ['1', '2'] }],
      sectionProductIds: { featured: ['1', '1', '2'] } },
    footer: { logo: '//evil.test/image.png', menus: { shopping: [{ label: 'Bad', path: '/\\evil.test' }] } },
  });
  assert.equal(config.branding.logo, '');
  assert.equal(config.branding.favicon, '/uploads/favicon.png');
  assert.equal(config.footer.logo, '');
  assert.deepEqual(config.footer.menus.shopping, []);
  assert.equal(config.homepage.sections[0].buttonLink, '');
  assert.equal(config.homepage.sections[0].image, '');
  assert.equal(config.homepage.sections[0].backgroundImage, 'https://images.example.com/hero.jpg');
  assert.deepEqual(config.homepage.sectionProductIds.featured, ['1', '2']);
  assert.deepEqual(config.homepage.blocks.map((block) => block.type), ['hero', 'category-carousel']);
});

test('stale draft save, publish, reset, activation and restore requests fail before writes', async (t) => {
  const WebsiteTheme = require('../models/WebsiteTheme');
  const controller = require('../controllers/websiteCustomizationController');
  const theme = { updatedAt: new Date('2026-09-01T00:00:00Z') };
  t.mock.method(WebsiteTheme, 'findById', async () => theme);
  for (const action of ['updateDraft', 'publishTheme', 'discardDraft', 'activateTheme', 'restoreVersion']) {
    let error;
    await controller[action]({ params: { id: '0123456789abcdef01234567' }, body: { expectedUpdatedAt: '2026-08-01T00:00:00Z', config: {} } }, {}, (err) => { error = err; });
    assert.equal(error?.statusCode, 409, action);
    assert.match(error.message, /another session/);
  }
});

test('missing configuration cannot accidentally erase a draft', async (t) => {
  const WebsiteTheme = require('../models/WebsiteTheme');
  const controller = require('../controllers/websiteCustomizationController');
  t.mock.method(WebsiteTheme, 'findById', async () => ({ draftConfig: { branding: { websiteName: 'Keep' } } }));
  let error;
  await controller.updateDraft({ params: { id: '0123456789abcdef01234567' }, body: { name: 'Rename' } }, {}, (err) => { error = err; });
  assert.equal(error?.statusCode, 400);
  assert.match(error.message, /configuration is required/);
});

test('a failed version-history insert never deactivates the live theme', async (t) => {
  const WebsiteTheme = require('../models/WebsiteTheme');
  const WebsiteThemeVersion = require('../models/WebsiteThemeVersion');
  const controller = require('../controllers/websiteCustomizationController');
  t.mock.method(WebsiteTheme, 'findById', async () => ({ _id: '0123456789abcdef01234567', draftConfig: DEFAULT_WEBSITE_CONFIG }));
  t.mock.method(WebsiteTheme, 'findOne', () => ({ lean: async () => ({ _id: 'old-theme' }) }));
  t.mock.method(WebsiteThemeVersion, 'findOne', () => ({ sort: () => ({ lean: async () => null }) }));
  t.mock.method(WebsiteThemeVersion, 'create', async () => { throw new Error('History unavailable'); });
  const deactivate = t.mock.method(WebsiteTheme, 'updateMany', async () => {});
  let error;
  await controller.publishTheme({ params: { id: '0123456789abcdef01234567' }, body: {}, user: { _id: 'admin' } }, {}, (err) => { error = err; });
  assert.equal(error.message, 'History unavailable');
  assert.equal(deactivate.mock.callCount(), 0);
});

test('failed activation restores the previous active theme', async (t) => {
  const WebsiteTheme = require('../models/WebsiteTheme');
  const controller = require('../controllers/websiteCustomizationController');
  const theme = { _id: '0123456789abcdef01234567', publishedConfig: DEFAULT_WEBSITE_CONFIG,
    save: async () => { throw Object.assign(new Error('Concurrent update'), { name: 'VersionError' }); } };
  t.mock.method(WebsiteTheme, 'findById', async () => theme);
  t.mock.method(WebsiteTheme, 'findOne', () => ({ lean: async () => ({ _id: 'previous' }) }));
  t.mock.method(WebsiteTheme, 'updateMany', async () => {});
  t.mock.method(WebsiteTheme, 'exists', async () => false);
  const restore = t.mock.method(WebsiteTheme, 'updateOne', async () => {});
  let error;
  await controller.activateTheme({ params: { id: theme._id }, body: {}, user: { _id: 'admin' } }, {}, (err) => { error = err; });
  assert.equal(error.statusCode, 409);
  assert.deepEqual(restore.mock.calls[0].arguments, [{ _id: 'previous' }, { $set: { isActive: true } }]);
});

test('theme deletion rechecks active state and revision before deleting any history', async (t) => {
  const WebsiteTheme = require('../models/WebsiteTheme');
  const WebsiteThemeVersion = require('../models/WebsiteThemeVersion');
  const controller = require('../controllers/websiteCustomizationController');
  const theme = { _id: '0123456789abcdef01234567', isActive: false, __v: 3 };
  t.mock.method(WebsiteTheme, 'findById', async () => theme);
  const remove = t.mock.method(WebsiteTheme, 'deleteOne', async () => ({ deletedCount: 0 }));
  const history = t.mock.method(WebsiteThemeVersion, 'deleteMany', async () => {});
  let error;
  await controller.deleteTheme({ params: { id: theme._id }, body: {}, user: { _id: 'admin' } }, {}, (err) => { error = err; });
  assert.equal(error.statusCode, 409);
  assert.deepEqual(remove.mock.calls[0].arguments[0], { _id: theme._id, isActive: false, __v: 3 });
  assert.equal(history.mock.callCount(), 0);
});
