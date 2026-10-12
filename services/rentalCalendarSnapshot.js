const mongoose = require('mongoose');
const M = require('../models/Rental');
const Product = require('../models/Product');
const I = require('./rentalInventoryRules');
const { defaultStoreFilter } = require('./storeService');
const { readinessFromInventory } = require('./rentalSetupService');
const { ApiError } = require('../utils/apiError');

const activeStatuses = ['HELD', 'CONFIRMED', 'PREPARING', 'READY', 'OUT'];
const inventoryKey = (requirement, listing) => JSON.stringify(I.assetFilter(requirement, listing));

// A request-local read model, never a persistent availability cache. Booking
// writes and standalone quotes continue to read fresh data in rentalService.
async function calendarSnapshot(store, listings, items, configuration, dates, now, customerUserId) {
  const productIds = [...new Set(listings.flatMap(l => [l.productId, ...l.requirements.map(r => r.productId)]).filter(Boolean).map(String))];
  const inventory = new Map(listings.flatMap(l => l.requirements.map(r => [inventoryKey(r, l), I.assetFilter(r, l)])));
  const [products, assets] = await Promise.all([
    Product.find({ $and: [store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }, { _id: { $in: productIds } }, I.publishedRentalFilter(now)] }).select('_id variants images').lean(),
    M.Asset.find({ storeId: store._id, $or: inventory.size ? [...inventory.values()] : [{ _id: null }], status: { $nin: ['LOST', 'RETIRED'] } })
      .select('productId variantId size colour poolKey status saleConversion code label returnDueAt currentBookingId').sort('code').lean(),
  ]);
  const readiness = readinessFromInventory(listings, products, assets.filter(a => a.saleConversion == null));
  if (configuration.mode === 'SALE_ONLY' || listings.some(l => !readiness.get(String(l._id)).ready)) throw new ApiError('NOT_FOUND', 'A selected rental offer is unavailable.');
  const byProduct = new Map(products.map(p => [String(p._id), p]));
  const byListing = new Map(listings.map(l => [String(l._id), l]));
  const lines = items.map(item => {
    const listing = byListing.get(item.listingId);
    return { listing: { ...listing, image: byProduct.get(String(listing.productId))?.images?.[0] }, quantity: item.quantity };
  });
  const assetsByInventory = new Map([...inventory].map(([key, filter]) => [key, assets.filter(a => Object.entries(filter).every(([field, value]) => String(a[field]) === String(value))).slice(0, 1000)]));
  const snapshot = { configuration, lines, products: byProduct, now, assetsByInventory, reservations: [], overdueWork: [], slotBookings: [], customerBookings: [], previousListings: [] };
  if (!dates.length) return snapshot;
  const from = new Date(Math.min(...dates.map(d => +d.pickupAt))), until = new Date(Math.max(...dates.map(d => +d.returnDueAt)));
  const blockedFrom = new Date(Math.min(...dates.map(d => +d.blockedFrom))), blockedUntil = new Date(Math.max(...dates.map(d => +d.blockedUntil)));
  const assetIds = [...new Map([...assetsByInventory.values()].flat().map(a => [String(a._id), a._id])).values()];
  const activeBookings = { storeId: store._id, status: { $in: activeStatuses }, $or: [{ status: { $ne: 'HELD' } }, { expiresAt: { $gt: now } }] };
  [snapshot.reservations, snapshot.overdueWork, snapshot.slotBookings, snapshot.customerBookings] = await Promise.all([
    M.Reservation.find({ storeId: store._id, assetId: { $in: assetIds }, active: true, blockedFrom: { $lt: blockedUntil }, blockedUntil: { $gt: blockedFrom }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).select('assetId kind blockedFrom blockedUntil').lean(),
    M.Task.find({ storeId: store._id, assetId: { $in: assetIds }, status: { $in: require('./rentalStudioService').openTasks }, dueAt: { $lte: now } }).select('assetId').lean(),
    M.Booking.find({ ...activeBookings, $and: [{ $or: [
      { 'schedule.pickupAt': { $gte: from, $lte: until } }, { 'schedule.returnDueAt': { $gte: from, $lte: until } },
      { 'trial.at': { $lte: until }, 'trial.until': { $gt: from }, 'trial.status': { $in: ['SCHEDULED', 'ATTENDED'] } },
      { 'trial.at': { $gte: from, $lte: until }, 'trial.status': { $exists: false } },
    ] }] }).select('schedule.pickupAt schedule.returnDueAt trial.at trial.until trial.status').lean(),
    mongoose.isValidObjectId(customerUserId) ? M.Booking.find({ ...activeBookings, userId: customerUserId,
      'schedule.pickupAt': { $lt: until }, 'schedule.returnDueAt': { $gt: from },
      'quote.items': { $elemMatch: { $or: [{ productId: { $in: listings.map(l => String(l.productId)) } }, { listingId: { $in: items.map(i => i.listingId) } }] } },
    }).select('_id number status schedule expiresAt quote.items allocations.listingId allocations.binding').sort('createdAt _id').lean() : [],
  ]);
  if (snapshot.customerBookings.length) snapshot.previousListings = await M.Listing.find({ storeId: store._id,
    _id: { $in: [...new Set(snapshot.customerBookings.flatMap(b => b.quote.items.map(i => i.listingId)))] },
  }).select('_id productId variantId size colour').lean();
  const reservationsByAsset = new Map();
  for (const row of snapshot.reservations) {
    const key = String(row.assetId);
    if (!reservationsByAsset.has(key)) reservationsByAsset.set(key, []);
    reservationsByAsset.get(key).push(row);
  }
  snapshot.conflicts = (pieces, period) => pieces.flatMap(a => (reservationsByAsset.get(String(a._id)) || []).filter(r => +r.blockedFrom < +period.blockedUntil && +r.blockedUntil > +period.blockedFrom));
  return snapshot;
}

module.exports = { calendarSnapshot, inventoryKey };
