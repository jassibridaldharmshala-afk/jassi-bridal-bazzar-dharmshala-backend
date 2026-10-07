const { ApiError } = require('../utils/apiError');

const TEXT_LIMITS = {
  storeName: 100, legalBusinessName: 160, tagline: 180, seoTitle: 100, seoDescription: 300,
  contactEmail: 254, contactPhone: 24, whatsappNumber: 24, address: 1000, billingAddress: 1000,
  gstin: 15, invoicePrefix: 16, invoiceNote: 500, supportHours: 200, footerText: 1000,
  announcementText: 240, orderPauseMessage: 300, logoUrl: 2000, faviconUrl: 2000, socialShareImage: 2000,
  returnPolicy: 20000, privacyPolicy: 20000, termsConditions: 20000, shippingPolicy: 20000,
  cancellationPolicy: 20000, sizeGuide: 20000, faqs: 20000, ourStory: 20000,
};
const NUMBERS = ['deliveryCharge', 'freeShippingMinAmount', 'codCharge', 'codMaxAmount', 'codMinAmount',
  'returnWindowDays', 'prepaidDiscountValue', 'codRtoRestrictionLimit', 'rtoBlockMinOrders', 'rtoBlockThreshold', 'platformFee', 'gstRate', 'minimumOrderAmount',
  'customerReturnShippingCharge', 'customerRestockingFeePercent', 'exchangeReservationHours', 'returnSlaHours', 'rtoRefundDeduction', 'returnWeightToleranceGrams', 'highValueVerificationThreshold'];
const BOOLEANS = ['occasionShoppingEnabled', 'recentlyViewedEnabled', 'completeLookEnabled', 'brandIdentityEnabled', 'contactDetailsEnabled', 'announcementEnabled', 'acceptingOrders', 'razorpayEnabled', 'upiEnabled',
  'cardPaymentEnabled', 'netBankingEnabled', 'walletEnabled', 'codEnabled', 'codConfirmationRequired', 'smartCodVerificationEnabled', 'rtoBlockEnabled', 'searchIndexingEnabled',
  'returnsEnabled', 'refundDeliveryChargeOnFullReturn', 'refundPlatformFeeOnFullReturn', 'refundCodChargeOnFullReturn',
  'requireProductQrScan', 'requirePackingPhotos', 'requirePackingVideo', 'requireDispatchWeight', 'requireSecuritySeal', 'requireReturnPhotos', 'requireReturnVideo', 'enableSecurityTag', 'enableCustomerRiskDetection', 'autoApproveVerifiedReturns'];
function invalid(message) { throw new ApiError('VALIDATION_ERROR', message); }
function safeUrl(value, label, image = false) {
  if (!value) return '';
  if (image && /^\/uploads\/[\w./%-]+$/.test(value) && !value.includes('..')) return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { invalid(`${label} must be a valid HTTP or HTTPS URL${image ? ' or uploaded image path' : ''}.`); }
}
function normalizeSettingsUpdates(input, current = {}) {
  const updates = { ...input };
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (updates[key] === undefined) continue;
    if (typeof updates[key] !== 'string') invalid(`${key} must be text.`);
    updates[key] = updates[key].trim();
    if (updates[key].length > max) invalid(`${key} must be ${max} characters or fewer.`);
  }
  if (!String(updates.storeName ?? current.storeName ?? '').trim()) invalid('Store name is required.');
  if (updates.contactEmail && !/^\S+@\S+\.\S+$/.test(updates.contactEmail)) invalid('Enter a valid contact email.');
  for (const key of ['contactPhone', 'whatsappNumber']) {
    if (updates[key] && (!/^[+\d ()-]+$/.test(updates[key]) || !/^\d{10,15}$/.test(updates[key].replace(/\D/g, '')))) invalid(`${key} must contain 10 to 15 digits.`);
  }
  for (const key of ['logoUrl', 'faviconUrl', 'socialShareImage']) if (updates[key] !== undefined) updates[key] = safeUrl(updates[key], key, true);
  for (const [key, allowed] of Object.entries({ socialLinks: ['instagram', 'facebook', 'youtube', 'pinterest', 'twitter'], appLinks: ['googlePlay', 'playStore', 'appStore', 'appleStore'] })) {
    if (updates[key] === undefined) continue;
    if (!updates[key] || typeof updates[key] !== 'object' || Array.isArray(updates[key]) || Object.keys(updates[key]).some(name => !allowed.includes(name))) invalid(`Invalid ${key}.`);
    updates[key] = Object.fromEntries(Object.entries(updates[key]).map(([name, value]) => {
      if (typeof value !== 'string' || value.length > 2000) invalid(`${name} must be a valid link.`);
      return [name, safeUrl(value.trim(), name)];
    }));
  }
  for (const key of BOOLEANS) if (updates[key] !== undefined && typeof updates[key] !== 'boolean') invalid(`${key} must be enabled or disabled.`);
  for (const key of NUMBERS) {
    if (updates[key] === undefined) continue;
    const value = updates[key];
    if (key === 'returnWindowDays' && value === null) continue;
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000000) invalid(`${key} must be zero or a positive number.`);
    updates[key] = Number(value);
  }
  for (const key of ['returnWindowDays', 'codRtoRestrictionLimit', 'rtoBlockMinOrders', 'exchangeReservationHours', 'returnSlaHours']) if (updates[key] !== undefined && updates[key] !== null && !Number.isInteger(updates[key])) invalid(`${key} must be a whole number.`);
  if (updates.codRtoRestrictionLimit > 100) invalid('COD RTO restriction limit cannot exceed 100.');
  if (updates.returnWindowDays !== null && updates.returnWindowDays > 365) invalid('Return window must be between 0 and 365 days.');
  if (updates.customerRestockingFeePercent > 100) invalid('Restocking fee must be between 0 and 100 percent.');
  if (updates.exchangeReservationHours !== undefined && (updates.exchangeReservationHours < 1 || updates.exchangeReservationHours > 720)) invalid('Exchange reservation must be between 1 and 720 hours.');
  if (updates.returnSlaHours !== undefined && (updates.returnSlaHours < 1 || updates.returnSlaHours > 720)) invalid('Return SLA must be between 1 and 720 hours.');
  if (updates.returnWeightToleranceGrams !== undefined && updates.returnWeightToleranceGrams > 10000) invalid('Return weight tolerance cannot exceed 10,000 grams.');
  if (updates.rtoBlockThreshold > 1) invalid('RTO block rate must be between 0 and 1.');
  if (updates.gstRate > 100) invalid('GST rate must be between 0 and 100.');
  if (updates.gstin) {
    updates.gstin = updates.gstin.toUpperCase();
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(updates.gstin)) invalid('Enter a valid 15-character GSTIN, or leave it empty.');
  }
  if (updates.invoicePrefix !== undefined) {
    updates.invoicePrefix = updates.invoicePrefix.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(updates.invoicePrefix)) invalid('Invoice prefix needs 1 to 16 letters, numbers or hyphens.');
  }
  if (updates.codPincodes !== undefined) {
    const source = updates.codPincodes;
    if (!Array.isArray(source) && typeof source !== 'string') invalid('Enter COD pincodes separated by commas.');
    const pins = Array.isArray(source) ? source.map(String) : source.split(/[,\s]+/);
    const cleaned = pins.map(value => value.trim()).filter(Boolean);
    if (cleaned.length > 5000 || cleaned.some(pin => !/^\d{6}$/.test(pin))) invalid('Every COD pincode must have exactly 6 digits.');
    updates.codPincodes = [...new Set(cleaned)];
  }
  if (updates.prepaidDiscountType !== undefined && !['Percentage', 'Flat', ''].includes(updates.prepaidDiscountType)) invalid('Choose a valid prepaid discount type.');
  const next = { ...current, ...updates };
  if (Number(next.codMaxAmount) > 0 && Number(next.codMinAmount) > Number(next.codMaxAmount)) invalid('COD maximum must be at least the COD minimum.');
  if (next.prepaidDiscountType === 'Percentage' && Number(next.prepaidDiscountValue) > 100) invalid('Prepaid percentage discount cannot exceed 100%.');
  if (next.rtoBlockEnabled && !(Number(next.rtoBlockMinOrders) > 0 && Number(next.rtoBlockThreshold) > 0)) invalid('Set a minimum order count and a block rate before enabling RTO blocking.');
  return require('./shippingRules').normalizeShippingSettings(updates, current);
}

// Store identity is shared across themes only after the owner chooses to manage it in Settings.
function applyStorePresentation(config, settings = {}) {
  const result = structuredClone(config);
  if (settings.brandIdentityEnabled) {
    result.branding = { ...result.branding, websiteName: settings.storeName, logo: settings.logoUrl || '', favicon: settings.faviconUrl || '', tagline: settings.tagline || '' };
    result.footer.logo = settings.logoUrl || '';
    result.footer.copyrightText = '';
  }
  for (const [field, target] of Object.entries({ contactEmail: 'contactEmail', contactPhone: 'contactPhone', address: 'contactAddress', footerText: 'description', socialLinks: 'socialLinks' })) {
    if (settings.contactDetailsEnabled && settings[field] !== undefined) result.footer[target] = settings[field];
  }
  if (settings.announcementEnabled !== undefined) result.header.announcementEnabled = settings.announcementEnabled;
  if (settings.announcementText !== undefined) result.header.announcementText = settings.announcementText || (Number(settings.deliveryCharge ?? 99) === 0 || Number(settings.freeShippingMinAmount ?? 999) === 0 ? 'Free delivery on all orders' : `Free shipping on orders of ₹${Number(settings.freeShippingMinAmount ?? 999).toLocaleString('en-IN')} or more`);
  if (!settings.announcementText && settings.shippingFreeAboveEnabled === false) result.header.announcementText = 'Delivery availability and charges confirmed at checkout';
  return result;
}
module.exports = { normalizeSettingsUpdates, applyStorePresentation, TEXT_LIMITS, NUMBERS, BOOLEANS };
