const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer, createProduct, setSettings, validAddress } = require('./factories');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Review = require('../models/Review');
const StoreMember = require('../models/StoreMember');
const { createProvisionedSeller } = require('./accessFixtures');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(async () => {
  await resetDatabase();
  await setSettings();
});

async function deliverProduct(token, product) {
  const placed = await request('/api/orders/cod', {
    method: 'POST',
    token,
    body: {
      orderItems: [{ product: String(product._id), quantity: 1, size: 'M', color: 'Red' }],
      shippingAddress: validAddress(),
      paymentMethod: 'COD',
    },
  });
  await createAdmin();
  await Order.updateOne({ _id: placed.data._id }, { $set: { orderStatus: 'Delivered', deliveredAt: new Date() } });
  return placed.data._id;
}

test('a review requires a delivered purchase', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });

  const eligibility = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.data.canReview, false);
  assert.equal(eligibility.data.canEdit, false);
  assert.equal(eligibility.data.hasDeliveredPurchase, false);
  assert.equal(eligibility.data.reason, 'DELIVERY_REQUIRED');

  const { status, data } = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 5, comment: 'Lovely fabric' },
  });

  assert.equal(status, 403);
  assert.match(String(data.message), /received this product/i);
});

test('a delivered purchase can submit one review and updates the product rating', async () => {
  const { token } = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(token, product);

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 4, comment: 'Nice drape', title: 'Good buy' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.verifiedPurchase, true);

  const featured = await request('/api/reviews/featured?limit=3');
  assert.equal(featured.status, 200);
  assert.equal(featured.data.length, 1);
  assert.equal(featured.data[0].comment, 'Nice drape');
  assert.equal(featured.data[0].product.name, product.name);
  assert.ok(featured.data[0].user.name);

  const duplicate = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 5, comment: 'Again' },
  });
  assert.equal(duplicate.status, 409);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 4);
});

test('an eligible customer can load and edit their existing review', async () => {
  const { token } = await createCustomer();
  const outsider = await createCustomer();
  const product = await createProduct({ stock: 5 });
  const orderId = await deliverProduct(token, product);

  const before = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.canReview, true);
  assert.equal(before.data.canEdit, false);
  assert.equal(String(before.data.orderId), String(orderId));

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token,
    body: { rating: 2, title: 'Not as expected', comment: 'The fit could be better.' },
  });
  assert.equal(created.status, 201);

  const after = await request(`/api/reviews/${product._id}/eligibility`, { token });
  assert.equal(after.status, 200);
  assert.equal(after.data.canEdit, true);
  assert.equal(after.data.existingReview.title, 'Not as expected');

  const forbiddenEdit = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token: outsider.token,
    body: { rating: 1 },
  });
  assert.equal(forbiddenEdit.status, 403);

  const invalidEdit = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token,
    body: { rating: 6 },
  });
  assert.equal(invalidEdit.status, 400);

  const updated = await request(`/api/reviews/${created.data._id}`, {
    method: 'PUT',
    token,
    body: { rating: 5, title: 'Much better', comment: 'Updating after trying the right size.' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.rating, 5);
  assert.equal(updated.data.title, 'Much better');

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 5);
});

test('public summaries and product ratings exclude reviews hidden by an admin', async () => {
  const first = await createCustomer();
  const second = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(first.token, product);
  await deliverProduct(second.token, product);

  const firstReview = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: first.token,
    body: { rating: 5, comment: 'Excellent quality.' },
  });
  await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: second.token,
    body: { rating: 3, comment: 'Average fit.' },
  });

  const summary = await request(`/api/reviews/${product._id}/summary`);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 });
  assert.equal(summary.data.total, 2);
  assert.equal(summary.data.average, 4);
  assert.equal(summary.data.recommendationPercentage, 50);

  const { token: adminToken } = await createAdmin();
  const hidden = await request(`/api/admin/reviews/${firstReview.data._id}/visibility`, {
    method: 'PATCH',
    token: adminToken,
    body: { isVisible: false },
  });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.data.isVisible, false);

  const publicReviews = await request(`/api/reviews/${product._id}`);
  assert.equal(publicReviews.status, 200);
  assert.equal(publicReviews.data.length, 1);
  assert.equal(publicReviews.data[0].rating, 3);

  const updatedSummary = await request(`/api/reviews/${product._id}/summary`);
  assert.equal(updatedSummary.data.total, 1);
  assert.equal(updatedSummary.data.average, 3);

  const refreshed = await Product.findById(product._id);
  assert.equal(refreshed.numReviews, 1);
  assert.equal(refreshed.rating, 3);
});

test('customers can mark another visible review helpful and toggle it off', async () => {
  const reviewer = await createCustomer();
  const shopper = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(reviewer.token, product);

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST',
    token: reviewer.token,
    body: { rating: 5, comment: 'The fabric and finish are excellent.' },
  });

  const marked = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: shopper.token,
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.helpful, true);
  assert.equal(marked.data.helpfulCount, 1);

  const eligibility = await request(`/api/reviews/${product._id}/eligibility`, { token: shopper.token });
  assert.deepEqual(eligibility.data.helpfulReviewIds, [String(created.data._id)]);

  const ownVote = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: reviewer.token,
  });
  assert.equal(ownVote.status, 403);

  const unmarked = await request(`/api/reviews/${created.data._id}/helpful`, {
    method: 'POST',
    token: shopper.token,
  });
  assert.equal(unmarked.status, 200);
  assert.equal(unmarked.data.helpful, false);
  assert.equal(unmarked.data.helpfulCount, 0);
});

test('unsafe review content is held for moderation and management responses protect customer data', async () => {
  const customer = await createCustomer({ name: 'Asha Customer' });
  const product = await createProduct({ stock: 5 });
  await deliverProduct(customer.token, product);

  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST', token: customer.token,
    body: {
      rating: 4,
      title: 'Lovely fabric',
      comment: 'The fabric is lovely. Call me on 9876543210.',
      photos: ['https://media.example.test/review.webp'],
      aspects: { quality: 5, fit: 4, colorAccuracy: 4 },
      recommend: true,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.moderationStatus, 'PENDING');
  assert.equal(created.data.isVisible, false);
  assert.equal(created.data.riskSignals, undefined);
  assert.deepEqual(created.data.aspects, { quality: 5, fit: 4, colorAccuracy: 4 });

  const publicList = await request(`/api/reviews/${product._id}`);
  assert.equal(publicList.status, 200);
  assert.equal(publicList.data.length, 0);

  const admin = await createAdmin();
  const managed = await request('/api/admin/reviews?page=1&limit=20', { token: admin.token });
  assert.equal(managed.status, 200);
  assert.equal(managed.data.items.length, 1);
  assert.equal(managed.data.items[0].user.name, 'Asha Customer');
  assert.match(managed.data.items[0].user.phoneMasked, /^X{6}\d{4}$/);
  assert.equal(managed.data.items[0].user.phone, undefined);
  assert.equal(managed.data.items[0].user.password, undefined);

  const published = await request(`/api/admin/reviews/management/${created.data._id}/moderation`, {
    method: 'PATCH', token: admin.token, body: { status: 'PUBLISHED' },
  });
  assert.equal(published.status, 200);
  assert.equal(published.data.isVisible, true);

  const replied = await request(`/api/admin/reviews/management/${created.data._id}/reply`, {
    method: 'PUT', token: admin.token, body: { body: 'Thank you for sharing your experience.' },
  });
  assert.equal(replied.status, 200);

  const updatedReply = await request(`/api/admin/reviews/management/${created.data._id}/reply`, {
    method: 'PUT', token: admin.token, body: { body: 'Thank you. Our support team can also help with your order.' },
  });
  assert.equal(updatedReply.status, 200);
  const detail = await request(`/api/admin/reviews/management/${created.data._id}`, { token: admin.token });
  assert.deepEqual(detail.data.merchantReplyHistory.map((item) => item.action), ['PUBLISHED', 'UPDATED']);
  assert.equal(detail.data.merchantReplyHistory[1].body, 'Thank you. Our support team can also help with your order.');

  const options = await request('/api/admin/reviews/management/options', { token: admin.token });
  assert.equal(options.status, 200);
  assert.equal(options.data.some((item) => String(item.id) === String(product._id) && item.reviewCount === 1), true);
  const filtered = await request(`/api/admin/reviews?verified=true&productId=${product._id}&page=1`, { token: admin.token });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.data.items.map((item) => String(item._id)), [String(created.data._id)]);
  const exported = await request(`/api/admin/reviews/management/export?verified=true&productId=${product._id}`, { token: admin.token });
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.data.items.map((item) => String(item._id)), [String(created.data._id)]);
  const stats = await request('/api/admin/reviews/management/stats', { token: admin.token });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.productHealth.some((item) => String(item.productId) === String(product._id) && item.count === 1), true);

  const visible = await request(`/api/reviews/${product._id}`);
  assert.equal(visible.data.length, 1);
  assert.equal(visible.data[0].merchantReply.body, 'Thank you. Our support team can also help with your order.');
  assert.equal(visible.data[0].merchantReply.repliedBy, undefined);
  assert.equal(visible.data[0].merchantReplyHistory, undefined);
});

test('customer reports are deduplicated and repeated reports remove a review from the storefront', async () => {
  const reviewer = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(reviewer.token, product);
  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST', token: reviewer.token, body: { rating: 5, comment: 'Excellent fabric and finish.' },
  });
  const reporters = await Promise.all([createCustomer(), createCustomer(), createCustomer()]);

  const first = await request(`/api/reviews/${created.data._id}/report`, {
    method: 'POST', token: reporters[0].token, body: { reason: 'IRRELEVANT', details: 'This does not describe the product.' },
  });
  assert.equal(first.status, 201);
  const duplicate = await request(`/api/reviews/${created.data._id}/report`, {
    method: 'POST', token: reporters[0].token, body: { reason: 'SPAM' },
  });
  assert.equal(duplicate.status, 409);
  for (const reporter of reporters.slice(1)) {
    const result = await request(`/api/reviews/${created.data._id}/report`, {
      method: 'POST', token: reporter.token, body: { reason: 'SPAM' },
    });
    assert.equal(result.status, 201);
  }

  const hidden = await Review.findById(created.data._id);
  assert.equal(hidden.reportCount, 3);
  assert.equal(hidden.moderationStatus, 'PENDING');
  assert.equal(hidden.isVisible, false);
  const publicList = await request(`/api/reviews/${product._id}`);
  assert.equal(publicList.data.length, 0);

  const admin = await createAdmin();
  const detail = await request(`/api/admin/reviews/management/${created.data._id}`, { token: admin.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.reports.length, 3);
  assert.equal(detail.data.reports.some((report) => report.details === 'This does not describe the product.'), true);
  const reported = await request('/api/admin/reviews?reported=true&page=1', { token: admin.token });
  assert.deepEqual(reported.data.items.map((item) => String(item._id)), [String(created.data._id)]);
});

test('review deletion requires archival and an explicit permanent-delete confirmation', async () => {
  const customer = await createCustomer();
  const product = await createProduct({ stock: 5 });
  await deliverProduct(customer.token, product);
  const created = await request(`/api/reviews/${product._id}`, {
    method: 'POST', token: customer.token, body: { rating: 3, comment: 'Average fit.' },
  });
  const admin = await createAdmin();

  const refused = await request(`/api/admin/reviews/management/${created.data._id}`, { method: 'DELETE', token: admin.token });
  assert.equal(refused.status, 400);
  const archived = await request(`/api/admin/reviews/management/${created.data._id}/archive`, {
    method: 'PATCH', token: admin.token, body: { reason: 'Archived during moderation' },
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.moderationStatus, 'ARCHIVED');
  const removed = await request(`/api/admin/reviews/management/${created.data._id}?confirm=PERMANENTLY_DELETE`, { method: 'DELETE', token: admin.token });
  assert.equal(removed.status, 200);
  assert.equal(await Review.exists({ _id: created.data._id }), null);
});

test('seller review management is isolated to the selected store', async () => {
  const firstSeller = await createProvisionedSeller('First Review Store');
  const secondSeller = await createProvisionedSeller('Second Review Store');
  const customer = await createCustomer({ name: 'Store A Customer' });
  const product = await createProduct({ storeId: firstSeller.store.id });
  const review = await Review.create({
    storeId: firstSeller.store.id,
    user: customer.user._id,
    product: product._id,
    rating: 5,
    title: 'Store A review',
    comment: 'Excellent quality.',
    verifiedPurchase: true,
    isVisible: true,
    moderationStatus: 'PUBLISHED',
  });

  const first = await request('/api/seller/reviews?page=1&limit=20', {
    token: firstSeller.token, headers: { 'x-store-id': firstSeller.store.id },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.items.map((item) => String(item._id)), [String(review._id)]);
  assert.equal(first.data.items[0].user.phone, undefined);
  const ownerExport = await request('/api/seller/reviews/management/export', {
    token: firstSeller.token, headers: { 'x-store-id': firstSeller.store.id },
  });
  assert.equal(ownerExport.status, 200);
  assert.deepEqual(ownerExport.data.items.map((item) => String(item._id)), [String(review._id)]);

  await StoreMember.updateOne({ store: secondSeller.store.id, user: secondSeller.user._id }, { $set: { role: 'CATALOG_MANAGER' } });
  const second = await request('/api/seller/reviews?page=1&limit=20', {
    token: secondSeller.token, headers: { 'x-store-id': secondSeller.store.id },
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.items.length, 0);
  const restrictedExport = await request('/api/seller/reviews/management/export', {
    token: secondSeller.token, headers: { 'x-store-id': secondSeller.store.id },
  });
  assert.equal(restrictedExport.status, 403);
  const blockedDetail = await request(`/api/seller/reviews/management/${review._id}`, {
    token: secondSeller.token, headers: { 'x-store-id': secondSeller.store.id },
  });
  assert.equal(blockedDetail.status, 404);
});
