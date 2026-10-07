const Order = require('../models/Order');
const { Booking } = require('../models/Rental');
const Store = require('../models/Store');
const { storeLimit } = require('../config/storePlans');
const { ApiError } = require('../utils/apiError');

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
function rentalMonthFilter(now = new Date()) {
  const start = monthStart(now);
  return {
    status: { $nin: ['HELD', 'CANCELLED', 'EXPIRED'] },
    closedFromStatus: { $nin: ['CANCELLED', 'EXPIRED'] },
    $or: [{ confirmedAt: { $gte: start } }, { confirmedAt: { $exists: false }, createdAt: { $gte: start } }],
  };
}
async function monthlyUsage({ store, allStores = false, session, now = new Date() } = {}) {
  // Keep the established sale counting rule. A pending online sale already
  // reserves its monthly slot; unpaid rental holds do not reserve a slot.
  const scope = allStores || !store?._id ? {} : store.isDefault
    ? { $or: [{ storeId: store._id }, { storeId: null }, { storeId: { $exists: false } }] }
    : { storeId: store._id };
  const sales = Order.countDocuments({ $and: [scope, { createdAt: { $gte: monthStart(now) }, orderStatus: { $ne: 'Cancelled' } }] });
  const rentals = Booking.countDocuments({ $and: [allStores || !store?._id ? {} : { storeId: store._id }, rentalMonthFilter(now)] });
  if (session) { sales.session(session); rentals.session(session); }
  // Do not run parallel operations on the same MongoDB transaction session.
  const saleOrdersPerMonth = await sales;
  const rentalBookingsPerMonth = await rentals;
  return { saleOrdersPerMonth, rentalBookingsPerMonth, ordersPerMonth: saleOrdersPerMonth + rentalBookingsPerMonth };
}
function finiteLimit(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : Infinity;
}
async function assertMonthlyCapacity(store, { session, platform, lock = false } = {}) {
  if (!store?._id) return;
  if (lock && session) {
    // Both sales and rental confirmations write these same fences before
    // counting. Cross-module checkouts cannot spend the last quota twice.
    if (platform?.managed) {
      const root = await Store.findOne({ isDefault: true }).select('_id').session(session).lean();
      if (!root) throw new ApiError('SERVICE_UNAVAILABLE', 'Installation quota tracking is not ready.');
      await Store.updateOne({ _id: root._id }, { $inc: { commerceUsageFence: 1 } }, { session });
    }
    const fresh = await Store.findOneAndUpdate({ _id: store._id }, { $inc: { commerceUsageFence: 1 } }, { new: true, session });
    if (!fresh) throw new ApiError('STORE_REQUIRED', 'Store is no longer available.');
    store = fresh;
  }
  const storeMaximum = finiteLimit(storeLimit(store, 'ordersPerMonth'));
  const usage = await monthlyUsage({ store, session });
  if (usage.ordersPerMonth >= storeMaximum) throw new ApiError('PLAN_LIMIT_REACHED', `This store has reached its ${storeMaximum.toLocaleString('en-IN')} sale orders and confirmed rentals per month limit.`);
  const installationMaximum = platform?.managed ? finiteLimit(platform.limits?.ordersPerMonth) : Infinity;
  if (Number.isFinite(installationMaximum)) {
    const installationUsage = await monthlyUsage({ allStores: true, session });
    if (installationUsage.ordersPerMonth >= installationMaximum) throw new ApiError('PLAN_LIMIT_REACHED', `This installation allows ${installationMaximum.toLocaleString('en-IN')} sale orders and confirmed rentals per month.`);
  }
}
module.exports = { monthStart, rentalMonthFilter, monthlyUsage, assertMonthlyCapacity };
