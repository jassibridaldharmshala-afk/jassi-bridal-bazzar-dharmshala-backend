const mongoose = require('mongoose');
const Product = require('../models/Product');
const { Listing } = require('../models/Rental');
const { ApiError } = require('../utils/apiError');
const B = require('./bridalLookAlgorithms');
const id = value => String(value || '');
function context(query) {
  if (query.mode && !['buy', 'rent'].includes(query.mode)) throw new ApiError('VALIDATION_ERROR', 'Choose Buy or Rental.');
  let raw = {};
  try { if (query.context) { if (typeof query.context !== 'string' || query.context.length > 8000) throw new Error(); raw = JSON.parse(query.context); } } catch { throw new ApiError('VALIDATION_ERROR', 'Invalid look selection.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('VALIDATION_ERROR', 'Invalid look selection.');
  const items = raw.items || [];
  if (!Array.isArray(items) || items.length > 10 || items.some(row => !row || !/^[a-f\d]{24}$/i.test(row.listingId || '') || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 10) || new Set(items.map(row => row.listingId)).size !== items.length) throw new ApiError('VALIDATION_ERROR', 'Invalid rental bag selection.');
  const choices = raw.choices || [];
  if (!Array.isArray(choices) || choices.length > 8 || choices.some(value => !/^[a-f\d]{24}$/i.test(value))) throw new ApiError('VALIDATION_ERROR', 'Invalid accessory option.');
  const selectedItems = raw.selectedItems || [], buyProductIds = raw.buyProductIds || [], selectedBuyProductIds = raw.selectedBuyProductIds || [];
  if (!Array.isArray(selectedItems) || selectedItems.length > 8 || selectedItems.some(row => !row || !/^[a-f\d]{24}$/i.test(row.listingId || '') || row.quantity !== 1) || !Array.isArray(buyProductIds) || buyProductIds.length > 40 || buyProductIds.some(value => !/^[a-f\d]{24}$/i.test(value)) || !Array.isArray(selectedBuyProductIds) || selectedBuyProductIds.length > 8 || selectedBuyProductIds.some(value => !/^[a-f\d]{24}$/i.test(value))) throw new ApiError('VALIDATION_ERROR', 'Invalid selected accessories.');
  for (const field of ['variantId', 'sourceListingId']) if (raw[field] && !/^[a-f\d]{24}$/i.test(raw[field])) throw new ApiError('VALIDATION_ERROR', 'Choose a valid product option.');
  if (raw.useDates !== undefined && (!Array.isArray(raw.useDates) || raw.useDates.length > 90 || raw.useDates.some(day => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)))) throw new ApiError('VALIDATION_ERROR', 'Choose valid use dates.');
  const quantity = raw.quantity === undefined ? 1 : raw.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new ApiError('VALIDATION_ERROR', 'Choose a whole outfit quantity between one and ten.');
  return { ...raw, items: items.map(row => ({ listingId: row.listingId, quantity: row.quantity })), selectedItems, buyProductIds, selectedBuyProductIds, choices, quantity };
}
function saleOptions(product) {
  if (product.commerceMode === 'RENTAL_ONLY') return [];
  const variants = product.variants || [];
  const sizes = require('./productSizingService').getSelectableProductSizes(product);
  return variants.length ? variants.filter(v => v.isActive !== false && v.stock > 0).map(v => ({ id: id(v._id), variantId: id(v._id), size: v.size || '', colour: v.color || '', price: require('./productPricingService').effectiveUnitPrice(product, v), unit: product.lookDetails?.unit || product.attributeValues?.unit || '', mode: 'buy' }))
    : Number(product.stock) > 0 ? (sizes.length ? sizes : ['']).flatMap(size => (product.colors?.length ? product.colors : ['']).map(colour => ({ id: `${size || 'sale'}:${colour}`, size, colour, price: product.salePrice > 0 && (!product.saleStartAt || new Date(product.saleStartAt) <= new Date()) && (!product.saleEndAt || new Date(product.saleEndAt) >= new Date()) ? product.salePrice : product.price, unit: product.lookDetails?.unit || product.attributeValues?.unit || '', mode: 'buy' }))) : [];
}
function includedTypes(product, listing) {
  const result = new Set(product.lookDetails?.includedTypes || []);
  const ownType = B.role(product) || B.role({ name: listing?.title });
  // Set contents need explicit owner data. Styling visible in photos is never inclusion evidence.
  for (const name of [product.attributeValues?.set_contents, listing?.fitting?.includedItems, ...(listing?.requirements?.length > 1 ? listing.requirements.map(r => r.label) : [])].flat().filter(Boolean)) {
    for (const word of String(name).split(/[,;+\n]/)) { const type = B.role({ name: word }); if (type && type !== 'garment' && type !== ownType) result.add(type); }
  }
  return result;
}
function combined(base, addition) {
  const map = new Map(base.map(row => [row.listingId, { ...row }]));
  if (addition && !map.has(addition.listingId)) map.set(addition.listingId, addition);
  return [...map.values()];
}
async function completeLook(req, contracts) {
  const c = context(req.query || {}), key = req.params.slug;
  const [prefs, source] = await Promise.all([
    contracts.preferences(req),
    Product.findOne(contracts.publicFilter({ ...req, commerceFilter: {} }, mongoose.isValidObjectId(key) ? { _id: key } : { slug: key })).select(`${contracts.CARD_FIELDS} completeLookProductIds completeLookBlockedIds`).populate('category', 'name slug definitionKey').maxTimeMS(4000).lean(),
  ]);
  if (!source) throw new ApiError('NOT_FOUND', 'Product not found.');
  const mode = req.query.mode || (source.commerceMode === 'RENTAL_ONLY' || prefs.mode === 'RENTAL_ONLY' ? 'rent' : 'buy');
  if (!prefs.completeLookEnabled) return { enabled: false, products: [] };
  if ((mode === 'buy' && (source.commerceMode === 'RENTAL_ONLY' || prefs.mode === 'RENTAL_ONLY')) || (mode === 'rent' && (!prefs.rentalEnabled || source.commerceMode === 'SALE_ONLY'))) throw new ApiError('NOT_FOUND', 'This product is unavailable in the selected shopping mode.');
  let variant = c.variantId ? source.variants?.find(v => id(v._id) === c.variantId && v.isActive !== false) : null;
  if (c.variantId && !variant) throw new ApiError('VALIDATION_ERROR', 'The selected outfit variant is unavailable.');
  const sourceListing = mode === 'rent' && c.sourceListingId ? await Listing.findOne({ _id: c.sourceListingId, storeId: req.store?._id, productId: source._id, active: true }).lean() : null;
  if (c.sourceListingId && mode === 'rent' && !sourceListing) throw new ApiError('NOT_FOUND', 'The outfit rental offer is unavailable.');
  if (sourceListing?.variantId) variant = source.variants?.find(v => id(v._id) === sourceListing.variantId && v.isActive !== false);
  if (sourceListing?.variantId && !variant) throw new ApiError('NOT_FOUND', 'The outfit rental variant is unavailable.');
  const originalBase = combined(c.items, sourceListing ? { listingId: id(sourceListing._id), quantity: c.quantity } : null);
  const base = c.selectedItems.reduce((items, item) => combined(items, item), originalBase);
  if (base.length > 10) throw new ApiError('VALIDATION_ERROR', 'Your rental bag supports up to ten options.');
  const existing = base.length ? await Listing.find({ _id: { $in: base.map(row => row.listingId) }, storeId: req.store?._id, active: true }).lean() : [];
  if (existing.length !== base.length) throw new ApiError('NOT_FOUND', 'A rental bag item is no longer available. Review your bag.');
  const originalListings = existing.filter(row => originalBase.some(item => item.listingId === id(row._id)));
  const excludedIds = new Set([id(source._id), ...c.buyProductIds, ...(source.completeLookBlockedIds || []).map(id), ...originalListings.map(row => id(row.productId)), ...originalListings.flatMap(row => row.requirements.filter(r => r.productId).map(r => id(r.productId)))]);
  const included = includedTypes(source, sourceListing);
  for (const row of existing) for (const type of includedTypes({}, row)) included.add(type);
  const contentIds = [...c.buyProductIds, ...c.selectedBuyProductIds, ...existing.flatMap(row => [row.productId, ...row.requirements.map(r => r.productId)].filter(Boolean))];
  const contents = contentIds.length ? await Product.find(contracts.publicFilter({ ...req, commerceFilter: {} }, { _id: { $in: contentIds } })).select('lookDetails attributeValues bridalStyle name categoryDefinitionKey').lean() : [];
  for (const p of contents) for (const type of includedTypes(p)) included.add(type);
  const pinned = new Set((source.completeLookProductIds || []).map(id));
  const candidateRequest = { ...req, commerceFilter: {} };
  const kinds = B.candidateKinds(source);
  const categoryIds = await require('../models/Category').find(require('./storeService').andFilter({ isActive: true, isArchived: { $ne: true }, $or: [{ name: kinds.pattern }, { definitionKey: kinds.pattern }] }, req.tenantFilter)).select('_id').limit(1000).maxTimeMS(4000).lean();
  const accessoryFilter = { $or: [{ 'bridalStyle.accessoryType': { $in: kinds.roles } }, { category: { $in: categoryIds.map(row => row._id) } }, { categoryDefinitionKey: kinds.pattern }, { 'attributeValues.product_type': kinds.pattern }, { 'attributeValues.jewellery_type': kinds.pattern }, { subCategory: kinds.pattern }, { name: kinds.pattern }] };
  const [automatic, curated] = await Promise.all([
    Product.find(contracts.publicFilter(candidateRequest, { _id: { $nin: [...excludedIds] }, ...accessoryFilter })).select(contracts.CARD_FIELDS).populate('category', 'name slug definitionKey').sort({ updatedAt: -1, _id: 1 }).limit(240).maxTimeMS(4000).lean(),
    pinned.size ? Product.find(contracts.publicFilter(candidateRequest, { _id: { $in: [...pinned], $nin: [...excludedIds] } })).select(contracts.CARD_FIELDS).populate('category', 'name slug definitionKey').maxTimeMS(4000).lean() : [],
  ]);
  const candidates = [...new Map([...automatic, ...curated].map(p => [id(p._id), p])).values()];
  const matchContext = { variant, selectedColour: variant?.color || sourceListing?.colour || c.colour || '', includedTypes: included };
  const rentalProducts = candidates.filter(p => ['RENTAL_ONLY', 'SALE_AND_RENTAL'].includes(p.commerceMode));
  const rentals = mode === 'rent' && prefs.rentalEnabled && req.store?._id && rentalProducts.length ? await Listing.find({ storeId: req.store._id, productId: { $in: rentalProducts.map(p => p._id) }, active: true }).sort('_id').maxTimeMS(4000).lean() : [];
  const readinessListings = [...new Map([...rentals, ...existing].map(l => [id(l._id), l])).values()];
  const ready = readinessListings.length ? await require('./rentalSetupService').batchReadiness(req.store, readinessListings) : new Map();
  if (sourceListing && !ready.get(id(sourceListing._id))?.ready) throw new ApiError('NOT_FOUND', 'The outfit rental offer is not ready for booking.');
  const rows = [];
  for (const p of candidates) {
    const options = mode === 'rent' ? rentals.filter(l => id(l.productId) === id(p._id) && ready.get(id(l._id))?.ready && (!l.variantId || p.variants?.some(v => id(v._id) === l.variantId && v.isActive !== false))).map(l => ({ id: id(l._id), listingId: id(l._id), variantId: l.variantId || '', size: l.size || '', colour: l.colour || '', dailyRatePaise: l.dailyRatePaise, depositPaise: l.depositPaise, unit: p.lookDetails?.unit || p.attributeValues?.unit || '', mode: 'rent', requirements: l.requirements })) : saleOptions(p);
    const sale = prefs.mode === 'RENTAL_ONLY' ? [] : saleOptions(p);
    // A Buy accessory can accompany a rental, but remains an explicitly separate checkout.
    const chosenOptions = options.length ? options : mode === 'rent' ? sale : [];
    const matched = chosenOptions.map(option => ({ ...option, match: B.match(source, p, { ...matchContext, pinned: pinned.has(id(p._id)), candidateColour: option.colour, candidateVariant: p.variants?.find(v => id(v._id) === option.variantId) }) })).filter(option => option.match && (option.match.group !== 'bangles' || (option.size && !/^free(?:[ -]?size)?$/i.test(option.size)) || /^adjustable$/i.test(p.attributeValues?.adjustability || '') || rentals.find(l => id(l._id) === option.id)?.fitting?.adjustable === true) && !option.requirements?.some(r => r.poolKey && originalListings.some(l => l.requirements.some(part => part.poolKey === r.poolKey))));
    if (!matched.length) continue;
    const preferred = matched.find(o => c.choices.includes(o.id)) || matched[0];
    if (pinned.has(id(p._id))) preferred.match.score += 8 - [...pinned].indexOf(id(p._id));
    rows.push({ ...p, match: preferred.match, look: { group: preferred.match.group, reason: preferred.match.reason, pinned: pinned.has(id(p._id)), mode: preferred.mode, selectedOptionId: preferred.id, options: matched.map(({ match, requirements, ...o }) => ({ ...o, reason: match.reason })), availability: preferred.mode === 'buy' ? 'IN_STOCK' : c.pickupAt && c.returnDueAt && c.useDates?.length ? 'CHECKING' : 'DATES_REQUIRED' } });
  }
  const balanced = B.balance(rows, 12);
  let snapshot, snapshotError;
  const checking = balanced.filter(p => p.look.availability === 'CHECKING');
  if (checking.length) try {
    const S = require('./rentalService'), A = require('./rentalAlgorithms');
    const configuration = await S.readConfiguration(req.store), now = new Date();
    const dates = A.schedule(c, A.validatePolicy(configuration.policy), now);
    const offerIds = checking.map(p => p.look.selectedOptionId);
    const allListings = [...new Map([...existing, ...rentals.filter(l => offerIds.includes(id(l._id)))].map(l => [id(l._id), l])).values()];
    snapshot = await require('./rentalCalendarSnapshot').calendarSnapshot(req.store, allListings, allListings.map(l => ({ listingId: id(l._id), quantity: base.find(i => i.listingId === id(l._id))?.quantity || 1 })), configuration, [dates], now, req.user?._id);
  } catch (error) { snapshotError = error; }
  // One request-local inventory read is shared across advisory suggestions.
  // Final combined quotes and reservations always use the fresh write engine.
  for (const p of balanced) if (p.look.availability === 'CHECKING') {
    const option = p.look.options.find(o => o.id === p.look.selectedOptionId);
    try {
      if (!sourceListing) throw new ApiError('VALIDATION_ERROR', 'Choose the outfit rental option first.');
      if (snapshotError) throw snapshotError;
      const items = combined(base, { listingId: option.listingId, quantity: 1 });
      if (items.length > 10) throw new ApiError('VALIDATION_ERROR', 'Your rental bag supports up to ten options.');
      const view = { ...snapshot, lines: items.map(item => ({ ...snapshot.lines.find(line => id(line.listing._id) === item.listingId), quantity: item.quantity })) };
      await require('./rentalService').publicQuote(req.store, { pickupAt: c.pickupAt, returnDueAt: c.returnDueAt, useDates: c.useDates, deliveryMode: c.deliveryMode, paymentPlan: c.paymentPlan, items }, { includeAvailability: true, calendarSnapshot: view });
      p.look.availability = 'AVAILABLE';
    } catch (error) { p.look.availability = error.errorCode === 'OUT_OF_STOCK' ? 'UNAVAILABLE' : 'CHECK_FAILED'; p.look.availabilityMessage = error.message || 'Availability could not be checked.'; }
  }
  const display = B.balance(balanced.map(p => ({ ...p, match: { ...p.match, score: p.match.score - (['UNAVAILABLE', 'CHECK_FAILED'].includes(p.look.availability) ? 200 : 0) } })));
  return { enabled: true, contractVersion: 'bridal-look-v1', mode, products: display.map(({ match, ...p }) => ({ ...p, discoveryPurchase: p.look.mode === 'rent' ? 'RENTAL' : 'SALE', ...(p.look.mode === 'rent' ? { rentalPreview: { listingId: p.look.selectedOptionId, ...p.look.options.find(o => o.id === p.look.selectedOptionId) } } : {}) })), strategy: pinned.size ? 'OWNER_CURATED' : 'CONTEXT_MATCHED', matchingStrategy: pinned.size ? 'OWNER_AND_CONTEXT_MATCHED' : 'CONTEXT_MATCHED', checkedAt: new Date().toISOString() };
}
module.exports = { completeLook, context, saleOptions, includedTypes, combined };
