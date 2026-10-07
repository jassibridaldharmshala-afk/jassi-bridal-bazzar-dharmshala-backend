const mongoose = require('mongoose');
const slugify = require('../utils/slugify');
const VariantGroup = require('../models/VariantGroup');
const Product = require('../models/Product');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { requireObjectId, readPagination, wantsPagination } = require('../utils/validators');
const { andFilter } = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { runInTransaction } = require('../utils/transaction');
const { normalizeProductImages } = require('../utils/imageUtils');
const { applyEffectivePricing } = require('../services/productPricingService');

const MAX_GROUP_MEMBERS = 100;
const MAX_OPTION_DEFINITIONS = 6;
const GROUP_AUDIT_FIELDS = ['name', 'slug', 'baseProduct', 'products', 'optionDefinitions', 'members', 'colors', 'sizes', 'isActive', 'isArchived', 'revision'];
const MANAGEMENT_PRODUCT_FIELDS = '_id name slug sku barcode price originalPrice stock images primaryImage colors sizes category attributeValues variantGroupId variantName variantColor variantSize isActive isArchived publishAt updatedAt';
const PUBLIC_PRODUCT_FIELDS = '_id name slug price originalPrice salePrice saleStartAt saleEndAt stock images primaryImage colors sizes variantGroupId variantName variantColor variantSize isActive isArchived publishAt';

const isManagementRequest = (req) => /^\/api\/(?:admin\/variant-groups|seller)/.test(String(req.baseUrl || ''));
const groupScope = (req, query = {}) => andFilter(query, req.tenantFilter);
const productScope = (req, query = {}) => andFilter(query, req.tenantFilter);

function publicProductVisibility(now = new Date()) {
  return {
    $and: [
      { isActive: true, isArchived: { $ne: true } },
      { $or: [{ publishAt: { $exists: false } }, { publishAt: null }, { publishAt: { $lte: now } }] },
    ],
  };
}

function populateGroup(query, req, management = isManagementRequest(req)) {
  const match = productScope(req, management ? {} : publicProductVisibility());
  const select = management ? MANAGEMENT_PRODUCT_FIELDS : PUBLIC_PRODUCT_FIELDS;
  const descriptor = { match, select, populate: { path: 'category', select: '_id name slug' } };
  return query
    .populate({ path: 'baseProduct', ...descriptor })
    .populate({ path: 'products', ...descriptor })
    .populate({ path: 'members.product', ...descriptor });
}

exports.listGroups = asyncHandler(async (req, res) => {
  const management = isManagementRequest(req);
  const query = buildGroupListQuery(req, management);
  if (!management) {
    const groups = await populateGroup(VariantGroup.find(query).sort('name'), req, false);
    return res.json({ success: true, data: groups.map((group) => formatGroup(group, req, false)) });
  }

  const sort = groupSort(req.query.sort);
  const healthFilter = String(req.query.health || '').trim().toLowerCase();
  if (healthFilter) {
    const all = await populateGroup(VariantGroup.find(query).sort(sort).limit(500), req, true);
    const formatted = all.map((group) => formatGroup(group, req, true));
    const filtered = formatted.filter((group) => healthFilter === 'healthy' ? group.health.state === 'healthy' : group.health.state !== 'healthy');
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 12, maxLimit: 60 });
    return res.json({
      success: true,
      data: filtered.slice(skip, skip + limit),
      meta: { page, limit, total: filtered.length, totalPages: Math.max(1, Math.ceil(filtered.length / limit)), summary: await groupSummary(req) },
    });
  }

  if (wantsPagination(req.query)) {
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 12, maxLimit: 60 });
    const [groups, total, summary] = await Promise.all([
      populateGroup(VariantGroup.find(query).sort(sort).skip(skip).limit(limit), req, true),
      VariantGroup.countDocuments(query),
      groupSummary(req),
    ]);
    return res.json({
      success: true,
      data: groups.map((group) => formatGroup(group, req, true)),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), summary },
    });
  }

  const groups = await populateGroup(VariantGroup.find(query).sort(sort), req, true);
  return res.json({ success: true, data: groups.map((group) => formatGroup(group, req, true)) });
});

exports.listCandidates = asyncHandler(async (req, res) => {
  const { page, limit, skip } = readPagination(req.query, { defaultLimit: 18, maxLimit: 60 });
  const query = productScope(req, { isArchived: { $ne: true } });
  const search = String(req.query.q || '').trim().slice(0, 100);
  if (search) query.$or = [
    { name: { $regex: escapeRegex(search), $options: 'i' } },
    { sku: { $regex: escapeRegex(search), $options: 'i' } },
    { barcode: { $regex: escapeRegex(search), $options: 'i' } },
  ];
  if (req.query.category && mongoose.isValidObjectId(req.query.category)) query.category = req.query.category;
  if (req.query.status === 'active') query.isActive = true;
  if (req.query.status === 'inactive') query.isActive = false;
  if (req.query.stock === 'in') query.stock = { $gt: 0 };
  if (req.query.stock === 'out') query.stock = { $lte: 0 };
  if (req.query.group === 'ungrouped') query.$and = [...(query.$and || []), { $or: [{ variantGroupId: null }, { variantGroupId: { $exists: false } }] }];
  if (req.query.baseProductId && mongoose.isValidObjectId(req.query.baseProductId) && req.query.compatible === 'true') {
    const base = await Product.findOne(productScope(req, { _id: req.query.baseProductId })).select('category industry').lean();
    if (base?.category) query.category = base.category;
    if (base?.industry) query.industry = base.industry;
  }
  const sortMap = { name: 'name', stock: '-stock', newest: '-createdAt', updated: '-updatedAt' };
  const sort = sortMap[req.query.sort] || '-updatedAt';
  const [items, total] = await Promise.all([
    Product.find(query).select(MANAGEMENT_PRODUCT_FIELDS).populate('category', '_id name slug').sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(query),
  ]);
  res.json({ items: items.map((product) => formatProduct(product, req, true)), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

exports.getGroup = asyncHandler(async (req, res) => {
  const management = isManagementRequest(req);
  const id = requireObjectId(req.params.id);
  const visibility = management ? {} : { isActive: true, isArchived: { $ne: true } };
  const group = await populateGroup(VariantGroup.findOne(groupScope(req, { _id: id, ...visibility })), req, management);
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  res.json({ success: true, data: formatGroup(group, req, management) });
});

exports.createGroup = asyncHandler(async (req, res) => {
  const payload = normalizeGroupPayload(req.body);
  if (!payload.name) throw new ApiError('VALIDATION_ERROR', 'Group name is required');
  const groupId = new mongoose.Types.ObjectId();
  const productIds = payload.productIds || [];
  const products = await validateProducts(req, productIds);
  const prepared = prepareConfiguration(payload, products, null);
  validateConfiguration(prepared, products, { strictOptions: Array.isArray(payload.members) });
  await ensureUniqueName(req, prepared.name);
  const transfers = await findTransfers(req, productIds, groupId);
  assertTransfersConfirmed(payload, transfers);

  const group = await mutateSafely(req, groupId, productIds, async (session) => {
    const document = new VariantGroup({
      _id: groupId,
      ...prepared,
      storeId: req.store?._id,
      slug: await ensureUniqueSlug(req, payload.slug || payload.name, groupId, session),
      createdBy: req.user?._id,
      lastSavedBy: req.user?._id,
      revision: 1,
    });
    await syncMembership(req, document, products, [], session);
    await document.save(session ? { session } : undefined);
    return document;
  });

  await logAudit({ req, action: 'VARIANT_GROUP_CREATE', entityType: 'VariantGroup', entityId: group._id, storeId: group.storeId, after: auditSnapshot(group, GROUP_AUDIT_FIELDS) });
  const populated = await populateGroup(VariantGroup.findById(group._id), req, true);
  res.status(201).json({ success: true, message: transfers.length ? 'Variant family created and selected products transferred.' : 'Variant family created successfully.', data: formatGroup(populated, req, true), transfers });
});

exports.updateGroup = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  if (group.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore this variant family before editing it');
  const payload = normalizeGroupPayload(req.body);
  assertRevision(group, payload.baseRevision);
  const oldSnapshot = auditSnapshot(group, GROUP_AUDIT_FIELDS);
  const productIds = payload.productIds === undefined ? group.products.map(String) : payload.productIds;
  const products = await validateProducts(req, productIds);
  const prepared = prepareConfiguration(payload, products, group);
  validateConfiguration(prepared, products, { strictOptions: Array.isArray(payload.members) });
  if (prepared.name !== group.name) await ensureUniqueName(req, prepared.name, group._id);
  const transfers = await findTransfers(req, productIds, group._id);
  assertTransfersConfirmed(payload, transfers);
  const affected = [...new Set([...group.products.map(String), ...productIds])];

  const saved = await mutateSafely(req, group._id, affected, async (session) => {
    const current = await VariantGroup.findOne(groupScope(req, { _id: group._id })).session(session || null);
    if (!current) throw new ApiError('NOT_FOUND', 'Variant group not found');
    assertRevision(current, payload.baseRevision);
    const previousIds = current.products.map(String);
    Object.assign(current, prepared, {
      storeId: current.storeId || req.store?._id,
      slug: await ensureUniqueSlug(req, payload.slug || prepared.name, current._id, session),
      lastSavedBy: req.user?._id,
      revision: Number(current.revision || 0) + 1,
    });
    await syncMembership(req, current, products, previousIds, session);
    await current.save(session ? { session } : undefined);
    return current;
  });

  await logAudit({ req, action: 'VARIANT_GROUP_UPDATE', entityType: 'VariantGroup', entityId: saved._id, storeId: saved.storeId, before: oldSnapshot, after: auditSnapshot(saved, GROUP_AUDIT_FIELDS) });
  const populated = await populateGroup(VariantGroup.findById(saved._id), req, true);
  res.json({ success: true, message: transfers.length ? 'Variant family updated and selected products transferred.' : 'Variant family updated successfully.', data: formatGroup(populated, req, true), transfers });
});

exports.archiveGroup = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  if (group.isArchived) return res.json({ success: true, message: 'Variant family is already archived', data: formatGroup(group, req, true) });
  const before = auditSnapshot(group, GROUP_AUDIT_FIELDS);
  await mutateSafely(req, group._id, group.products.map(String), async (session) => {
    await Product.updateMany(productScope(req, { variantGroupId: group._id }), { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } }, session ? { session } : undefined);
    group.isArchived = true;
    group.isActive = false;
    group.archivedAt = new Date();
    group.revision = Number(group.revision || 0) + 1;
    group.lastSavedBy = req.user?._id;
    await group.save(session ? { session } : undefined);
  });
  await logAudit({ req, action: 'VARIANT_GROUP_ARCHIVE', entityType: 'VariantGroup', entityId: group._id, storeId: group.storeId, before, after: auditSnapshot(group, GROUP_AUDIT_FIELDS) });
  const populated = await populateGroup(VariantGroup.findById(group._id), req, true);
  res.json({ success: true, message: 'Variant family archived. Products remain in the catalog.', data: formatGroup(populated, req, true) });
});

exports.restoreGroup = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  if (!group.isArchived) return res.json({ success: true, message: 'Variant family is already available', data: formatGroup(group, req, true) });
  const products = await Product.find(productScope(req, { _id: { $in: group.products }, isArchived: { $ne: true } })).select(MANAGEMENT_PRODUCT_FIELDS);
  if (!products.length) throw new ApiError('VALIDATION_ERROR', 'No available products remain in this variant family');
  const availableIds = products.map((product) => String(product._id));
  const transfers = await findTransfers(req, availableIds, group._id);
  assertTransfersConfirmed(normalizeGroupPayload(req.body), transfers);
  const before = auditSnapshot(group, GROUP_AUDIT_FIELDS);
  await mutateSafely(req, group._id, group.products.map(String), async (session) => {
    const prepared = prepareConfiguration({ productIds: availableIds, isActive: false }, products, group);
    if (!availableIds.includes(String(prepared.baseProduct))) prepared.baseProduct = products[0]._id;
    Object.assign(group, prepared, { isArchived: false, isActive: false, archivedAt: undefined, revision: Number(group.revision || 0) + 1, lastSavedBy: req.user?._id });
    await syncMembership(req, group, products, [], session);
    await group.save(session ? { session } : undefined);
  });
  await logAudit({ req, action: 'VARIANT_GROUP_RESTORE', entityType: 'VariantGroup', entityId: group._id, storeId: group.storeId, before, after: auditSnapshot(group, GROUP_AUDIT_FIELDS) });
  const populated = await populateGroup(VariantGroup.findById(group._id), req, true);
  res.json({ success: true, message: 'Variant family restored as inactive. Review it before activation.', data: formatGroup(populated, req, true), transfers });
});

exports.deleteGroup = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  if (!group.isArchived) throw new ApiError('VALIDATION_ERROR', 'Archive this variant family before deleting it permanently');
  const confirmation = String(req.query.confirm || '').trim();
  if (![group.name, String(group._id)].includes(confirmation)) throw new ApiError('VALIDATION_ERROR', `Type "${group.name}" to confirm permanent deletion`);
  const before = auditSnapshot(group, GROUP_AUDIT_FIELDS);
  await Product.updateMany(productScope(req, { variantGroupId: group._id }), { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } });
  await VariantGroup.deleteOne(groupScope(req, { _id: group._id }));
  await logAudit({ req, action: 'VARIANT_GROUP_DELETE', entityType: 'VariantGroup', entityId: group._id, storeId: group.storeId, before });
  res.json({ success: true, message: 'Variant family permanently deleted. Products were not deleted.' });
});

exports.addProducts = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  req.body = { ...req.body, productIds: [...new Set([...group.products.map(String), ...normalizeIdArray(req.body.productIds)])], baseRevision: req.body.baseRevision ?? group.revision };
  return exports.updateGroup(req, res);
});

exports.removeProducts = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  const remove = new Set(normalizeIdArray(req.body.productIds));
  req.body = { ...req.body, productIds: group.products.map(String).filter((productId) => !remove.has(productId)), baseRevision: req.body.baseRevision ?? group.revision };
  return exports.updateGroup(req, res);
});

exports.reconcileGroup = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const group = await VariantGroup.findOne(groupScope(req, { _id: id }));
  if (!group) throw new ApiError('NOT_FOUND', 'Variant group not found');
  if (group.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore this variant family before repairing it');
  const products = await Product.find(productScope(req, { _id: { $in: group.products }, isArchived: { $ne: true } })).select(MANAGEMENT_PRODUCT_FIELDS);
  const usable = products.filter((product) => !product.variantGroupId || String(product.variantGroupId) === String(group._id));
  if (!usable.length) throw new ApiError('VALIDATION_ERROR', 'No available products remain in this variant family');
  const prepared = prepareConfiguration({ productIds: usable.map((product) => String(product._id)) }, usable, group);
  if (prepared.isActive && usable.length < 2) prepared.isActive = false;
  if (!usable.some((product) => String(product._id) === String(prepared.baseProduct))) prepared.baseProduct = usable[0]._id;
  const before = auditSnapshot(group, GROUP_AUDIT_FIELDS);
  await mutateSafely(req, group._id, group.products.map(String), async (session) => {
    const previousIds = group.products.map(String);
    Object.assign(group, prepared, { revision: Number(group.revision || 0) + 1, lastSavedBy: req.user?._id });
    await syncMembership(req, group, usable, previousIds, session);
    await group.save(session ? { session } : undefined);
  });
  await logAudit({ req, action: 'VARIANT_GROUP_RECONCILE', entityType: 'VariantGroup', entityId: group._id, storeId: group.storeId, before, after: auditSnapshot(group, GROUP_AUDIT_FIELDS) });
  const populated = await populateGroup(VariantGroup.findById(group._id), req, true);
  res.json({ success: true, message: 'Variant family links checked and repaired.', data: formatGroup(populated, req, true) });
});

exports.getGroupByIdPublic = exports.getGroup;

function normalizeGroupPayload(body = {}) {
  return {
    name: body.name === undefined ? undefined : cleanText(body.name, 120),
    slug: body.slug === undefined ? undefined : cleanText(body.slug, 160),
    baseProduct: body.baseProduct === undefined ? undefined : (body.baseProduct ? requireObjectId(body.baseProduct, 'base product') : ''),
    productIds: body.productIds === undefined && body.members === undefined ? undefined : normalizeIdArray(body.productIds ?? body.members?.map((member) => member?.product || member?.productId)),
    optionDefinitions: body.optionDefinitions === undefined ? undefined : normalizeOptionDefinitions(body.optionDefinitions),
    members: body.members === undefined ? undefined : normalizeMembers(body.members),
    colors: body.colors === undefined ? undefined : splitList(body.colors, 40),
    sizes: body.sizes === undefined ? undefined : splitList(body.sizes, 40),
    isActive: body.isActive === undefined ? undefined : parseBoolean(body.isActive, 'isActive'),
    confirmTransfers: body.confirmTransfers === true || body.confirmTransfers === 'true',
    baseRevision: body.baseRevision === undefined || body.baseRevision === '' ? undefined : Math.max(0, Number.parseInt(body.baseRevision, 10) || 0),
  };
}

function prepareConfiguration(payload, products, existing) {
  const current = existing ? existing.toObject({ flattenMaps: true }) : {};
  const name = payload.name === undefined ? current.name : payload.name;
  if (!name) throw new ApiError('VALIDATION_ERROR', 'Group name is required');
  const productIds = payload.productIds === undefined ? (current.products || []).map(String) : payload.productIds;
  const baseProduct = payload.baseProduct === undefined ? String(current.baseProduct || productIds[0] || '') : payload.baseProduct;
  const optionDefinitions = payload.optionDefinitions === undefined
    ? normalizeOptionDefinitions(current.optionDefinitions || inferOptionDefinitions(products, payload))
    : payload.optionDefinitions;
  const members = resolveMembers(productIds, products, payload.members, current.members, optionDefinitions);
  return {
    name,
    baseProduct: baseProduct || undefined,
    products: productIds,
    optionDefinitions,
    members,
    colors: deriveProductValues(products, members, ['color', 'colour'], 'colors', payload.colors ?? current.colors),
    sizes: deriveProductValues(products, members, ['size'], 'sizes', payload.sizes ?? current.sizes),
    isActive: payload.isActive === undefined ? (current.isActive ?? true) : payload.isActive,
  };
}

function normalizeOptionDefinitions(value) {
  if (!Array.isArray(value)) return [];
  const keys = new Set();
  return value.slice(0, MAX_OPTION_DEFINITIONS).map((entry, index) => {
    const label = cleanText(entry?.label || entry?.key || `Option ${index + 1}`, 80);
    let key = slugify(entry?.key || label).replace(/-/g, '_').slice(0, 60) || `option_${index + 1}`;
    while (keys.has(key)) key = `${key}_${index + 1}`;
    keys.add(key);
    return { key, label, displayType: ['text', 'swatch', 'image'].includes(entry?.displayType) ? entry.displayType : 'text' };
  }).filter((entry) => entry.label);
}

function normalizeMembers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_GROUP_MEMBERS).map((entry, index) => {
    const product = requireObjectId(entry?.product || entry?.productId, 'member product');
    const rawValues = entry?.optionValues instanceof Map ? Object.fromEntries(entry.optionValues) : (entry?.optionValues || {});
    const optionValues = Object.fromEntries(Object.entries(rawValues).slice(0, MAX_OPTION_DEFINITIONS).map(([key, item]) => [slugify(key).replace(/-/g, '_').slice(0, 60), cleanText(item, 100)]));
    return { product, optionValues, swatch: cleanText(entry?.swatch, 120), sortOrder: Math.max(0, Math.min(10000, Number(entry?.sortOrder ?? index) || 0)), isActive: entry?.isActive !== false };
  });
}

function resolveMembers(productIds, products, incoming, existing = [], definitions = []) {
  const incomingMap = new Map((incoming || []).map((member) => [String(member.product), member]));
  const existingMap = new Map((existing || []).map((member) => [String(member.product?._id || member.product), member]));
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  return productIds.map((productId, index) => {
    const source = incomingMap.get(String(productId)) || existingMap.get(String(productId)) || {};
    const currentValues = source.optionValues instanceof Map ? Object.fromEntries(source.optionValues) : (source.optionValues || {});
    const product = productMap.get(String(productId));
    const optionValues = {};
    definitions.forEach((definition) => { optionValues[definition.key] = cleanText(currentValues[definition.key] || inferProductOption(product, definition.key), 100); });
    return { product: productId, optionValues, swatch: cleanText(source.swatch || inferSwatch(product, optionValues), 120), sortOrder: Math.max(0, Math.min(10000, Number(source.sortOrder ?? index) || 0)), isActive: source.isActive !== false };
  });
}

function inferOptionDefinitions(products, payload = {}) {
  const definitions = [];
  const dynamic = new Map();
  products.forEach((product) => {
    const attributes = product.attributeValues instanceof Map ? Object.fromEntries(product.attributeValues) : (product.attributeValues || {});
    Object.entries(attributes).forEach(([key, value]) => {
      if (!value) return;
      const values = dynamic.get(key) || new Set();
      values.add(String(value).trim().toLowerCase());
      dynamic.set(key, values);
    });
  });
  dynamic.forEach((values, key) => { if (values.size > 1 && definitions.length < 3) definitions.push({ key, label: humanize(key), displayType: 'text' }); });
  if (definitions.length) return definitions;
  const colors = deriveProductValues(products, [], ['color', 'colour'], 'colors', payload.colors);
  if (colors.length > 1 || products.some((product) => product.colors?.length)) definitions.push({ key: 'color', label: 'Colour', displayType: 'swatch' });
  const sizes = deriveProductValues(products, [], ['size'], 'sizes', payload.sizes);
  if (sizes.length > 1 && definitions.length < 3) definitions.push({ key: 'size', label: 'Size', displayType: 'text' });
  return definitions.length ? definitions : [{ key: 'style', label: 'Style', displayType: 'image' }];
}

function inferProductOption(product, key) {
  if (!product) return '';
  const normalized = String(key).toLowerCase();
  if (['color', 'colour'].includes(normalized)) return product.variantColor || product.colors?.[0] || '';
  if (normalized === 'size') return product.variantSize || product.sizes?.[0] || '';
  if (normalized === 'style') return product.name || '';
  const attributes = product.attributeValues instanceof Map ? Object.fromEntries(product.attributeValues) : (product.attributeValues || {});
  return attributes[key] || attributes[normalized] || '';
}

function inferSwatch(product, values) {
  const value = values.color || values.colour || product?.variantColor || product?.colors?.[0] || '';
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : '';
}

function validateConfiguration(configuration, products, { strictOptions = true } = {}) {
  const ids = configuration.products.map(String);
  if (!ids.length) throw new ApiError('VALIDATION_ERROR', 'Select at least one product for this variant family');
  if (ids.length > MAX_GROUP_MEMBERS) throw new ApiError('VALIDATION_ERROR', `A variant family can contain up to ${MAX_GROUP_MEMBERS} products`);
  if (new Set(ids).size !== ids.length) throw new ApiError('VALIDATION_ERROR', 'Each product can appear only once in a variant family');
  if (!configuration.baseProduct || !ids.includes(String(configuration.baseProduct))) throw new ApiError('VALIDATION_ERROR', 'Base product must be included in the selected products');
  const base = products.find((product) => String(product._id) === String(configuration.baseProduct));
  if (!base || base.isArchived) throw new ApiError('VALIDATION_ERROR', 'Choose an available base product');
  const activeMembers = configuration.members.filter((member) => member.isActive !== false);
  if (configuration.isActive && activeMembers.length < 2) throw new ApiError('VALIDATION_ERROR', 'An active variant family requires at least two enabled products');
  if (configuration.isActive && !activeMembers.some((member) => String(member.product) === String(configuration.baseProduct))) throw new ApiError('VALIDATION_ERROR', 'The base product must be an enabled storefront choice');
  if (configuration.isActive && base.isActive === false) throw new ApiError('VALIDATION_ERROR', 'Activate the base product before activating this variant family');
  if (configuration.isActive && strictOptions && !configuration.optionDefinitions.length) throw new ApiError('VALIDATION_ERROR', 'Add at least one customer-facing option before activating this variant family');
  if (configuration.isActive && strictOptions && configuration.optionDefinitions.length) {
    const signatures = new Set();
    for (const member of configuration.members.filter((item) => item.isActive !== false)) {
      const values = configuration.optionDefinitions.map((definition) => cleanText(member.optionValues?.[definition.key], 100));
      if (values.some((value) => !value)) throw new ApiError('VALIDATION_ERROR', 'Fill every option value before activating this variant family');
      const signature = values.map((value) => value.toLowerCase()).join('|');
      if (signatures.has(signature)) throw new ApiError('VALIDATION_ERROR', 'Every active product needs a unique option combination');
      signatures.add(signature);
    }
  }
}

async function validateProducts(req, productIds) {
  const ids = normalizeIdArray(productIds);
  const products = await Product.find(productScope(req, { _id: { $in: ids }, isArchived: { $ne: true } })).select(MANAGEMENT_PRODUCT_FIELDS);
  if (products.length !== ids.length) throw new ApiError('VALIDATION_ERROR', 'One or more selected products are unavailable in this store');
  const map = new Map(products.map((product) => [String(product._id), product]));
  return ids.map((id) => map.get(id));
}

async function findTransfers(req, productIds, targetGroupId) {
  if (!productIds.length) return [];
  const products = await Product.find(productScope(req, { _id: { $in: productIds }, variantGroupId: { $exists: true, $nin: [null, targetGroupId] } })).select('_id name variantGroupId').lean();
  const groupIds = [...new Set(products.map((product) => String(product.variantGroupId)))];
  const groups = await VariantGroup.find(groupScope(req, { _id: { $in: groupIds } })).select('_id name').lean();
  const names = new Map(groups.map((group) => [String(group._id), group.name]));
  return products.map((product) => ({ productId: String(product._id), productName: product.name, fromGroupId: String(product.variantGroupId), fromGroupName: names.get(String(product.variantGroupId)) || 'another variant family' }));
}

function assertTransfersConfirmed(payload, transfers) {
  if (transfers.length && !payload.confirmTransfers) throw new ApiError('VARIANT_GROUP_TRANSFER_CONFIRMATION_REQUIRED', 'Some selected products already belong to another variant family', { statusCode: 409, details: { transfers } });
}

async function syncMembership(req, group, products, previousIds, session) {
  const selectedIds = group.products.map(String);
  const removedIds = previousIds.filter((id) => !selectedIds.includes(String(id)));
  const options = session ? { session } : undefined;
  if (removedIds.length) await Product.updateMany(productScope(req, { _id: { $in: removedIds }, variantGroupId: group._id }), { $unset: { variantGroupId: 1, variantName: 1, variantColor: 1, variantSize: 1 } }, options);
  if (!selectedIds.length) return;
  const previousGroups = await VariantGroup.find(groupScope(req, { _id: { $ne: group._id }, products: { $in: selectedIds } })).session(session || null);
  for (const previousGroup of previousGroups) {
    previousGroup.products = previousGroup.products.filter((productId) => !selectedIds.includes(String(productId)));
    previousGroup.members = previousGroup.members.filter((member) => !selectedIds.includes(String(member.product)));
    if (!previousGroup.products.some((productId) => String(productId) === String(previousGroup.baseProduct))) previousGroup.baseProduct = previousGroup.products[0] || undefined;
    if (previousGroup.products.length < 2) previousGroup.isActive = false;
    previousGroup.revision = Number(previousGroup.revision || 0) + 1;
    await previousGroup.save(options);
  }
  const members = new Map(group.members.map((member) => [String(member.product), member]));
  const operations = products.map((product) => {
    const member = members.get(String(product._id));
    const values = member?.optionValues instanceof Map ? Object.fromEntries(member.optionValues) : (member?.optionValues || {});
    return { updateOne: { filter: productScope(req, { _id: product._id }), update: { $set: {
      variantGroupId: group._id,
      variantName: memberLabel(member, product, group.optionDefinitions),
      variantColor: cleanText(values.color || values.colour || '', 100),
      variantSize: cleanText(values.size || '', 100),
    } } } };
  });
  if (operations.length) await Product.bulkWrite(operations, options);
}

async function mutateSafely(req, groupId, affectedProductIds, work) {
  return runInTransaction(async (session) => {
    if (session) return work(session);
    const [groupSnapshots, productSnapshots] = await Promise.all([
      VariantGroup.find(groupScope(req, { $or: [{ _id: groupId }, { products: { $in: affectedProductIds } }] })).lean(),
      Product.find(productScope(req, { $or: [{ _id: { $in: affectedProductIds } }, { variantGroupId: groupId }] })).select('_id variantGroupId variantName variantColor variantSize').lean(),
    ]);
    try {
      return await work(null);
    } catch (error) {
      await restoreSnapshots(req, groupId, groupSnapshots, productSnapshots);
      throw error;
    }
  });
}

async function restoreSnapshots(req, groupId, groups, products) {
  if (!groups.some((group) => String(group._id) === String(groupId))) await VariantGroup.deleteOne(groupScope(req, { _id: groupId })).catch(() => {});
  for (const group of groups) await VariantGroup.replaceOne({ _id: group._id }, group, { upsert: true }).catch(() => {});
  for (const product of products) {
    const set = {};
    const unset = {};
    ['variantGroupId', 'variantName', 'variantColor', 'variantSize'].forEach((key) => { if (product[key] === undefined) unset[key] = 1; else set[key] = product[key]; });
    await Product.updateOne(productScope(req, { _id: product._id }), { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }).catch(() => {});
  }
}

function formatGroup(group, req, management) {
  const data = typeof group.toObject === 'function' ? group.toObject({ flattenMaps: true }) : { ...group };
  const productMap = new Map((data.products || []).filter(Boolean).map((product) => [String(product._id || product.id || product), product]));
  (data.members || []).forEach((member) => { const product = member?.product; if (product && typeof product === 'object') productMap.set(String(product._id || product.id), product); });
  const rawMembers = data.members?.length ? data.members : (data.products || []).map((product, index) => ({ product, optionValues: {}, sortOrder: index, isActive: true }));
  const members = rawMembers.map((member, index) => {
    const productId = String(member?.product?._id || member?.product?.id || member?.product || '');
    const product = member?.product && typeof member.product === 'object' ? member.product : productMap.get(productId);
    if (!product) return management ? { ...member, product: null, productId, missing: true, sortOrder: member.sortOrder ?? index } : null;
    const formattedProduct = formatProduct(product, req, management);
    const values = member.optionValues instanceof Map ? Object.fromEntries(member.optionValues) : (member.optionValues || {});
    return { ...member, product: formattedProduct, productId, optionValues: values, label: memberLabel({ ...member, optionValues: values }, formattedProduct, data.optionDefinitions), sortOrder: member.sortOrder ?? index };
  }).filter(Boolean).filter((member) => management || member.isActive !== false).sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
  const products = members.map((member) => member.product).filter(Boolean);
  const definitions = data.optionDefinitions?.length ? data.optionDefinitions : inferOptionDefinitions(products, data);
  const output = {
    id: String(data._id || data.id), _id: String(data._id || data.id), name: data.name, slug: data.slug,
    baseProduct: data.baseProduct ? formatProduct(data.baseProduct, req, management) : products[0] || null,
    optionDefinitions: definitions, members, products,
    colors: deriveProductValues(products, members, ['color', 'colour'], 'colors', data.colors),
    sizes: deriveProductValues(products, members, ['size'], 'sizes', data.sizes),
    isActive: Boolean(data.isActive), isArchived: Boolean(data.isArchived),
    status: data.isArchived ? 'archived' : data.isActive ? 'active' : 'draft',
    totalStock: products.reduce((sum, product) => sum + Math.max(0, Number(product.stock || 0)), 0),
    inStockCount: products.filter((product) => Number(product.stock || 0) > 0).length,
    updatedAt: data.updatedAt,
  };
  if (management) Object.assign(output, { revision: Number(data.revision || 0), createdAt: data.createdAt, archivedAt: data.archivedAt, health: groupHealth({ ...data, products, members, optionDefinitions: definitions }) });
  return output;
}

function formatProduct(product, req, management) {
  const raw = typeof product?.toObject === 'function' ? product.toObject({ flattenMaps: true }) : { ...(product || {}) };
  const normalized = normalizeProductImages(management ? raw : applyEffectivePricing(raw), req);
  if (normalized.attributeValues instanceof Map) normalized.attributeValues = Object.fromEntries(normalized.attributeValues);
  if (management) return normalized;
  return Object.fromEntries(['_id', 'name', 'slug', 'price', 'effectivePrice', 'basePrice', 'originalPrice', 'discountPercentage', 'stock', 'images', 'primaryImage', 'colors', 'sizes', 'variantGroupId', 'variantName', 'variantColor', 'variantSize'].map((key) => [key, normalized[key]]).filter(([, value]) => value !== undefined));
}

function groupHealth(group) {
  const errors = [];
  const warnings = [];
  const members = group.members || [];
  const products = group.products || [];
  const ids = products.map((product) => String(product?._id || product?.id || '')).filter(Boolean);
  if (ids.length < 2) errors.push('Add at least two products before activation.');
  if (!group.baseProduct || !ids.includes(String(group.baseProduct?._id || group.baseProduct))) errors.push('Choose a base product from this family.');
  if (members.some((member) => member.missing || !member.product)) errors.push('One or more linked products no longer exist.');
  if (products.some((product) => product.isArchived)) errors.push('An archived product is linked to this family.');
  if (products.some((product) => product.isActive === false)) warnings.push('Some products are hidden from the storefront.');
  if (products.some((product) => product.publishAt && new Date(product.publishAt) > new Date())) warnings.push('Some products are scheduled for future publication.');
  if (products.some((product) => product.variantGroupId && String(product.variantGroupId) !== String(group._id))) errors.push('A product link is out of sync.');
  const categories = new Set(products.map((product) => String(product.category?._id || product.category || '')).filter(Boolean));
  if (categories.size > 1) warnings.push('Products from different categories are grouped together.');
  const definitions = group.optionDefinitions || [];
  if (!definitions.length) warnings.push('Add a customer-facing option such as Colour, Storage or Material.');
  const signatures = new Set();
  members.filter((member) => member.isActive !== false && member.product).forEach((member) => {
    const values = member.optionValues || {};
    const signature = definitions.map((definition) => cleanText(values[definition.key], 100).toLowerCase()).join('|');
    if (definitions.length && signature.split('|').some((value) => !value)) errors.push('Some option values are missing.');
    if (signature && signatures.has(signature)) errors.push('Duplicate option combinations need attention.');
    if (signature) signatures.add(signature);
  });
  const uniqueErrors = [...new Set(errors)];
  const uniqueWarnings = [...new Set(warnings)];
  return { state: uniqueErrors.length ? 'needs-attention' : uniqueWarnings.length ? 'review' : 'healthy', score: Math.max(0, 100 - uniqueErrors.length * 25 - uniqueWarnings.length * 8), issues: uniqueErrors, warnings: uniqueWarnings };
}

function buildGroupListQuery(req, management) {
  const status = String(req.query.status || '').toLowerCase();
  const query = management ? status === 'archived' ? { isArchived: true } : status === 'all' ? {} : { isArchived: { $ne: true } } : { isActive: true, isArchived: { $ne: true } };
  if (management && status === 'active') query.isActive = true;
  if (management && ['draft', 'inactive'].includes(status)) query.isActive = false;
  const search = String(req.query.q || '').trim().slice(0, 100);
  if (search) query.$or = [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { slug: { $regex: escapeRegex(search), $options: 'i' } }];
  return groupScope(req, query);
}

function groupSort(value) {
  return ({ oldest: 'createdAt', name: 'name', updated: '-updatedAt' })[value] || '-updatedAt';
}

async function groupSummary(req) {
  const base = req.tenantFilter || {};
  const [total, active, draft, archived] = await Promise.all([
    VariantGroup.countDocuments(andFilter({ isArchived: { $ne: true } }, base)),
    VariantGroup.countDocuments(andFilter({ isArchived: { $ne: true }, isActive: true }, base)),
    VariantGroup.countDocuments(andFilter({ isArchived: { $ne: true }, isActive: false }, base)),
    VariantGroup.countDocuments(andFilter({ isArchived: true }, base)),
  ]);
  return { total, active, draft, archived };
}

async function ensureUniqueName(req, name, excludeId) {
  const duplicate = await VariantGroup.exists(groupScope(req, { name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }));
  if (duplicate) throw new ApiError('DUPLICATE_REQUEST', 'A variant family with this name already exists');
}

async function ensureUniqueSlug(req, base, id, session) {
  const cleanBase = slugify(base || `variant-${id}`) || `variant-${id}`;
  let candidate = cleanBase;
  let suffix = 1;
  while (await VariantGroup.exists(groupScope(req, { slug: candidate, _id: { $ne: id } })).session(session || null)) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  return candidate;
}

function deriveProductValues(products, members, keys, productField, fallback = []) {
  const values = [];
  products.forEach((product) => (product?.[productField] || []).forEach((value) => values.push(cleanText(value, 100))));
  (members || []).forEach((member) => keys.forEach((key) => { if (member?.optionValues?.[key]) values.push(cleanText(member.optionValues[key], 100)); }));
  splitList(fallback, 40).forEach((value) => values.push(value));
  const seen = new Set();
  return values.filter(Boolean).filter((value) => { const key = value.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
}

function memberLabel(member, product, definitions = []) {
  const values = member?.optionValues instanceof Map ? Object.fromEntries(member.optionValues) : (member?.optionValues || {});
  return definitions.map((definition) => values[definition.key]).filter(Boolean).join(' / ') || product?.variantColor || product?.variantSize || product?.name || 'Variant';
}

function normalizeIdArray(value) {
  const input = Array.isArray(value) ? value : value ? String(value).split(',') : [];
  const ids = input.filter(Boolean).map((item) => requireObjectId(item, 'product id'));
  return [...new Set(ids)].slice(0, MAX_GROUP_MEMBERS + 1);
}

function splitList(value, max = 40) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  return list.map((item) => cleanText(item, 100)).filter(Boolean).filter((item) => { const key = item.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, max);
}

function parseBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiError('VALIDATION_ERROR', `${field} must be true or false`);
}

function assertRevision(group, baseRevision) {
  if (baseRevision === undefined) return;
  if (Number(group.revision || 0) !== Number(baseRevision)) throw new ApiError('VARIANT_GROUP_STALE', 'This variant family changed in another session. Reload it before saving.', { statusCode: 409, details: { currentRevision: Number(group.revision || 0), updatedAt: group.updatedAt } });
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function humanize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
