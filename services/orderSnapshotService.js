const mongoose = require('mongoose');
const { normalizeIndianMobile } = require('../utils/phoneUtils');

function snapshotAddress(address = {}) {
  const source = address && typeof address === 'object' ? address : {};
  const mobile = normalizeIndianMobile(source.mobile || source.phone);
  return {
    fullName: String(source.fullName || '').trim(),
    mobile,
    alternateMobile: String(source.alternateMobile || '').trim(),
    pincode: String(source.pincode || '').replace(/\D/g, ''),
    state: String(source.state || '').trim(),
    city: String(source.city || '').trim(),
    houseNo: String(source.houseNo || source.houseNumber || '').trim(),
    area: String(source.area || '').trim(),
    landmark: String(source.landmark || '').trim(),
    addressType: String(source.addressType || 'Home').trim() || 'Home',
  };
}

function invoiceNumberForId(orderId, settings = {}) {
  const prefix = String(settings.invoicePrefix || 'SC').trim().toUpperCase() || 'SC';
  return `${prefix}-${String(orderId).slice(-8).toUpperCase()}`;
}

function snapshotOrderItems(items = []) {
  return items.map((item) => {
    const unitPrice = Number(item.price || 0);
    const unitMrp = Number(item.originalPrice || item.price || 0);
    return {
      product: item.product,
      name: item.name,
      productName: item.productName || item.name,
      sku: item.sku || '',
      image: item.image || '',
      size: item.size || '',
      color: item.color || '',
      variantId: item.variantId ? String(item.variantId) : '',
      quantity: item.quantity,
      price: unitPrice,
      originalPrice: unitMrp,
      discount: Math.round((unitMrp - unitPrice) * 100) / 100,
      tax: Number(item.tax || 0),
      category: item.category,
      shippingWeightKg: Number(item.shippingWeightKg || 0),
      returnable: item.returnable !== false,
      exchangeable: item.exchangeable !== false,
      returnWindowDays: item.returnWindowDays !== null && item.returnWindowDays !== undefined && Number.isFinite(Number(item.returnWindowDays)) ? Number(item.returnWindowDays) : undefined,
      returnPolicy: String(item.returnPolicy || '').trim(),
    };
  });
}

function buildPersistedOrderFields({ userId, draft, shippingAddress, billingAddress, extra = {} }) {
  const id = extra._id || new mongoose.Types.ObjectId();
  const shipping = snapshotAddress(shippingAddress);
  return {
    _id: id,
    user: userId,
    orderItems: snapshotOrderItems(draft.items),
    shippingAddress: shipping,
    shippingQuote: draft.shippingQuote || undefined,
    billingAddress: snapshotAddress(billingAddress || shippingAddress),
    invoiceNumber: invoiceNumberForId(id, draft.settings),
    invoiceDate: extra.invoiceDate || new Date(),
    invoiceSeller: Object.fromEntries(['storeName', 'legalBusinessName', 'gstin', 'contactEmail', 'contactPhone', 'whatsappNumber', 'address', 'billingAddress', 'returnPolicy', 'logoUrl', 'invoiceNote'].map((key) => [key, String(draft.settings?.[key] || '').trim()])),
    returnPolicySnapshot: {
      capturedAt: new Date(),
      returnsEnabled: draft.settings?.returnsEnabled !== false,
      returnWindowDays: draft.settings?.returnWindowDays === null ? null : Math.max(0, Number(draft.settings?.returnWindowDays ?? 7)),
      refundDeliveryChargeOnFullReturn: draft.settings?.refundDeliveryChargeOnFullReturn === true,
      refundPlatformFeeOnFullReturn: draft.settings?.refundPlatformFeeOnFullReturn === true,
      refundCodChargeOnFullReturn: draft.settings?.refundCodChargeOnFullReturn === true,
      customerReturnShippingCharge: Math.max(0, Number(draft.settings?.customerReturnShippingCharge || 0)),
      customerRestockingFeePercent: Math.min(100, Math.max(0, Number(draft.settings?.customerRestockingFeePercent || 0))),
      rtoRefundDeduction: Math.max(0, Number(draft.settings?.rtoRefundDeduction || 0)),
    },
    paymentMethod: draft.paymentMethod,
    ...draft.totals,
    ...extra,
  };
}

module.exports = {
  buildPersistedOrderFields,
  invoiceNumberForId,
  snapshotAddress,
  snapshotOrderItems,
};
