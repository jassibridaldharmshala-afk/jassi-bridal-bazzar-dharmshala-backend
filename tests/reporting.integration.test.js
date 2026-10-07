const test = require('node:test');
const assert = require('node:assert/strict');

const { request, resetDatabase, startTestEnvironment, stopTestEnvironment } = require('./helpers');
const { createAdmin, createCustomer } = require('./factories');
const Category = require('../models/Category');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { buildReportCsv, generateBundle } = require('../services/reportExportService');
const { nextRun } = require('../services/reportScheduleService');
const { createReportContext, generateSection, reportRange } = require('../services/reportingService');

test.before(startTestEnvironment);
test.after(stopTestEnvironment);
test.beforeEach(resetDatabase);

test('monthly report schedules stay on the last valid day of the next month', () => {
  assert.equal(nextRun('MONTHLY', new Date(2024, 0, 31, 9, 30)).toISOString(), new Date(2024, 1, 29, 9, 30).toISOString());
});

async function createStore(name, slug) {
  return Store.create({ name, slug, status: 'PUBLISHED', timezone: 'Asia/Kolkata', currency: 'INR' });
}

async function createCatalog(store, name = 'Premium Saree') {
  const category = await Category.create({ storeId: store._id, name: `${name} Category`, slug: `${store.slug}-category` });
  const product = await Product.create({ storeId: store._id, name, slug: `${store.slug}-product`, category: category._id, price: 1200, originalPrice: 1500, costPrice: 500, stock: 10, isActive: true });
  return { category, product };
}

async function createOrder({ store, user, product, category, createdAt, status = 'Confirmed', paymentStatus = 'Paid', paymentState = 'PAID', paymentMethod = 'CARD', finalAmount = 1100, refundedAmount = 0, name = 'Premium Saree' }) {
  return Order.create({
    storeId: store._id, user: user._id, createdAt, updatedAt: createdAt,
    orderItems: [{ product: product._id, category: category._id, categoryName: category.name, name, sku: 'SAR-1', quantity: 1, price: 1200, originalPrice: 1500, costPrice: 500 }],
    shippingAddress: { fullName: user.name, mobile: user.phone, city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    paymentMethod, paymentStatus, paymentState, orderStatus: status,
    totalMRP: 1500, productDiscount: 300, couponDiscount: 100, prepaidDiscount: 0,
    finalAmount, refundedAmount,
  });
}

test('summary and product reports exclude cancelled and other-store orders and reconcile a partial refund', async () => {
  const [storeA, storeB] = await Promise.all([createStore('Store A', 'store-a'), createStore('Store B', 'store-b')]);
  const [{ category: categoryA, product: productA }, { category: categoryB, product: productB }, { user }] = await Promise.all([createCatalog(storeA), createCatalog(storeB, 'Other Product'), createCustomer()]);
  const createdAt = new Date('2024-01-15T06:30:00.000Z');
  await createOrder({ store: storeA, user, product: productA, category: categoryA, createdAt, paymentState: 'PARTIALLY_REFUNDED', refundedAmount: 200 });
  await createOrder({ store: storeA, user, product: productA, category: categoryA, createdAt, status: 'Cancelled', finalAmount: 500 });
  await createOrder({ store: storeA, user, product: productA, category: categoryA, createdAt, status: 'Refunded', paymentStatus: 'Refunded', paymentState: 'REFUNDED', refundedAmount: 1100 });
  await createOrder({ store: storeB, user, product: productB, category: categoryB, createdAt, finalAmount: 900 });

  const context = await createReportContext({ query: { from: '2024-01-15', to: '2024-01-15' }, tenantFilter: { storeId: storeA._id }, store: storeA });
  const [summary, products, customers] = await Promise.all([generateSection('summary', context), generateSection('products', context), generateSection('customers', context)]);

  assert.equal(summary.data.current.orders, 1);
  assert.equal(summary.data.current.paidOrders, 1);
  assert.equal(summary.data.current.bookedValue, 1100);
  assert.equal(summary.data.current.paymentCollected, 2200);
  assert.equal(summary.data.current.refunds, 1300);
  assert.equal(summary.data.current.netCollected, 900);
  assert.equal(summary.data.current.recognizedRevenue, 900);
  assert.equal(summary.data.current.customers, 1);
  assert.equal(summary.data.series[0].net, 900);
  assert.equal(products.data.items.length, 1);
  assert.equal(products.data.items[0].grossItemRevenue, 2400);
  assert.equal(products.data.items[0].allocatedDiscount, 200);
  assert.equal(products.data.items[0].allocatedRefund, 1300);
  assert.equal(products.data.items[0].itemRevenue, 900);
  assert.equal(products.data.items[0].netUnits, 1);
  assert.equal(products.data.items[0].refundedUnits, 1);
  assert.equal(customers.data.topCustomers[0].lifetimeOrders, 1);
  assert.equal(customers.data.topCustomers[0].lifetimeValue, 900);
});

test('custom dates use the store timezone boundary and reject invalid periods', async () => {
  const store = await createStore('Timezone Store', 'timezone-store');
  const { category, product } = await createCatalog(store);
  const { user } = await createCustomer();
  await createOrder({ store, user, product, category, createdAt: new Date('2024-01-14T18:40:00.000Z') }); // 15 Jan 00:10 IST
  await createOrder({ store, user, product, category, createdAt: new Date('2024-01-14T18:20:00.000Z') }); // 14 Jan 23:50 IST
  const context = await createReportContext({ query: { from: '2024-01-15', to: '2024-01-15' }, tenantFilter: { storeId: store._id }, store });
  const summary = await generateSection('summary', context);
  assert.equal(summary.data.current.orders, 1);
  assert.equal(summary.range.fromDate, '2024-01-15');
  assert.equal(summary.range.toDate, '2024-01-15');
  assert.throws(() => reportRange({ from: '2024-01-16', to: '2024-01-15' }, 'Asia/Kolkata'), /end date/i);
  assert.throws(() => reportRange({ range: 'unsupported' }, 'Asia/Kolkata'), /Choose today/i);
});

test('marketing reports expose mobile home section and category engagement per store', async () => {
  const store = await createStore('Mobile Analytics', 'mobile-analytics');
  const other = await createStore('Other Analytics', 'other-analytics');
  const createdAt = new Date('2024-01-15T06:30:00.000Z');
  await AnalyticsEvent.create([
    { storeId: store._id, name: 'HOME_SECTION_VIEW', sessionId: 'a', metadata: { sectionId: 'featured' }, createdAt },
    { storeId: store._id, name: 'HOME_CATEGORY_CLICK', sessionId: 'a', metadata: { categoryId: 'cat-1', categoryName: 'Sarees' }, createdAt },
    { storeId: other._id, name: 'HOME_SECTION_VIEW', sessionId: 'b', metadata: { sectionId: 'private-other-store' }, createdAt },
  ]);
  const context = await createReportContext({ query: { from: '2024-01-15', to: '2024-01-15' }, tenantFilter: { storeId: store._id }, store });
  const marketing = await generateSection('marketing', context);
  assert.ok(marketing.data.homeEngagement.some((row) => row.event === 'HOME_SECTION_VIEW' && row.section === 'featured' && row.value === 1));
  assert.ok(marketing.data.homeEngagement.some((row) => row.event === 'HOME_CATEGORY_CLICK' && row.category === 'Sarees' && row.value === 1));
  assert.equal(marketing.data.homeEngagement.some((row) => row.section === 'private-other-store'), false);
});

test('CSV export contains report sections and neutralizes spreadsheet formulas', async () => {
  const store = await createStore('Export Store', 'export-store');
  const { category, product } = await createCatalog(store, '=IMPORTXML malicious');
  const { user } = await createCustomer();
  await createOrder({ store, user, product, category, createdAt: new Date('2024-01-15T06:30:00.000Z'), name: '=IMPORTXML malicious' });
  const context = await createReportContext({ query: { from: '2024-01-15', to: '2024-01-15' }, tenantFilter: { storeId: store._id }, store });
  const bundle = await generateBundle(context, ['summary', 'products']);
  const csv = buildReportCsv(bundle);
  assert.match(csv, /Financial reconciliation/);
  assert.match(csv, /Inventory position/);
  assert.match(csv, /Product performance/);
  assert.match(csv, /Net units/);
  assert.match(csv, /'\=IMPORTXML malicious/);
});

test('admin can save, update, export and remove a reusable report without email credentials', async () => {
  const { token } = await createAdmin();
  const created = await request('/api/admin/reports/views', { method: 'POST', token, body: { name: 'Monthly review', filters: { range: '30d' }, sections: ['summary', 'products'], schedule: { frequency: 'NONE' } } });
  assert.equal(created.status, 201);
  assert.equal(created.data.name, 'Monthly review');

  const listed = await request('/api/admin/reports/views', { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items.length, 1);

  const updated = await request(`/api/admin/reports/views/${created.data.id}`, { method: 'PUT', token, body: { name: 'Owner monthly review' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.name, 'Owner monthly review');

  const exported = await request('/api/admin/reports/export', { method: 'POST', token, body: { filters: { range: '30d' }, sections: ['summary', 'products'] } });
  assert.equal(exported.status, 200);
  assert.match(exported.data.csv, /Reports & Insights Center/);
  assert.deepEqual(Object.keys(exported.data.bundle.sections), ['summary', 'products']);

  const removed = await request(`/api/admin/reports/views/${created.data.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.equal(await require('../models/ReportView').countDocuments(), 0);
});
