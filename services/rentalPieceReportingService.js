const M = require('../models/Rental');
const A = require('./rentalAlgorithms');
const X = require('./rentalStudioAlgorithms');
const { ApiError } = require('../utils/apiError');
async function report(store, query) {
  const config = await require('./rentalService').readConfiguration(store);
  if (!config.policy.piecePerformanceEnabled) throw new ApiError('CHECKOUT_RESTRICTED', 'Enable physical-piece performance reports in Rental settings.');
  const from = A.date(query.from), to = A.date(query.to);
  if (+to <= +from || +to > Date.now() + A.DAY || +to - +from > 366 * A.DAY) throw new ApiError('VALIDATION_ERROR', 'Choose a report period up to 366 days, ending no later than tomorrow.');
  const page = A.integer(Number(query.page || 1), 'page', 1, 10000), filter = { storeId: store._id };
  if (query.search) { const search = A.text(query.search, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ code: new RegExp(search, 'i') }, { label: new RegExp(search, 'i') }]; }
  const [assets, total] = await Promise.all([M.Asset.find(filter).sort('code').skip((page - 1) * 30).limit(30).lean(), M.Asset.countDocuments(filter)]);
  const byId = new Map(assets.map(asset => [String(asset._id), { _id: asset._id, code: asset.code, label: asset.label, status: asset.status,
    purchaseCostPaise: asset.costPaise || 0, rentedCount: 0, rentalRevenuePaise: 0, expensesPaise: 0, lifetimeRevenuePaise: 0, lifetimeExpensesPaise: 0, intervals: [], createdAt: asset.createdAt }]));
  for await (const b of M.Booking.find({ storeId: store._id, 'allocations.assetId': { $in: assets.map(a => a._id) }, confirmedAt: { $ne: null },
    $or: [{ status: { $in: ['OUT', 'RETURNED'] } }, { status: 'CLOSED', closedFromStatus: 'RETURNED' }] }).lean().cursor()) {
    const f = A.finances(b);
    let pricedItems = b.quote.items;
    if (b.earlyReturnedAt && b.policy.earlyReturnPolicy === 'ACTUAL_DAYS') {
      const days = Math.max(b.policy.minimumDays, Math.ceil((+new Date(b.earlyReturnedAt) - +new Date(b.schedule.pickupAt)) / A.DAY));
      pricedItems = A.quote(b.quote.items.map(i => ({ listing: { _id: i.listingId, productId: i.productId, title: i.title, components: i.components, ...i.rules }, quantity: i.quantity })), { ...b.schedule, days }, { ...A.DEFAULT_POLICY, ...b.policy }, b.quote.deliveryMode).items;
    }
    const lineRents = pricedItems.map(i => i.rentPaise || 0), rentTotal = lineRents.reduce((n, v) => n + v, 0);
    const nonRentalCharges = b.quote.items.reduce((n, i) => n + (i.feesPaise || 0), 0) + (b.quote.deliveryFeePaise || 0) + (b.quote.returnFeePaise || 0) + (b.cancellationChargesPaise || 0);
    const settled = ['RETURNED', 'CLOSED'].includes(b.status);
    // Exclude refundable deposits, delivery, service fees, tax and assessments.
    const recognisedGrossRent = Math.max(0, Math.min(rentTotal, f.rentalPaise - nonRentalCharges, f.collectedPaise - f.refundedPaise - nonRentalCharges));
    const revenue = settled ? Math.round(recognisedGrossRent * 10000 / (10000 + (b.quote.tax?.basisPoints || 0))) : 0;
    const lineRevenue = X.distribute(revenue, lineRents);
    for (let index = 0; index < b.quote.items.length; index += 1) {
      const pieces = b.allocations.filter(a => String(a.listingId) === String(b.quote.items[index].listingId));
      const shares = X.distribute(lineRevenue[index], pieces.map(() => 1));
      pieces.forEach((piece, pieceIndex) => {
        const row = byId.get(String(piece.assetId)); if (!row) return;
        const start = new Date(b.schedule.pickupAt), end = new Date(piece.receivedAt || piece.lostAt || Date.now());
        const used = +start < +to && +end > +from;
        if (used) { row.rentedCount += 1; row.intervals.push([start, end]); }
        row.lifetimeRevenuePaise += shares[pieceIndex];
        if (settled && +end >= +from && +end < +to) row.rentalRevenuePaise += shares[pieceIndex];
      });
    }
  }
  for await (const task of M.Task.find({ storeId: store._id, assetId: { $in: assets.map(a => a._id) }, $or: [{ actualCostPaise: { $gt: 0 } }, { 'costEvents.0': { $exists: true } }] }).lean().cursor()) {
    const row = byId.get(String(task.assetId)); if (!row) continue;
    row.lifetimeExpensesPaise += task.actualCostPaise;
    for (const cost of task.costEvents?.length ? task.costEvents : [{ deltaPaise: task.actualCostPaise, at: task.costRecordedAt }]) if (+new Date(cost.at) >= +from && +new Date(cost.at) < +to) row.expensesPaise += cost.deltaPaise;
  }
  const rows = [...byId.values()].map(({ intervals, createdAt, ...row }) => {
    const periodFrom = new Date(Math.max(+from, +new Date(createdAt))), periodTo = new Date(Math.min(+to, Date.now()));
    const rentedDays = X.intervalHours(intervals, periodFrom, periodTo) / 24;
    const idleDays = Math.max(0, (+periodTo - +periodFrom) / A.DAY - rentedDays);
    const lifetimeContributionPaise = row.lifetimeRevenuePaise - row.lifetimeExpensesPaise;
    return { ...row, rentedDays, idleDays, operatingContributionPaise: row.rentalRevenuePaise - row.expensesPaise,
      lifetimeContributionPaise, purchaseRecovered: row.purchaseCostPaise > 0 && lifetimeContributionPaise >= row.purchaseCostPaise,
      recoveryPercent: row.purchaseCostPaise > 0 ? Math.round(lifetimeContributionPaise / row.purchaseCostPaise * 100) : null };
  });
  return { from, to, page, total, pages: Math.ceil(total / 30), currency: 'INR', rows,
    note: 'Revenue is recognised on physical return for returned/closed rentals, allocated proportionally by rental line and equally among its physical pieces. Deposits, tax, delivery, service fees and assessments are excluded. Only recorded workshop expenses are deducted. Idle days mean not rented (including maintenance); purchase recovery is lifetime operating contribution, not accounting profit.' };
}
module.exports = { report };
