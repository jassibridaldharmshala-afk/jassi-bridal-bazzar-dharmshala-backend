const test = require('node:test');
const assert = require('node:assert/strict');
const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings } = require('./factories');
const { createProvisionedSeller } = require('./accessFixtures');
const Campaign = require('../models/Campaign');
const Coupon = require('../models/Coupon');
const Banner = require('../models/Banner');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const Order = require('../models/Order');
const Store = require('../models/Store');
const { performanceFor, readiness } = require('../controllers/campaignController');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => { await resetDatabase(); await setSettings(); });

async function call(method, path, body, token, expected = 200, headers = {}) {
  const result = await request(path, { method, body, token, headers });
  assert.equal(result.status, expected, `${method} ${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function campaignBody(overrides = {}) {
  const body = {
    idempotencyKey: `campaign-test-${Date.now()}-${Math.random()}`,
    name: 'Festival discovery', preset: 'FESTIVAL', timezone: 'Asia/Kolkata',
    startsAt: null, endsAt: new Date(Date.now() + 86400000).toISOString(),
    offer: {
      code: 'FESTIVE20', activationMode: 'CODE', benefitType: 'DISCOUNT', type: 'Percentage', discountValue: 20,
      buyQuantity: 2, getQuantity: 1, minOrderAmount: 999, minItemQuantity: 0, maxDiscountAmount: 500,
      usageLimit: 100, customerLimit: 1, totalBudget: 10000, customerSegment: 'ALL', firstOrderOnly: false,
      stackingMode: 'ALLOW_PRODUCT_OFFERS', scopeMatchMode: 'ANY', minimumRequirementBasis: 'CART',
      restoreOnFullRefund: false, isPublic: true, applicableProducts: [], applicableCategories: [],
      applicableCustomers: [], applicablePincodes: [], applicablePaymentMethods: [], salesChannels: ['STOREFRONT'],
    },
    creative: {
      title: 'The festival edit', subtitle: 'Save on selected styles', buttonText: 'Shop now',
      image: '/uploads/festival.jpg', mobileImage: '/uploads/festival-mobile.jpg', altText: 'Model wearing a festive outfit',
      focalPoint: 'center', type: 'Sale', position: 'Home - Middle', destinationType: 'CUSTOM', link: '/products', displayOrder: 2,
    },
  };
  return { ...body, ...overrides, offer: { ...body.offer, ...(overrides.offer || {}) }, creative: { ...body.creative, ...(overrides.creative || {}) } };
}

test('campaign readiness enforces preset-specific commercial safeguards', () => {
  const firstOrder = campaignBody({ preset: 'FIRST_ORDER', offer: { customerSegment: 'NEW', firstOrderOnly: true, minOrderAmount: 0 } });
  assert.equal(readiness(firstOrder).ready, false);
  assert.match(readiness(firstOrder).errors.join(' '), /minimum order/i);

  const freeShipping = campaignBody({ preset: 'FREE_SHIPPING', offer: { benefitType: 'FREE_SHIPPING', minOrderAmount: 999, maxDiscountAmount: 0 } });
  assert.equal(readiness(freeShipping).ready, false);
  assert.match(readiness(freeShipping).errors.join(' '), /maximum delivery benefit/i);

  const repeat = campaignBody({ preset: 'REPEAT', offer: { customerSegment: 'REPEAT', minimumPriorOrders: 0 } });
  assert.equal(readiness(repeat).ready, false);
  assert.match(readiness(repeat).errors.join(' '), /previous order/i);
});

test('campaign draft is idempotent and publishing creates one synchronized coupon and banner', async () => {
  const { token } = await createAdmin();
  const body = campaignBody();
  const draft = await call('POST', '/api/admin/campaigns', body, token, 201);
  assert.equal(draft.lifecycle, 'Draft');
  assert.equal(draft.coupon, null);
  const repeated = await call('POST', '/api/admin/campaigns', body, token);
  assert.equal(repeated._id, draft._id);
  assert.equal(await Campaign.countDocuments({}), 1);

  const published = await call('PATCH', `/api/admin/campaigns/${draft._id}/status`, { action: 'PUBLISH' }, token);
  assert.equal(published.lifecycle, 'Live');
  assert.equal(published.linkedCoupon.code, 'FESTIVE20');
  assert.equal(published.linkedBanners.length, 1);
  const [coupon, banner] = await Promise.all([Coupon.findById(published.coupon), Banner.findById(published.banners[0])]);
  assert.equal(String(coupon.campaignId), draft._id);
  assert.equal(String(banner.campaignId), draft._id);
  assert.equal(banner.campaignKey, published.key);
  assert.equal(coupon.isActive, true);
  assert.equal(banner.isActive, true);
  assert.equal(published.health.synchronized, true);

  const couponEdit = await call('PUT', `/api/admin/coupons/${coupon._id}`, {}, token, 400);
  assert.match(couponEdit.message, /managed by Campaigns/i);
  const bannerEdit = await call('PUT', `/api/admin/banners/${banner._id}`, {}, token, 400);
  assert.match(bannerEdit.message, /managed by Campaigns/i);
  const couponCopy = await call('POST', `/api/admin/coupons/${coupon._id}/duplicate`, {}, token, 201);
  const bannerCopy = await call('POST', `/api/admin/banners/${banner._id}/duplicate`, {}, token, 201);
  assert.equal(couponCopy.campaignId, undefined);
  assert.equal(bannerCopy.campaignId, undefined);

  await call('PATCH', `/api/admin/campaigns/${draft._id}/status`, { action: 'PAUSE' }, token);
  assert.equal((await Coupon.findById(coupon._id)).isActive, false);
  assert.equal((await Banner.findById(banner._id)).isActive, false);
  await call('PATCH', `/api/admin/campaigns/${draft._id}/status`, { action: 'ARCHIVE' }, token);
  assert.equal((await Campaign.findById(draft._id)).state, 'ARCHIVED');
  assert.equal((await Coupon.findById(coupon._id)).isArchived, true);
  await call('PATCH', `/api/admin/campaigns/${draft._id}/status`, { action: 'RESTORE' }, token);
  assert.equal((await Campaign.findById(draft._id)).state, 'PAUSED');
  assert.equal((await Banner.findById(banner._id)).isArchived, false);
  assert.equal((await Banner.findById(banner._id)).isActive, false);
});

test('concurrent duplicate publish requests resolve to one complete campaign', async () => {
  const { token } = await createAdmin();
  await Campaign.init();
  const body = { ...campaignBody(), idempotencyKey: 'same-publish-request', publish: true };
  const responses = await Promise.all([
    request('/api/admin/campaigns', { method: 'POST', token, body }),
    request('/api/admin/campaigns', { method: 'POST', token, body }),
    request('/api/admin/campaigns', { method: 'POST', token, body }),
  ]);
  responses.forEach((response) => assert.ok([200, 201].includes(response.status), JSON.stringify(response.data)));
  assert.equal(new Set(responses.map((response) => response.data._id)).size, 1);
  assert.ok(responses.every((response) => response.data.lifecycle === 'Live'));
  const campaignId = responses[0].data._id;
  assert.equal(await Campaign.countDocuments({}), 1);
  assert.equal(await Coupon.countDocuments({ campaignId }), 1);
  assert.equal(await Banner.countDocuments({ campaignId }), 1);
});

test('published campaign edits keep the last working version when synchronization is rejected', async () => {
  const { token } = await createAdmin();
  const published = await call('POST', '/api/admin/campaigns', { ...campaignBody(), publish: true }, token, 201);
  const failed = await call('PUT', `/api/admin/campaigns/${published._id}`, {
    ...campaignBody({ idempotencyKey: undefined, creative: { image: '' } }),
    revision: published.revision,
  }, token, 400);
  assert.match(failed.message, /image/i);
  const preserved = await call('GET', `/api/admin/campaigns/${published._id}`, undefined, token);
  assert.equal(preserved.lifecycle, 'Live');
  assert.equal(preserved.creative.image, '/uploads/festival.jpg');
  assert.equal(preserved.health.synchronized, true);
});

test('a linked transition rolls back every record when one asset fails to save', async (t) => {
  const { token } = await createAdmin();
  const published = await call('POST', '/api/admin/campaigns', { ...campaignBody(), publish: true }, token, 201);
  t.mock.method(Banner.prototype, 'save', async () => { throw new Error('simulated banner write failure'); });
  await call('PATCH', `/api/admin/campaigns/${published._id}/status`, { action: 'PAUSE' }, token, 500);
  const [campaign, coupon, banner] = await Promise.all([
    Campaign.findById(published._id).lean(), Coupon.findById(published.coupon).lean(), Banner.findById(published.banners[0]).lean(),
  ]);
  assert.equal(campaign.state, 'PUBLISHED');
  assert.equal(coupon.isActive, true);
  assert.equal(banner.isActive, true);
});

test('campaigns report overlapping placements and keep configurable customer thresholds', async () => {
  const { token } = await createAdmin();
  const first = await call('POST', '/api/admin/campaigns', { ...campaignBody({
    name: 'VIP week', preset: 'VIP',
    offer: { code: 'VIPWEEK', customerSegment: 'VIP', minimumPriorOrders: 8, minimumLifetimeSpend: 50000 },
  }), publish: true }, token, 201);
  await call('POST', '/api/admin/campaigns', { ...campaignBody({
    name: 'Festival week', offer: { code: 'SECOND20' },
  }), publish: true }, token, 201);
  const list = await call('GET', '/api/admin/campaigns?page=1&limit=12', undefined, token);
  const vip = list.items.find((item) => item._id === first._id);
  assert.equal(vip.offer.minimumPriorOrders, 8);
  assert.equal(vip.offer.minimumLifetimeSpend, 50000);
  assert.equal(vip.schedule.clear, false);
  assert.match(vip.schedule.conflicts[0].name, /Festival week/);
  const linkedCoupon = await Coupon.findById(vip.coupon).lean();
  assert.equal(linkedCoupon.minimumPriorOrders, 8);
  assert.equal(linkedCoupon.minimumLifetimeSpend, 50000);
});

test('category targeting options show an eligible product count and sample', async () => {
  const { token } = await createAdmin();
  const product = await createProduct({ name: 'Rose Silk Saree' });
  const options = await call('GET', `/api/admin/coupons/options?type=CATEGORY&selected=${product.category}`, undefined, token);
  const category = options.items.find((item) => item.id === String(product.category));
  assert.ok(category);
  assert.match(category.subtitle, /1 eligible product/);
  assert.match(category.subtitle, /Rose Silk Saree/);
});

test('incomplete targeted campaign remains visible as failed and can be repaired after editing', async () => {
  const { token } = await createAdmin();
  const draft = await call('POST', '/api/admin/campaigns', campaignBody({ preset: 'CATEGORY', offer: { code: 'CAT15', applicableCategories: [] }, creative: { destinationType: 'CATEGORY', destinationValue: '' } }), token, 201);
  const failed = await call('PATCH', `/api/admin/campaigns/${draft._id}/status`, { action: 'PUBLISH' }, token, 400);
  assert.match(failed.message, /category/i);
  const stored = await Campaign.findById(draft._id);
  assert.equal(stored.state, 'FAILED');
  assert.match(stored.lastError, /category/i);
  const list = await call('GET', '/api/admin/campaigns?state=FAILED&page=1&limit=12', undefined, token);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].readiness.ready, false);
  assert.equal(await Coupon.countDocuments({ campaignId: draft._id }), 0);
  assert.equal(await Banner.countDocuments({ campaignId: draft._id }), 0);
});

test('campaign performance uses stored attribution and does not double count coupon and banner matches', async () => {
  const { token } = await createAdmin();
  const customer = await createCustomer();
  const campaign = await call('POST', '/api/admin/campaigns', { ...campaignBody(), publish: true }, token, 201);
  const stored = await Campaign.findById(campaign._id);
  await AnalyticsEvent.create([
    { storeId: stored.storeId, name: 'BANNER_IMPRESSION', campaign: stored.key, sessionId: 'one' },
    { storeId: stored.storeId, name: 'BANNER_CLICK', campaign: stored.key, sessionId: 'one' },
  ]);
  await Order.create({
    storeId: stored.storeId, user: customer.user._id, orderItems: [], finalAmount: 1200, couponDiscount: 200,
    coupon: { couponId: campaign.coupon, code: 'FESTIVE20', savingAmount: 200 },
    attribution: { campaign: stored.key, source: 'banner' }, paymentMethod: 'COD', paymentStatus: 'Pending', orderStatus: 'Delivered',
  });
  const detail = await call('GET', `/api/admin/campaigns/${campaign._id}?range=30`, undefined, token);
  assert.equal(detail.performance.impressions, 1);
  assert.equal(detail.performance.clicks, 1);
  assert.equal(detail.performance.orders, 1);
  assert.equal(detail.performance.paidOrders, 1);
  assert.equal(detail.performance.revenue, 1200);
  assert.equal(detail.performance.discountCost, 200);
  assert.equal(detail.performance.uniqueCustomers, 1);
});

test('campaign attribution expires seven days after the campaign ends', async () => {
  const campaign = await Campaign.create({
    key: 'expired-attribution', name: 'Expired attribution', preset: 'FESTIVAL', state: 'PUBLISHED',
    startsAt: new Date(Date.now() - 20 * 86400000), endsAt: new Date(Date.now() - 8 * 86400000),
    offer: { code: 'EXPIRED20' }, creative: { title: 'Expired', image: '/uploads/expired.jpg' },
  });
  const customer = await createCustomer();
  await Order.create({
    user: customer.user._id, orderItems: [], finalAmount: 900, paymentMethod: 'COD', paymentStatus: 'Pending', orderStatus: 'Delivered',
    coupon: { code: 'EXPIRED20', savingAmount: 100 }, attribution: { campaign: campaign.key }, createdAt: new Date(),
  });
  const result = await performanceFor([campaign], {}, 30);
  assert.equal(result[String(campaign._id)].orders, 0);
  assert.equal(result[String(campaign._id)].revenue, 0);
});

test('seller campaign access is tenant scoped and guarded by the festival plan feature', async () => {
  const first = await createProvisionedSeller('First Campaign Store');
  const firstHeaders = { 'x-store-id': first.store.id };
  await call('POST', '/api/seller/campaigns', campaignBody({ name: 'First store campaign' }), first.token, 201, firstHeaders);
  assert.equal((await call('GET', '/api/seller/campaigns?page=1&limit=12', undefined, first.token, 200, firstHeaders)).total, 1);

  const second = await createProvisionedSeller('Second Campaign Store');
  const secondHeaders = { 'x-store-id': second.store.id };
  assert.equal((await call('GET', '/api/seller/campaigns?page=1&limit=12', undefined, second.token, 200, secondHeaders)).total, 0);
  await Store.updateOne({ _id: second.store.id }, { $set: { plan: 'BASIC' } });
  await call('GET', '/api/seller/campaigns?page=1&limit=12', undefined, second.token, 403, secondHeaders);
});
