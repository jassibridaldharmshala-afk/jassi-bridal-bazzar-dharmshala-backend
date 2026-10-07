const { asyncHandler } = require('../middleware/validate');
const service = require('../services/controlPlaneClient');
const { STORE_PLANS } = require('../config/storePlans');
const Product = require('../models/Product');
const Order = require('../models/Order');

async function localUsage() {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [products, ordersPerMonth] = await Promise.all([
    Product.countDocuments({ isArchived: { $ne: true } }),
    Order.countDocuments({ createdAt: { $gte: monthStart }, orderStatus: { $ne: 'Cancelled' } }),
  ]);
  return { products, ordersPerMonth };
}

async function sendStatus(req, res, force) {
  res.setHeader('Cache-Control', 'no-store');
  const status = service.publicStatus(await service.licenseStatus({ force }));
  const serverNow = new Date().toISOString();
  // The admin notice does not need catalogue counts, plan pricing or release
  // records. Keep its background checks lightweight and private.
  if (req.query.summary === '1') return res.json({
    managed: status.managed, installationId: status.installationId,
    companyName: status.companyName, status: status.status, plan: status.plan,
    billingCycle: status.billingCycle, endsAt: status.endsAt,
    renewalMessage: status.renewalMessage, platformReachable: status.platformReachable,
    issuedAt: status.issuedAt, serverNow,
  });
  return res.json({ ...status, serverNow, plans: status.plans.length ? status.plans : Object.values(STORE_PLANS), usage: status.managed ? await localUsage() : {}, checkout: { configured: status.managed && status.checkoutConfigured } });
}

exports.status = asyncHandler(async (req, res) => sendStatus(req, res, false));
exports.refresh = asyncHandler(async (req, res) => sendStatus(req, res, true));

exports.checkout = asyncHandler(async (req, res) => res.json(await service.subscriptionCheckout(req.body || {})));
exports.verify = asyncHandler(async (req, res) => {
  const result = await service.subscriptionVerify(req.body || {});
  await service.licenseStatus({ force: true }).catch(() => null);
  res.json(result);
});
