const { isMasterOwner } = require('../config/masterOwner');
const { readConfiguration } = require('../services/masterConfigurationService');
const Settings = require('../models/Settings');
const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { buildPaymentOptions, getStoreSettings, razorpayDisabledReason, razorpayUsable } = require('../services/paymentSettingsService');
const { isRazorpayConfigured } = require('../services/razorpayService');
const { logAudit } = require('../services/auditService');
const { auditSnapshot } = require('../utils/auditData');
const { normalizeSettingsUpdates } = require('../services/storeSettingsValidation');

const SETTINGS_PERMISSION_FIELDS = Object.freeze({
  branding: ['storeName', 'brandIdentityEnabled', 'logoUrl', 'faviconUrl', 'tagline', 'seoTitle', 'seoDescription', 'socialShareImage', 'searchIndexingEnabled', 'legalBusinessName', 'gstin', 'invoicePrefix', 'billingAddress'],
  content: ['occasionShoppingEnabled', 'recentlyViewedEnabled', 'completeLookEnabled', 'contactDetailsEnabled', 'announcementEnabled', 'announcementText', 'supportHours', 'invoiceNote', 'contactEmail', 'contactPhone', 'whatsappNumber', 'address', 'footerText', 'returnPolicy', 'privacyPolicy', 'termsConditions', 'shippingPolicy', 'cancellationPolicy', 'sizeGuide', 'faqs', 'ourStory'],
  pricing: ['acceptingOrders', 'orderPauseMessage', 'minimumOrderAmount', 'platformFee', 'gstRate'],
  shipping: ['shippingProvider', 'manualDeliveryMode', 'shippingPricingMode', 'shippingFreeAboveEnabled', 'shippingDefaultWeightKg', 'shippingLengthCm', 'shippingWidthCm', 'shippingHeightCm', 'shippingVolumetricDivisor', 'shippingWeightStepKg', 'shippingAdditionalStepCharge', 'shippingRateZones', 'shippingPickup', 'freeShippingMinAmount', 'deliveryCharge'],
  payments: ['razorpayEnabled', 'upiEnabled', 'cardPaymentEnabled', 'netBankingEnabled', 'walletEnabled', 'codEnabled', 'codCharge', 'codMinAmount', 'codMaxAmount', 'codPincodes', 'prepaidDiscountType', 'prepaidDiscountValue', 'codConfirmationRequired', 'smartCodVerificationEnabled', 'codRtoRestrictionLimit', 'rtoBlockEnabled', 'rtoBlockMinOrders', 'rtoBlockThreshold', 'rtoRefundDeduction'],
  returns: ['returnsEnabled', 'returnWindowDays', 'refundDeliveryChargeOnFullReturn', 'refundPlatformFeeOnFullReturn', 'refundCodChargeOnFullReturn', 'customerReturnShippingCharge', 'customerRestockingFeePercent', 'exchangeReservationHours', 'returnSlaHours', 'requireProductQrScan', 'requirePackingPhotos', 'requirePackingVideo', 'requireDispatchWeight', 'requireSecuritySeal', 'requireReturnPhotos', 'requireReturnVideo', 'enableSecurityTag', 'enableCustomerRiskDetection', 'autoApproveVerifiedReturns', 'returnWeightToleranceGrams', 'highValueVerificationThreshold'],
  social: ['socialLinks', 'appLinks'],
});

exports.getSettings = asyncHandler(async (req, res) => {
  const settings = (await Settings.findOne(req.tenantFilter || {})) || await Settings.create({ ...(req.store?._id ? { storeId: req.store._id } : {}) });
  const data = settings.toObject();
  if (req.baseUrl === '/api/settings') data.commerceMode = req.store?.catalogStructure?.commerce?.mode || 'SALE_ONLY';
  if ((!req.user || req.user.role !== 'admin') && !req.storeMember) {
    delete data.shippingPickup;
    delete data.shippingRateZones;
  }
  res.json(data);
});

/**
 * Payment methods the storefront may offer, derived from the same admin
 * settings the checkout API enforces.
 */
exports.getPaymentMethods = asyncHandler(async (req, res) => {
  const settings = await getStoreSettings(req.tenantFilter || {});
  const razorpayConfigured = isRazorpayConfigured();
  const requestedAmount = req.query.amount === undefined || req.query.amount === ''
    ? null
    : Number(req.query.amount);
  res.json({
    methods: buildPaymentOptions(settings, {
      razorpayConfigured,
      orderAmount: Number.isFinite(requestedAmount) ? requestedAmount : null,
      pincode: String(req.query.pincode || ''),
    }),
    codCharge: Math.max(0, Number(settings.codCharge || 0)),
    codMaxAmount: Number(settings.codMaxAmount || 0) || null,
    codMinAmount: Number(settings.codMinAmount || 0) || null,
    deliveryCharge: Number(settings.deliveryCharge ?? 99),
    freeShippingMinAmount: Number(settings.freeShippingMinAmount ?? 999),
    platformFee: Number(settings.platformFee ?? 23),
    gstRate: Number(settings.gstRate ?? 5),
    gateway: {
      provider: 'Razorpay',
      enabled: Boolean(settings.razorpayEnabled),
      configured: razorpayConfigured,
      ready: razorpayUsable(settings, { razorpayConfigured }),
      disabledReason: razorpayDisabledReason(settings, { razorpayConfigured }),
    },
  });
});

exports.getPaymentReadiness = asyncHandler(async (req, res) => {
  const settings = await getStoreSettings(req.tenantFilter || {});
  const configured = isRazorpayConfigured();
  const keyId = String(process.env.RAZORPAY_KEY_ID || '');
  res.json({
    provider: 'Razorpay',
    enabled: Boolean(settings.razorpayEnabled),
    configured,
    ready: razorpayUsable(settings, { razorpayConfigured: configured }),
    mode: configured ? (keyId.startsWith('rzp_live_') ? 'live' : 'test') : 'not-configured',
    webhookConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
    disabledReason: razorpayDisabledReason(settings, { razorpayConfigured: configured }),
  });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const { _id, __v, createdAt, updatedAt, expectedUpdatedAt, storeId, ...input } = req.body || {};
  const previous = await Settings.findOne(req.tenantFilter || {});
  const current = previous?.toObject() || {};
  if (storeId && String(storeId) !== String(current.storeId || '')) throw new ApiError('FORBIDDEN', 'Store identity cannot be changed here');
  if (Object.keys(input).some(key => key.includes('.') || key.startsWith('$') || !Settings.schema.path(key))) throw new ApiError('FORBIDDEN', 'Only supported store settings can be changed here');
  if (expectedUpdatedAt !== undefined && String(expectedUpdatedAt || '') !== (current.updatedAt ? new Date(current.updatedAt).toISOString() : '')) {
    throw new ApiError('DUPLICATE_REQUEST', 'Settings changed in another session. Reload the saved settings and review your changes.');
  }
  const updates = normalizeSettingsUpdates(input, current);
  if (!isMasterOwner(req.user)) {
    const permissions = (await readConfiguration(req.store?._id)).structure.clientPermissions;
    const changed = fields => fields.some(key => updates[key] !== undefined && JSON.stringify(updates[key]) !== JSON.stringify(current[key]));
    const labels = { branding: 'Brand identity', content: 'Store content', pricing: 'Pricing', shipping: 'Shipping', payments: 'Payment', returns: 'Returns', social: 'Social links' };
    for (const [capability, fields] of Object.entries(SETTINGS_PERMISSION_FIELDS)) {
      if (permissions?.[capability] === false && changed(fields)) throw new ApiError('FORBIDDEN', `${labels[capability]} configuration is managed by the platform owner`);
    }
  }
  const filter = previous ? { _id: previous._id, ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}) } : { ...(req.store?._id ? { storeId: req.store._id } : {}) };
  const saved = await Settings.findOneAndUpdate(filter, { $set: updates, ...(!previous && req.store?._id ? { $setOnInsert: { storeId: req.store._id } } : {}) }, { new: true, upsert: !previous, runValidators: true, setDefaultsOnInsert: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Settings changed while saving. Reload and review your changes.');
  require('./websiteCustomizationController')._invalidateActiveCache();
  await logAudit({ req, action: 'SETTINGS_UPDATE', entityType: 'Settings', entityId: saved._id, before: auditSnapshot(previous, Object.keys(updates)), after: auditSnapshot(saved, Object.keys(updates)) });
  res.json(saved);
});
