const { assertMasterOwner } = require('../config/masterOwner');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Store = require('../models/Store');
const IndustryPreset = require('../models/IndustryPreset');
const StoreMember = require('../models/StoreMember');
const User = require('../models/User');
const { getIndustryPreset, INDUSTRY_IDS } = require('../config/industryPresets');
const { LICENSE_STATUSES, nextPeriodEnd, normalizePlan, planSummary } = require('../config/storePlans');
const { asyncHandler } = require('../middleware/validate');
const { ApiError, forbidden } = require('../utils/apiError');
const { optionalEmail, optionalIndianMobile, optionalString, requirePincode, requireString } = require('../utils/validators');
const {
  ensureDefaultStore,
  listMemberships,
  onboardingProgress,
  publicStoreView,
  resolveStoreFromHost,
  uniqueSlug,
} = require('../services/storeService');
const { logAudit } = require('../services/auditService');
const { runInTransaction } = require('../utils/transaction');
const slugify = require('../utils/slugify');
const { normalizePhone } = require('../utils/phoneUtils');

const clone = (value) => JSON.parse(JSON.stringify(value));

function readAddress(value) {
  if (!value || typeof value !== 'object') return undefined;
  const pincode = String(value.pincode || '').replace(/\D/g, '');
  if (pincode && !/^\d{6}$/.test(pincode)) requirePincode(pincode);
  return {
    fullName: optionalString(value.fullName, 'fullName', { max: 80 }),
    mobile: optionalIndianMobile(value.mobile || value.phone, 'mobile') || undefined,
    pincode: pincode || undefined,
    state: optionalString(value.state, 'state', { max: 80 }),
    city: optionalString(value.city, 'city', { max: 80 }),
    houseNo: optionalString(value.houseNo || value.houseNumber, 'houseNo', { max: 80 }),
    area: optionalString(value.area, 'area', { max: 120 }),
    landmark: optionalString(value.landmark, 'landmark', { max: 120 }),
  };
}

exports.listMine = asyncHandler(async (req, res) => {
  const memberships = await listMemberships(req.user._id);
  res.json(memberships.map((item) => ({
    id: String(item._id),
    role: item.role,
    status: item.status,
    store: publicStoreView(item.store),
  })));
});

exports.createStore = asyncHandler(async (req, res) => {
  assertMasterOwner(req.user);
  const name = requireString(req.body?.name, 'name', { min: 2, max: 80 });
  const slug = await uniqueSlug(req.body?.slug || name);
  const industry = String(req.body?.industry || 'fashion').trim().toLowerCase();
  const builtinPreset = INDUSTRY_IDS.includes(industry) ? getIndustryPreset(industry) : null;
  const customPreset = builtinPreset ? null : await IndustryPreset.findOne({ key: industry, isActive: { $ne: false }, archivedAt: null }).lean();
  if (!builtinPreset && !customPreset) throw new ApiError('VALIDATION_ERROR', 'Choose an active business type');
  const industryPreset = builtinPreset || { ...customPreset.structure, industry: customPreset.key, id: customPreset.key, name: customPreset.name };
  const licenseStatus = String(req.body?.licenseStatus || 'TRIAL').trim().toUpperCase();
  if (!LICENSE_STATUSES.includes(licenseStatus)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid licence status');
  const startedAt = new Date();
  const suppliedEndsAt = readFutureDate(req.body?.licenseEndsAt, 'licence expiry');
  if (licenseStatus === 'ACTIVE' && !suppliedEndsAt) {
    throw new ApiError('VALIDATION_ERROR', 'Choose a future access expiry when creating an active store');
  }
  const licenseEndsAt = suppliedEndsAt || (licenseStatus === 'TRIAL' ? nextPeriodEnd('TRIAL', startedAt) : null);
  let store; let owner; let createdOwnerId; let usedTransaction = false;
  try {
    await runInTransaction(async (session) => {
      usedTransaction = Boolean(session);
      const resolved = await resolveStoreOwner(req, session); owner = resolved.user; createdOwnerId = resolved.created ? owner._id : null;
      [store] = await Store.create([{
        name, slug,
        legalName: optionalString(req.body?.legalName, 'legalName', { max: 120 }) || name,
        logo: optionalString(req.body?.logo, 'logo', { max: 500 }) || undefined,
        bio: optionalString(req.body?.bio, 'bio', { max: 1000 }) || undefined,
        instagramHandle: optionalString(req.body?.instagramHandle, 'instagramHandle', { max: 80 }) || undefined,
        instagramUrl: optionalString(req.body?.instagramUrl, 'instagramUrl', { max: 300 }) || undefined,
        whatsappNumber: optionalIndianMobile(req.body?.whatsappNumber, 'whatsappNumber') || undefined,
        supportEmail: optionalEmail(req.body?.supportEmail, 'supportEmail') || undefined,
        supportPhone: optionalIndianMobile(req.body?.supportPhone, 'supportPhone') || undefined,
        pickupAddress: readAddress(req.body?.pickupAddress), returnAddress: readAddress(req.body?.returnAddress),
        paymentReady: Boolean(req.body?.paymentReady), shippingReady: Boolean(req.body?.shippingReady), checkoutEnabled: true,
        customDomain: req.body?.customDomain ? parseCustomDomain(req.body.customDomain) : undefined,
        status: 'ONBOARDING', owner: owner._id, industry,
        catalogStructure: { ...clone(industryPreset), clientPermissions: { content: true, payments: true } }, industryLocked: true,
        plan: normalizePlan(req.body?.plan, 'PROFESSIONAL'),
        license: { status: licenseStatus, startsAt: startedAt, billingCycle: licenseStatus === 'TRIAL' ? 'TRIAL' : 'MANUAL', ...(licenseStatus === 'TRIAL' ? { trialEndsAt: licenseEndsAt } : {}), ...(licenseEndsAt ? { endsAt: licenseEndsAt } : {}), renewalMessage: optionalString(req.body?.renewalMessage, 'renewalMessage', { max: 300 }) || '' },
      }], { ordered: true, ...(session ? { session } : {}) });
      const memberships = [{ store: store._id, user: owner._id, role: 'OWNER', status: 'ACTIVE', activatedAt: new Date() }];
      if (String(owner._id) !== String(req.user._id)) memberships.push({ store: store._id, user: req.user._id, role: 'MANAGER', status: 'ACTIVE', activatedAt: new Date() });
      await StoreMember.create(memberships, { ordered: true, ...(session ? { session } : {}) });
      await User.updateMany({ _id: { $in: [...new Set([owner._id, req.user._id].map(String))] } }, { $addToSet: { availableModes: { $each: ['customer', 'seller'] } } }, { ...(session ? { session } : {}) });
      const categories = industryPreset.defaultCategories.map((categoryName, index) => {
        const definition = (industryPreset.categoryDefinitions || []).find((item) => item.name.toLowerCase() === String(categoryName).toLowerCase());
        return { name: categoryName, slug: `${slug}-${slugify(categoryName)}`, description: `Starter ${industryPreset.name.toLowerCase()} category`, displayOrder: index, storeId: store._id, definitionKey: definition?.key || '', parentDefinitionKey: definition?.parentKey || '', attributeOverrides: definition?.attributes || [], variantAttributes: definition?.variantAttributes || [], configuredFilters: definition?.filters || [] };
      });
      if (categories.length) await Category.create(categories, { ordered: true, ...(session ? { session } : {}) });
    });
  } catch (error) {
    if (!usedTransaction) {
      if (store?._id) { await Promise.allSettled([Category.deleteMany({ storeId: store._id }), StoreMember.deleteMany({ store: store._id }), Store.deleteOne({ _id: store._id })]); }
      if (createdOwnerId) await User.deleteOne({ _id: createdOwnerId, isPhoneVerified: false }).catch(() => null);
    }
    throw error;
  }
  await logAudit({ req, action: 'STORE_CREATE', entityType: 'Store', entityId: store._id, after: { name, slug, industry, plan: store.plan, owner: owner._id }, storeId: store._id });
  res.status(201).json(await serializeOnboarding(store));
});

exports.getMine = asyncHandler(async (req, res) => {
  res.json(await serializeOnboarding(req.store, req.storeMember));
});

exports.updateMine = asyncHandler(async (req, res) => {
  const store = req.store;
  if (req.body?.name !== undefined) store.name = requireString(req.body.name, 'name', { min: 2, max: 80 });
  if (req.body?.slug !== undefined) store.slug = await uniqueSlug(req.body.slug, store._id);
  if (req.body?.legalName !== undefined) store.legalName = optionalString(req.body.legalName, 'legalName', { max: 120 });
  if (req.body?.logo !== undefined) store.logo = optionalString(req.body.logo, 'logo', { max: 500 });
  if (req.body?.coverImage !== undefined) store.coverImage = optionalString(req.body.coverImage, 'coverImage', { max: 500 });
  if (req.body?.bio !== undefined) store.bio = optionalString(req.body.bio, 'bio', { max: 1000 });
  if (req.body?.instagramHandle !== undefined) store.instagramHandle = optionalString(req.body.instagramHandle, 'instagramHandle', { max: 80 });
  if (req.body?.instagramUrl !== undefined) store.instagramUrl = optionalString(req.body.instagramUrl, 'instagramUrl', { max: 300 });
  if (req.body?.whatsappNumber !== undefined) store.whatsappNumber = optionalIndianMobile(req.body.whatsappNumber, 'whatsappNumber');
  if (req.body?.supportEmail !== undefined) store.supportEmail = optionalEmail(req.body.supportEmail, 'supportEmail');
  if (req.body?.supportPhone !== undefined) store.supportPhone = optionalIndianMobile(req.body.supportPhone, 'supportPhone');
  if (req.body?.pickupAddress !== undefined) store.pickupAddress = readAddress(req.body.pickupAddress);
  if (req.body?.returnAddress !== undefined) store.returnAddress = readAddress(req.body.returnAddress);
  if (req.body?.paymentReady !== undefined) store.paymentReady = Boolean(req.body.paymentReady);
  if (req.body?.shippingReady !== undefined) store.shippingReady = Boolean(req.body.shippingReady);
  if (req.body?.customDomain !== undefined) store.customDomain = parseCustomDomain(req.body.customDomain);
  await store.save();
  logAudit({ req, action: 'STORE_UPDATE', entityType: 'Store', entityId: store._id, storeId: store._id });
  res.json(await serializeOnboarding(store, req.storeMember));
});

exports.publishMine = asyncHandler(async (req, res) => {
  const store = req.store;
  if (req.storeMember.role !== 'OWNER' && req.storeMember.role !== 'MANAGER') {
    throw forbidden('Only the store owner or manager can publish');
  }
  const productCount = await Product.countDocuments({ storeId: store._id, isActive: true, isArchived: { $ne: true } });
  const progress = onboardingProgress(store, { productCount });
  if (!progress.steps.name || !progress.steps.slug) {
    throw new ApiError('VALIDATION_ERROR', 'Add a store name and URL slug before publishing');
  }
  store.status = 'PUBLISHED';
  store.publishedAt = store.publishedAt || new Date();
  await store.save();
  logAudit({ req, action: 'STORE_PUBLISH', entityType: 'Store', entityId: store._id, storeId: store._id });
  res.json(await serializeOnboarding(store, req.storeMember));
});

exports.resolveHost = asyncHandler(async (req, res) => {
  const host = String(req.query.host || req.headers['x-forwarded-host'] || req.headers.host || '');
  const resolved = await resolveStoreFromHost(host);
  res.json({
    ...publicStoreView(resolved.store),
    isDefault: resolved.isDefaultStore,
    resolvedFrom: host,
  });
});

exports.getPublic = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const store = slug
    ? await Store.findOne({ slug, status: 'PUBLISHED' })
    : await ensureDefaultStore();
  if (!store || (store.status !== 'PUBLISHED' && !store.isDefault)) {
    throw new ApiError('NOT_FOUND', 'Store not found');
  }
  res.json(publicStoreView(store));
});

function parseCustomDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
  if (!raw) return undefined;
  if (raw === 'localhost' || raw === '127.0.0.1' || raw.includes(' ')) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a real hostname such as shop.example.com. DNS is not configured automatically.');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a hostname such as shop.example.com. Point a CNAME yourself; this app does not change DNS.');
  }
  return raw;
}

async function serializeOnboarding(store, membership) {
  const productCount = await Product.countDocuments({ storeId: store._id, isArchived: { $ne: true } });
  return {
    store: {
      ...publicStoreView(store),
      legalName: store.legalName,
      pickupAddress: store.pickupAddress,
      returnAddress: store.returnAddress,
      paymentReady: store.paymentReady,
      shippingReady: store.shippingReady,
      supportEmail: store.supportEmail,
      supportPhone: store.supportPhone,
      publishedAt: store.publishedAt,
      industry: store.industry,
      catalogStructure: store.catalogStructure,
      platform: planSummary(store),
      festivalCampaign: store.festivalCampaign,
    },
    role: membership?.role,
    progress: onboardingProgress(store, { productCount }),
  };
}

async function resolveStoreOwner(req, session) {
  if (req.body?.ownerPhone !== undefined && !normalizePhone(req.body.ownerPhone)) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a valid 10-digit Indian mobile number for the store owner');
  }
  const phone = normalizePhone(req.body?.ownerPhone);
  if (!phone) return { user: req.user, created: false };
  let user = await User.findOne({ phone }).session(session || null);
  if (user?.isBlocked) throw forbidden('Unblock the store owner account before assigning it');
  if (!user) {
    const ownerName = requireString(req.body?.ownerName, 'ownerName', { min: 2, max: 80 });
    [user] = await User.create([{ name: ownerName, phone, role: 'customer', isPhoneVerified: false, availableModes: ['customer', 'seller'], activeMode: 'customer' }], { ordered: true, ...(session ? { session } : {}) });
    return { user, created: true };
  }
  return { user, created: false };
}

function readFutureDate(value, label) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApiError('VALIDATION_ERROR', `Choose a valid ${label}`);
  if (date <= new Date()) throw new ApiError('VALIDATION_ERROR', `${label} must be in the future`);
  return date;
}
