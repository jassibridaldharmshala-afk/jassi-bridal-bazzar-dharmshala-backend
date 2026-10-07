const mongoose = require('mongoose');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductDraft = require('../models/ProductDraft');
const Coupon = require('../models/Coupon');
const slugify = require('../utils/slugify');
const { deleteImageFromR2, isR2Configured } = require('../services/r2Upload');
const { andFilter } = require('../services/storeService');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { isMasterOwner } = require('../config/masterOwner');

const CATEGORY_AUDIT_FIELDS = ['name', 'slug', 'parent', 'level', 'definitionKey', 'description', 'image', 'socialImage', 'metaTitle', 'metaDescription', 'displayOrder', 'isActive', 'isArchived', 'archivedAt'];
const EDITABLE_FIELDS = ['name', 'slug', 'parent', 'definitionKey', 'description', 'image', 'socialImage', 'metaTitle', 'metaDescription', 'displayOrder', 'isActive'];

function withStoreId(payload, req) {
  const next = { ...payload };
  delete next.storeId;
  if (req.store?._id) next.storeId = req.store._id;
  return next;
}

function scoped(req, query = {}) {
  return andFilter(query, req.tenantFilter);
}

function isPrivateRequest(req) {
  return /^\/api\/(admin|seller)(\/|$)/.test(req.baseUrl || '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textValue(value, max, label, { required = false } = {}) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (required && cleaned.length < 2) throw new ApiError('VALIDATION_ERROR', `${label} is required`);
  if (cleaned.length > max) throw new ApiError('VALIDATION_ERROR', `${label} must be ${max} characters or fewer`);
  return cleaned;
}

function imageUrl(value, label) {
  const cleaned = textValue(value, 1000, label);
  if (/^data:/i.test(cleaned)) throw new ApiError('VALIDATION_ERROR', `${label} must be an uploaded file URL`);
  if (cleaned && !/^(https?:\/\/|\/uploads\/)/i.test(cleaned)) throw new ApiError('VALIDATION_ERROR', `${label} must use an uploaded HTTPS or local media URL`);
  return cleaned;
}

function definitionKey(value) {
  const cleaned = textValue(value, 50, 'Product template').toLowerCase();
  if (cleaned && !/^[a-z][a-z0-9_]{0,49}$/.test(cleaned)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid product field template');
  return cleaned;
}

function normalizeDisplayOrder(value, fallback = 0) {
  if (value === undefined) return fallback;
  const order = Number(value);
  if (!Number.isInteger(order) || order < 0 || order > 9999) {
    throw new ApiError('VALIDATION_ERROR', 'Display order must be a whole number from 0 to 9999');
  }
  return order;
}

function requestedPayload(body = {}) {
  return Object.fromEntries(EDITABLE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));
}

async function categoryImpact(category, req) {
  const categoryId = category._id;
  const [productCount, activeProductCount, draftCount, couponCount, childCount] = await Promise.all([
    Product.countDocuments(scoped(req, { category: categoryId })),
    Product.countDocuments(scoped(req, { category: categoryId, isArchived: { $ne: true }, isActive: true })),
    ProductDraft.countDocuments(scoped(req, { category: categoryId })),
    Coupon.countDocuments(scoped(req, { applicableCategories: categoryId })),
    Category.countDocuments(scoped(req, { parent: categoryId })),
  ]);
  return {
    productCount, activeProductCount, draftCount, couponCount, childCount,
    canDelete: productCount === 0 && draftCount === 0 && couponCount === 0 && childCount === 0,
  };
}

async function enrichCategories(categories, req) {
  if (!categories.length) return [];
  const ids = categories.map((category) => category._id);
  const [products, drafts, children] = await Promise.all([
    Product.aggregate([
      { $match: scoped(req, { category: { $in: ids } }) },
      { $group: { _id: '$category', productCount: { $sum: 1 }, activeProductCount: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $ne: ['$isArchived', true] }] }, 1, 0] } } } },
    ]),
    ProductDraft.aggregate([
      { $match: scoped(req, { category: { $in: ids } }) },
      { $group: { _id: '$category', draftCount: { $sum: 1 } } },
    ]),
    Category.aggregate([
      { $match: scoped(req, { parent: { $in: ids } }) },
      { $group: { _id: '$parent', childCount: { $sum: 1 } } },
    ]),
  ]);
  const productMap = new Map(products.map((item) => [String(item._id), item]));
  const draftMap = new Map(drafts.map((item) => [String(item._id), item.draftCount]));
  const childMap = new Map(children.map((item) => [String(item._id), item.childCount]));
  return categories.map((category) => {
    const data = category.toObject ? category.toObject() : category;
    const counts = productMap.get(String(data._id)) || {};
    return {
      ...data,
      productCount: Number(counts.productCount || 0),
      activeProductCount: Number(counts.activeProductCount || 0),
      draftCount: Number(draftMap.get(String(data._id)) || 0),
      childCount: Number(childMap.get(String(data._id)) || 0),
    };
  });
}

async function assertUniqueCategory({ name, slug, parent, excludeId }, req) {
  const excluding = excludeId ? { _id: { $ne: excludeId } } : {};
  if (await Category.exists(scoped(req, { ...excluding, $or: [{ slug }, { previousSlugs: slug }] }))) {
    throw new ApiError('DUPLICATE_REQUEST', 'A category with this slug already exists');
  }
  const duplicateName = await Category.exists(scoped(req, {
    ...excluding,
    parent: parent || null,
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    isArchived: { $ne: true },
  }));
  if (duplicateName) throw new ApiError('DUPLICATE_REQUEST', 'A category with this name already exists at the selected level');
}

async function descendantsOf(categoryId, req) {
  const result = [];
  let frontier = [{ id: categoryId, depth: 0 }];
  const visited = new Set([String(categoryId)]);
  while (frontier.length) {
    const parentIds = frontier.map((item) => item.id);
    const depthByParent = new Map(frontier.map((item) => [String(item.id), item.depth]));
    const children = await Category.find(scoped(req, { parent: { $in: parentIds } })).select('_id parent').lean();
    const next = [];
    for (const child of children) {
      const key = String(child._id);
      if (visited.has(key)) continue;
      visited.add(key);
      const depth = Number(depthByParent.get(String(child.parent)) || 0) + 1;
      const item = { id: child._id, depth };
      result.push(item);
      next.push(item);
    }
    frontier = next;
  }
  return result;
}

async function resolveParent(parentId, category, req) {
  if (!parentId) return { parent: null, level: 0, parentDefinitionKey: '' };
  if (!mongoose.isValidObjectId(parentId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid parent category');
  if (category && String(parentId) === String(category._id)) throw new ApiError('VALIDATION_ERROR', 'A category cannot be its own parent');
  const parent = await Category.findOne(scoped(req, { _id: parentId, isArchived: { $ne: true } }));
  if (!parent) throw new ApiError('VALIDATION_ERROR', 'Choose an available parent category from this store');
  if (Number(parent.level || 0) >= 5) throw new ApiError('VALIDATION_ERROR', 'Category hierarchy can contain at most 6 levels');
  if (category) {
    const descendants = await descendantsOf(category._id, req);
    if (descendants.some((item) => String(item.id) === String(parent._id))) {
      throw new ApiError('VALIDATION_ERROR', 'A category cannot be moved inside one of its subcategories');
    }
    const subtreeDepth = descendants.reduce((maximum, item) => Math.max(maximum, item.depth), 0);
    if (Number(parent.level || 0) + 1 + subtreeDepth > 5) throw new ApiError('VALIDATION_ERROR', 'Category hierarchy can contain at most 6 levels');
  }
  return { parent: parent._id, level: Number(parent.level || 0) + 1, parentDefinitionKey: parent.definitionKey || '' };
}

async function assertVisibleParent(parentId, isActive, req) {
  if (!parentId || !isActive) return;
  const parent = await Category.findOne(scoped(req, { _id: parentId })).select('isActive isArchived').lean();
  if (!parent || parent.isArchived || !parent.isActive) throw new ApiError('VALIDATION_ERROR', 'Make the parent category visible first');
}

async function updateDescendantLevels(category, req) {
  let frontier = [{ id: category._id, level: category.level }];
  while (frontier.length) {
    const parentIds = frontier.map((item) => item.id);
    const levels = new Map(frontier.map((item) => [String(item.id), item.level]));
    const children = await Category.find(scoped(req, { parent: { $in: parentIds } }));
    if (!children.length) break;
    for (const child of children) child.level = Number(levels.get(String(child.parent)) || 0) + 1;
    await Promise.all(children.map((child) => child.save()));
    frontier = children.map((child) => ({ id: child._id, level: child.level }));
  }
}

exports.getCategories = asyncHandler(async (req, res) => {
  const requestedStoreId = String(req.query.storeId || '').trim();
  if (requestedStoreId && isMasterOwner(req.user)) {
    if (!mongoose.isValidObjectId(requestedStoreId)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid store');
    req.tenantFilter = { storeId: requestedStoreId };
  }
  const privateRequest = isPrivateRequest(req);
  const archiveMode = String(req.query.archive || '').toLowerCase();
  const visibility = privateRequest
    ? archiveMode === 'only' ? { isArchived: true } : archiveMode === 'all' ? {} : { isArchived: { $ne: true } }
    : { isActive: true, isArchived: { $ne: true } };
  const categories = await Category.find(scoped(req, visibility)).populate('parent', 'name slug isActive isArchived').sort('level displayOrder name');
  res.json(privateRequest ? await enrichCategories(categories, req) : categories);
});

exports.getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id })).populate('parent', 'name slug isActive isArchived');
  if (!category) return res.status(404).json({ message: 'Category not found' });
  res.json({ ...category.toObject(), ...(await categoryImpact(category, req)) });
});

exports.getCategoryImpact = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  res.json({ category: { _id: category._id, name: category.name, isArchived: category.isArchived }, ...(await categoryImpact(category, req)) });
});

exports.createCategory = asyncHandler(async (req, res) => {
  const source = requestedPayload(req.body);
  const name = textValue(source.name, 80, 'Category name', { required: true });
  const slug = slugify(source.slug || name);
  if (!slug) throw new ApiError('VALIDATION_ERROR', 'Enter a category name that can create a valid URL');
  const hierarchy = await resolveParent(source.parent, null, req);
  await assertVisibleParent(hierarchy.parent, source.isActive !== false, req);
  await assertUniqueCategory({ name, slug, parent: hierarchy.parent }, req);
  const payload = withStoreId({
    ...source,
    ...hierarchy,
    name,
    slug,
    definitionKey: definitionKey(source.definitionKey),
    description: textValue(source.description, 1200, 'Description'),
    image: imageUrl(source.image, 'Category image'),
    socialImage: imageUrl(source.socialImage, 'Social image'),
    metaTitle: textValue(source.metaTitle, 100, 'SEO title'),
    metaDescription: textValue(source.metaDescription, 300, 'SEO description'),
    displayOrder: normalizeDisplayOrder(source.displayOrder),
    isActive: source.isActive !== false,
    isArchived: false,
    archivedAt: null,
  }, req);
  const category = await Category.create(payload);
  await logAudit({ req, action: 'CATEGORY_CREATE', entityType: 'Category', entityId: category._id, storeId: category.storeId, after: auditSnapshot(category, CATEGORY_AUDIT_FIELDS) });
  res.status(201).json(category);
});

exports.updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  const source = requestedPayload(req.body);
  const removeImage = req.body.removeImage === true;
  const removeSocialImage = req.body.removeSocialImage === true;
  const before = auditSnapshot(category, CATEGORY_AUDIT_FIELDS);
  const name = source.name === undefined ? category.name : textValue(source.name, 80, 'Category name', { required: true });
  const slug = source.slug === undefined ? category.slug : slugify(source.slug || name);
  if (!slug) throw new ApiError('VALIDATION_ERROR', 'Enter a category name that can create a valid URL');
  const hierarchy = source.parent === undefined
    ? { parent: category.parent || null, level: category.level || 0, parentDefinitionKey: category.parentDefinitionKey || '' }
    : await resolveParent(source.parent, category, req);
  await assertVisibleParent(hierarchy.parent, source.isActive === undefined ? category.isActive : source.isActive, req);
  await assertUniqueCategory({ name, slug, parent: hierarchy.parent, excludeId: category._id }, req);
  if (slug !== category.slug) category.previousSlugs = [...new Set([...(category.previousSlugs || []), category.slug])].slice(-10);
  const oldImage = category.image || '';
  const oldSocialImage = category.socialImage || '';
  const nextImage = source.image === undefined ? undefined : imageUrl(source.image, 'Category image');
  const nextSocialImage = source.socialImage === undefined ? undefined : imageUrl(source.socialImage, 'Social image');
  const sourceWithoutMedia = { ...source };
  delete sourceWithoutMedia.image;
  delete sourceWithoutMedia.socialImage;
  Object.assign(category, {
    ...sourceWithoutMedia,
    ...hierarchy,
    name,
    slug,
    ...(source.definitionKey !== undefined ? { definitionKey: definitionKey(source.definitionKey) } : {}),
    ...(source.description !== undefined ? { description: textValue(source.description, 1200, 'Description') } : {}),
    ...(removeImage ? { image: '' } : nextImage ? { image: nextImage } : {}),
    ...(removeSocialImage ? { socialImage: '' } : nextSocialImage ? { socialImage: nextSocialImage } : {}),
    ...(source.metaTitle !== undefined ? { metaTitle: textValue(source.metaTitle, 100, 'SEO title') } : {}),
    ...(source.metaDescription !== undefined ? { metaDescription: textValue(source.metaDescription, 300, 'SEO description') } : {}),
    ...(source.displayOrder !== undefined ? { displayOrder: normalizeDisplayOrder(source.displayOrder, category.displayOrder) } : {}),
  });
  if (category.isArchived) category.isActive = false;
  await category.save();
  if (source.parent !== undefined) await updateDescendantLevels(category, req);
  if (oldImage && oldImage !== category.image && oldImage !== category.socialImage) await safeDeleteCategoryImageIfUnused(oldImage);
  if (oldSocialImage && oldSocialImage !== category.socialImage && oldSocialImage !== category.image && oldSocialImage !== oldImage) await safeDeleteCategoryImageIfUnused(oldSocialImage);
  await logAudit({ req, action: 'CATEGORY_UPDATE', entityType: 'Category', entityId: category._id, storeId: category.storeId, before, after: auditSnapshot(category, CATEGORY_AUDIT_FIELDS) });
  res.json(category);
});

exports.updateCategoryStatus = asyncHandler(async (req, res) => {
  if (typeof req.body.isActive !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Choose whether this category is visible');
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  if (req.body.isActive && category.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore this category before making it visible');
  if (req.body.isActive && category.parent) {
    const parent = await Category.findOne(scoped(req, { _id: category.parent }));
    if (!parent || parent.isArchived || !parent.isActive) throw new ApiError('VALIDATION_ERROR', 'Make the parent category visible first');
  }
  const before = { isActive: category.isActive };
  category.isActive = req.body.isActive;
  await category.save();
  let hiddenChildren = 0;
  if (!category.isActive) {
    const descendants = await descendantsOf(category._id, req);
    if (descendants.length) {
      const result = await Category.updateMany(scoped(req, { _id: { $in: descendants.map((item) => item.id) } }), { $set: { isActive: false } });
      hiddenChildren = Number(result.modifiedCount || 0);
    }
  }
  await logAudit({ req, action: 'CATEGORY_VISIBILITY_UPDATE', entityType: 'Category', entityId: category._id, storeId: category.storeId, before, after: { isActive: category.isActive, hiddenChildren } });
  res.json(category);
});

exports.archiveCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  const descendants = await descendantsOf(category._id, req);
  const ids = [category._id, ...descendants.map((item) => item.id)];
  const archivedAt = new Date();
  await Category.updateMany(scoped(req, { _id: { $in: ids } }), { $set: { isActive: false, isArchived: true, archivedAt } });
  await logAudit({ req, action: 'CATEGORY_ARCHIVE', entityType: 'Category', entityId: category._id, storeId: category.storeId, before: auditSnapshot(category, CATEGORY_AUDIT_FIELDS), after: { isActive: false, isArchived: true, archivedChildren: descendants.length } });
  res.json({ message: descendants.length ? `Category and ${descendants.length} subcategories archived` : 'Category archived', archivedIds: ids });
});

exports.restoreCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  if (category.parent) {
    const parent = await Category.findOne(scoped(req, { _id: category.parent }));
    if (!parent || parent.isArchived) throw new ApiError('VALIDATION_ERROR', 'Restore the parent category first');
  }
  const before = { isArchived: category.isArchived, archivedAt: category.archivedAt, isActive: category.isActive };
  category.isArchived = false;
  category.archivedAt = null;
  category.isActive = false;
  await category.save();
  await logAudit({ req, action: 'CATEGORY_RESTORE', entityType: 'Category', entityId: category._id, storeId: category.storeId, before, after: { isArchived: false, archivedAt: null, isActive: false } });
  res.json(category);
});

exports.reassignCategory = asyncHandler(async (req, res) => {
  const source = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!source) return res.status(404).json({ message: 'Category not found' });
  const targetId = req.body.targetCategoryId;
  if (!mongoose.isValidObjectId(targetId) || String(targetId) === String(source._id)) throw new ApiError('VALIDATION_ERROR', 'Choose a different destination category');
  const target = await Category.findOne(scoped(req, { _id: targetId, isArchived: { $ne: true } }));
  if (!target) throw new ApiError('VALIDATION_ERROR', 'Choose an available destination category from this store');
  const couponIds = await Coupon.find(scoped(req, { applicableCategories: source._id })).distinct('_id');
  const [products, drafts] = await Promise.all([
    Product.updateMany(scoped(req, { category: source._id }), { $set: { category: target._id } }),
    ProductDraft.updateMany(scoped(req, { category: source._id }), { $set: { category: target._id } }),
  ]);
  if (couponIds.length) {
    await Coupon.updateMany(scoped(req, { _id: { $in: couponIds } }), { $pull: { applicableCategories: source._id } });
    await Coupon.updateMany(scoped(req, { _id: { $in: couponIds } }), { $addToSet: { applicableCategories: target._id } });
  }
  source.isActive = false;
  source.isArchived = true;
  source.archivedAt = new Date();
  await source.save();
  const descendants = await descendantsOf(source._id, req);
  if (descendants.length) {
    await Category.updateMany(scoped(req, { _id: { $in: descendants.map((item) => item.id) } }), { $set: { isActive: false, isArchived: true, archivedAt: source.archivedAt } });
  }
  const moved = { products: Number(products.modifiedCount || 0), drafts: Number(drafts.modifiedCount || 0), coupons: couponIds.length };
  await logAudit({ req, action: 'CATEGORY_REASSIGN', entityType: 'Category', entityId: source._id, storeId: source.storeId, before: { destination: null, isArchived: false }, after: { destination: target._id, isArchived: true, moved } });
  res.json({ message: `Items moved to ${target.name}; ${source.name} was archived`, moved, category: source });
});

exports.reorderCategories = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 150) throw new ApiError('VALIDATION_ERROR', 'Choose between 1 and 150 categories to reorder');
  const ids = items.map((item) => item?.id);
  if (new Set(ids.map(String)).size !== ids.length || ids.some((id) => !mongoose.isValidObjectId(id))) throw new ApiError('VALIDATION_ERROR', 'Category order contains an invalid or duplicate category');
  const normalized = items.map((item) => ({ id: item.id, displayOrder: normalizeDisplayOrder(item.displayOrder) }));
  const owned = await Category.find(scoped(req, { _id: { $in: ids } })).select('_id storeId').lean();
  if (owned.length !== ids.length) throw new ApiError('VALIDATION_ERROR', 'One or more categories no longer belong to this store');
  await Category.bulkWrite(normalized.map((item) => ({ updateOne: { filter: scoped(req, { _id: item.id }), update: { $set: { displayOrder: item.displayOrder } } } })));
  await logAudit({ req, action: 'CATEGORY_REORDER', entityType: 'Category', entityId: 'multiple', storeId: req.store?._id, after: { count: normalized.length } });
  res.json({ message: 'Category order updated', items: normalized });
});

exports.deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOne(scoped(req, { _id: req.params.id }));
  if (!category) return res.status(404).json({ message: 'Category not found' });
  if (!category.isArchived) throw new ApiError('CATEGORY_IN_USE', 'Archive this category before permanently deleting it');
  if (String(req.query.confirm || '').trim().toLowerCase() !== category.name.trim().toLowerCase()) {
    throw new ApiError('VALIDATION_ERROR', 'Type the category name to confirm permanent deletion');
  }
  const impact = await categoryImpact(category, req);
  if (!impact.canDelete) throw new ApiError('CATEGORY_IN_USE', 'Move linked products, drafts, coupons and subcategories before permanently deleting this category', { details: impact });
  const snapshot = auditSnapshot(category, CATEGORY_AUDIT_FIELDS);
  const deleted = await Category.findOneAndDelete(scoped(req, { _id: category._id }));
  if (!deleted) return res.status(404).json({ message: 'Category not found' });
  if (category.image) await safeDeleteCategoryImageIfUnused(category.image);
  if (category.socialImage && category.socialImage !== category.image) await safeDeleteCategoryImageIfUnused(category.socialImage);
  await logAudit({ req, action: 'CATEGORY_DELETE', entityType: 'Category', entityId: category._id, storeId: category.storeId, before: snapshot });
  res.json({ message: 'Category permanently deleted' });
});

async function safeDeleteCategoryImage(image) {
  if (!isR2Configured()) return;
  try {
    await deleteImageFromR2(image);
  } catch {
    // Media cleanup is best-effort and never rolls back a saved category change.
  }
}

async function safeDeleteCategoryImageIfUnused(image) {
  const stillUsed = await Category.exists({ $or: [{ image }, { socialImage: image }] });
  if (!stillUsed) await safeDeleteCategoryImage(image);
}
