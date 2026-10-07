const Coupon = require('../models/Coupon');
const CouponCustomerUsage = require('../models/CouponCustomerUsage');
const Order = require('../models/Order');
const { ApiError } = require('../utils/apiError');
const { requireCouponCode } = require('../utils/validators');
const { andFilter, defaultStoreFilter } = require('./storeService');

/**
 * Single source of truth for coupon rules.
 *
 * Every entry point (apply preview, COD checkout, Razorpay checkout, payment
 * verification) must go through here so a customer cannot get a different
 * answer depending on which door they knock on.
 */

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function idList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item?._id || item || '').trim()).filter(Boolean);
}

function itemProductId(item) {
  return String(item?.product?._id || item?.product || item?.productId || '');
}

function itemCategoryId(item) {
  return String(item?.category?._id || item?.category || '');
}

function itemLineTotal(item) {
  const storedLineTotal = Number(item?.lineTotal);
  if (Number.isFinite(storedLineTotal) && storedLineTotal >= 0) return storedLineTotal;
  return Number(item?.price || 0) * Math.max(1, Number(item?.quantity || 1));
}

/**
 * When a coupon is restricted to products or categories, the discount is
 * computed only against matching lines. A cart with no matching lines is
 * refused rather than silently discounted at Rs. 0.
 */
function couponScopedItems(coupon, items) {
  const productIds = idList(coupon?.applicableProducts);
  const categoryIds = idList(coupon?.applicableCategories);
  const matchMode = String(coupon?.scopeMatchMode || 'ALL').toUpperCase();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const productSelected = productIds.includes(itemProductId(item));
    const categorySelected = categoryIds.includes(itemCategoryId(item));
    let matchesScope = true;
    if (productIds.length && categoryIds.length) {
      matchesScope = matchMode === 'ANY' ? productSelected || categorySelected : productSelected && categorySelected;
    } else if (productIds.length) matchesScope = productSelected;
    else if (categoryIds.length) matchesScope = categorySelected;

    const hasProductOffer = Number(item?.originalPrice || 0) > Number(item?.price || 0);
    const canStack = coupon?.stackingMode === 'ALLOW_PRODUCT_OFFERS' || !hasProductOffer;
    return matchesScope && canStack;
  });
}

function eligibleCartTotal(coupon, cartTotal, items) {
  const productIds = idList(coupon?.applicableProducts);
  const categoryIds = idList(coupon?.applicableCategories);
  const needsLineEvaluation = productIds.length || categoryIds.length
    || coupon?.stackingMode === 'EXCLUSIVE';
  if (!needsLineEvaluation || !Array.isArray(items) || !items.length) return Number(cartTotal || 0);

  const eligible = couponScopedItems(coupon, items).reduce((sum, item) => sum + itemLineTotal(item), 0);

  if (eligible <= 0) {
    const message = coupon?.stackingMode === 'EXCLUSIVE'
      ? 'This coupon cannot be combined with the product offers in your bag'
      : 'This coupon does not apply to the items in your bag';
    throw new ApiError('INVALID_COUPON', message);
  }
  return eligible;
}

function minimumBase(coupon, cartTotal, items) {
  return coupon?.minimumRequirementBasis === 'ELIGIBLE_ITEMS'
    ? eligibleCartTotal(coupon, cartTotal, items)
    : Number(cartTotal || 0);
}

function effectiveSaving(coupon, discountAmount, deliveryCharge = 0) {
  const deliveryCap = Number(coupon?.maxDiscountAmount || 0);
  const deliverySaving = coupon?.benefitType === 'FREE_SHIPPING'
    ? Math.min(Number(deliveryCharge || 0), deliveryCap > 0 ? deliveryCap : Number(deliveryCharge || 0))
    : 0;
  return round(Number(discountAmount || 0)
    + deliverySaving);
}

function assertBudgetAllows(coupon, saving) {
  const budget = Number(coupon?.totalBudget || 0);
  if (!budget) return;
  const remaining = round(Math.max(0, budget - Number(coupon.spentAmount || 0)));
  if (Number(saving || 0) > remaining) {
    const error = new ApiError('INVALID_COUPON', 'This coupon does not have enough campaign budget for this order');
    error.budgetRemaining = remaining;
    throw error;
  }
}

async function prepareCustomerContext(userId, tenantFilter = {}, couponIds = []) {
  if (!userId) return null;
  const [orders, usageRows] = await Promise.all([
    Order.find(andFilter({ user: userId }, tenantFilter)).select('createdAt finalAmount orderStatus paymentStatus coupon.code').sort({ createdAt: -1 }).lean(),
    CouponCustomerUsage.find(andFilter({ user: userId, ...(couponIds.length ? { coupon: { $in: couponIds } } : {}) }, tenantFilter)).lean(),
  ]);
  const activeHistory = orders.filter((order) => !['Cancelled', 'Returned', 'Refunded'].includes(order.orderStatus) && order.paymentStatus !== 'Failed');
  const historicUses = new Map();
  orders.filter((order) => order.orderStatus !== 'Cancelled' && order.paymentStatus !== 'Failed').forEach((order) => {
    const code = String(order.coupon?.code || '').toUpperCase();
    if (code) historicUses.set(code, Number(historicUses.get(code) || 0) + 1);
  });
  return {
    priorOrders: activeHistory.length,
    lifetimeSpend: round(activeHistory.reduce((sum, order) => sum + Number(order.finalAmount || 0), 0)),
    latestOrderAt: activeHistory[0]?.createdAt || null,
    usageByCoupon: new Map(usageRows.map((row) => [String(row.coupon), row])),
    historicUses,
  };
}

async function assertCustomerRules(coupon, userId, tenantFilter = {}, customerContext = null) {
  if (!coupon) return;

  const segment = String(coupon.customerSegment || 'ALL').toUpperCase();
  const selectedCustomers = idList(coupon.applicableCustomers);
  if (!userId) {
    if (coupon.firstOrderOnly || Number(coupon.customerLimit || 0) > 0 || segment !== 'ALL' || selectedCustomers.length) {
      throw new ApiError('AUTH_REQUIRED', 'Sign in to use this customer-specific coupon', { statusCode: 401 });
    }
    return;
  }

  if (segment === 'SELECTED' && !selectedCustomers.includes(String(userId))) {
    throw new ApiError('INVALID_COUPON', 'This coupon is available to selected customers only');
  }

  const completedOrderQuery = andFilter({
    user: userId,
    orderStatus: { $nin: ['Cancelled', 'Returned', 'Refunded'] },
    paymentStatus: { $ne: 'Failed' },
  }, tenantFilter);
  const needsOrderHistory = coupon.firstOrderOnly || ['NEW', 'REPEAT', 'VIP', 'INACTIVE'].includes(segment);
  const prior = needsOrderHistory
    ? (customerContext ? Number(customerContext.priorOrders || 0) : await Order.countDocuments(completedOrderQuery))
    : 0;

  if (coupon.firstOrderOnly || segment === 'NEW') {
    if (prior > 0) {
      throw new ApiError('INVALID_COUPON', 'This coupon is valid on your first order only');
    }
  }
  const lifetimeSpend = customerContext
    ? Number(customerContext.lifetimeSpend || 0)
    : (needsOrderHistory ? await Order.aggregate([
      { $match: completedOrderQuery },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$finalAmount', 0] } } } },
    ]).then((rows) => Number(rows[0]?.total || 0)) : 0);
  const minimumPriorOrders = Number(coupon.minimumPriorOrders || 0);
  if (segment === 'REPEAT' && prior < (minimumPriorOrders || 1)) throw new ApiError('INVALID_COUPON', `This offer requires at least ${minimumPriorOrders || 1} previous order${(minimumPriorOrders || 1) === 1 ? '' : 's'}`);
  if (segment === 'VIP') {
    const orderThreshold = minimumPriorOrders || 5;
    const spendThreshold = Number(coupon.minimumLifetimeSpend || 0);
    const qualified = prior >= orderThreshold || (spendThreshold > 0 && lifetimeSpend >= spendThreshold);
    if (!qualified) throw new ApiError('INVALID_COUPON', `This VIP offer requires ${orderThreshold} previous orders${spendThreshold > 0 ? ` or Rs. ${spendThreshold} lifetime spend` : ''}`);
  }
  if (segment === 'INACTIVE') {
    const latest = customerContext
      ? (customerContext.latestOrderAt ? { createdAt: customerContext.latestOrderAt } : null)
      : await Order.findOne(completedOrderQuery).sort({ createdAt: -1 }).select('createdAt').lean();
    const inactiveDays = Math.max(1, Number(coupon.inactiveDays || 90));
    const cutoff = Date.now() - (inactiveDays * 24 * 60 * 60 * 1000);
    if (!latest || new Date(latest.createdAt).getTime() > cutoff) throw new ApiError('INVALID_COUPON', `This offer is for customers returning after ${inactiveDays} days`);
  }

  const customerLimit = Number(coupon.customerLimit || 0);
  if (customerLimit > 0) {
    const usage = customerContext
      ? customerContext.usageByCoupon.get(String(coupon._id))
      : await CouponCustomerUsage.findOne(andFilter({ coupon: coupon._id, user: userId }, tenantFilter)).lean();
    const historicUses = usage ? 0 : (customerContext ? Number(customerContext.historicUses.get(String(coupon.code).toUpperCase()) || 0) : await Order.countDocuments(andFilter({
      user: userId,
      'coupon.code': coupon.code,
      orderStatus: { $ne: 'Cancelled' },
      paymentStatus: { $ne: 'Failed' },
    }, tenantFilter)));
    const usedByCustomer = Math.max(Number(usage?.usedCount || 0), historicUses);
    if (usedByCustomer >= customerLimit) {
      throw new ApiError('INVALID_COUPON', 'You have already used this coupon the maximum number of times');
    }
  }
}

/**
 * Loads a coupon and checks every rule. Never trusts a client-sent discount.
 */
async function assertCouponRules(coupon, { cartTotal, paymentMethod, items, userId, tenantFilter = {}, pincode, salesChannel = 'STOREFRONT', customerContext } = {}) {
  if (!coupon || !coupon.isActive || coupon.isArchived) {
    throw new ApiError('INVALID_COUPON', 'This coupon code is not valid');
  }
  const now = new Date();
  if (coupon.validFrom && new Date(coupon.validFrom) > now) {
    throw new ApiError('INVALID_COUPON', 'This coupon is not active yet');
  }
  if (coupon.expiryDate && new Date(coupon.expiryDate) < now) {
    throw new ApiError('COUPON_EXPIRED', 'This coupon has expired');
  }
  if (coupon.usageLimit && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) {
    throw new ApiError('INVALID_COUPON', 'This coupon has reached its usage limit');
  }
  if (coupon.totalBudget && Number(coupon.spentAmount || 0) >= Number(coupon.totalBudget)) {
    throw new ApiError('INVALID_COUPON', 'This coupon has reached its campaign budget');
  }

  const amount = Number(cartTotal || 0);
  if (amount <= 0) {
    throw new ApiError('INVALID_COUPON', 'Add items to your bag before applying a coupon');
  }
  const requirementAmount = minimumBase(coupon, amount, items);
  if (coupon.minOrderAmount && requirementAmount < Number(coupon.minOrderAmount)) {
    const amountNeeded = Math.ceil(Number(coupon.minOrderAmount) - requirementAmount);
    const error = new ApiError('INVALID_COUPON', `Add items worth Rs. ${amountNeeded} more to use this coupon`);
    error.amountNeeded = amountNeeded;
    throw error;
  }

  const quantityItems = coupon.minimumRequirementBasis === 'ELIGIBLE_ITEMS' ? couponScopedItems(coupon, items) : (Array.isArray(items) ? items : []);
  const totalQuantity = quantityItems.reduce((sum, item) => sum + Math.max(1, Number(item.quantity || 1)), 0);
  if (coupon.minItemQuantity && totalQuantity < Number(coupon.minItemQuantity)) {
    throw new ApiError('INVALID_COUPON', `Add at least ${Number(coupon.minItemQuantity) - totalQuantity} more item(s) to use this coupon`);
  }

  const allowedPincodes = (coupon.applicablePincodes || []).map((value) => String(value));
  if (allowedPincodes.length && (!pincode || !allowedPincodes.includes(String(pincode).trim()))) {
    throw new ApiError('INVALID_COUPON', 'This coupon is not available at your delivery PIN code');
  }
  const allowedChannels = (coupon.salesChannels || []).map((value) => String(value).toUpperCase());
  if (allowedChannels.length && !allowedChannels.includes(String(salesChannel || 'STOREFRONT').toUpperCase())) {
    throw new ApiError('INVALID_COUPON', 'This coupon is not available in this sales channel');
  }

  const method = String(paymentMethod || '').toUpperCase();
  const allowedMethods = Array.isArray(coupon.applicablePaymentMethods)
    ? coupon.applicablePaymentMethods.map((item) => String(item).toUpperCase()).filter(Boolean)
    : [];
  const acceptsGateway = method && method !== 'COD' && allowedMethods.includes('RAZORPAY');
  if (method && allowedMethods.length && !allowedMethods.includes(method) && !acceptsGateway) {
    throw new ApiError('INVALID_COUPON', `This coupon cannot be used with ${method} payments`);
  }

  eligibleCartTotal(coupon, cartTotal, items);
  await assertCustomerRules(coupon, userId, tenantFilter, customerContext);
  return coupon;
}

async function validateCoupon({ code, cartTotal, paymentMethod, items, userId, tenantFilter = {}, pincode, salesChannel } = {}) {
  const normalizedCode = requireCouponCode(code);
  const coupon = await Coupon.findOne(andFilter({ code: normalizedCode }, tenantFilter));
  return assertCouponRules(coupon, { cartTotal, paymentMethod, items, userId, tenantFilter, pincode, salesChannel });
}

/** Discount is always recomputed from the stored coupon definition. */
function calculateDiscount(coupon, cartTotal, items) {
  const amount = eligibleCartTotal(coupon, cartTotal, items);
  if (!coupon || amount <= 0) return 0;

  if (coupon.benefitType === 'FREE_SHIPPING') return 0;
  if (coupon.benefitType === 'BUY_X_GET_Y') {
    const buy = Math.max(1, Number(coupon.buyQuantity || 1));
    const get = Math.max(1, Number(coupon.getQuantity || 1));
    const discount = (Array.isArray(items) ? items : []).reduce((sum, item) => {
      const matches = couponScopedItems(coupon, [item]).length > 0;
      if (!matches) return sum;
      const quantity = Math.max(1, Number(item.quantity || 1));
      const freeUnits = Math.floor(quantity / (buy + get)) * get;
      return sum + freeUnits * Number(item.price || 0);
    }, 0);
    return round(Math.max(0, Math.min(discount, amount)));
  }

  const raw = coupon.type === 'Percentage'
    ? (amount * Number(coupon.discountValue || 0)) / 100
    : Number(coupon.discountValue || 0);

  const cap = Number(coupon.maxDiscountAmount || 0) > 0 ? Number(coupon.maxDiscountAmount) : raw;
  return round(Math.max(0, Math.min(raw, cap, amount)));
}

async function findBestAutomatic({ cartTotal, paymentMethod, items, userId, tenantFilter = {}, deliveryCharge = 0, pincode, salesChannel } = {}) {
  const now = new Date();
  const candidates = await Coupon.find(andFilter({
    activationMode: 'AUTOMATIC', isActive: true, isArchived: { $ne: true },
    $and: [
      { $or: [{ expiryDate: { $exists: false } }, { expiryDate: null }, { expiryDate: { $gte: now } }] },
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
    ],
  }, tenantFilter)).sort({ priority: -1, discountValue: -1, createdAt: 1 }).limit(50);
  const customerContext = await prepareCustomerContext(userId, tenantFilter, candidates.map((coupon) => coupon._id));
  const eligible = [];
  for (const coupon of candidates) {
    try {
      await assertCouponRules(coupon, { cartTotal, paymentMethod, items, userId, tenantFilter, pincode, salesChannel, customerContext });
      const discountAmount = calculateDiscount(coupon, cartTotal, items);
      const deliverySaving = coupon.benefitType === 'FREE_SHIPPING' ? effectiveSaving(coupon, 0, deliveryCharge) : 0;
      const saving = effectiveSaving(coupon, discountAmount, deliveryCharge);
      assertBudgetAllows(coupon, saving);
      eligible.push({ coupon, discountAmount, deliverySaving, effectiveSaving: saving });
    } catch {
      // An automatic offer that does not match this bag is simply ignored.
    }
  }
  eligible.sort((left, right) => right.effectiveSaving - left.effectiveSaving
    || Number(right.coupon.priority || 0) - Number(left.coupon.priority || 0));
  return eligible[0] || null;
}

/** Convenience wrapper returning both the coupon and its computed discount. */
async function validateAndPrice({ code, cartTotal, paymentMethod, items, userId, tenantFilter = {}, pincode, salesChannel, deliveryCharge = 0 } = {}) {
  const coupon = await validateCoupon({ code, cartTotal, paymentMethod, items, userId, tenantFilter, pincode, salesChannel });
  const discountAmount = calculateDiscount(coupon, cartTotal, items);
  const savingAmount = effectiveSaving(coupon, discountAmount, deliveryCharge);
  assertBudgetAllows(coupon, savingAmount);
  return { coupon, discountAmount, savingAmount };
}

async function evaluateCoupon(coupon, context = {}) {
  try {
    await assertCouponRules(coupon, context);
    const discountAmount = calculateDiscount(coupon, context.cartTotal, context.items);
    const savingAmount = effectiveSaving(coupon, discountAmount, context.deliveryCharge);
    assertBudgetAllows(coupon, savingAmount);
    return {
      eligible: true,
      estimatedDiscount: discountAmount,
      estimatedDeliverySaving: coupon.benefitType === 'FREE_SHIPPING' ? effectiveSaving(coupon, 0, context.deliveryCharge) : 0,
      effectiveSaving: savingAmount,
      reason: '',
      reasonCode: '',
      amountNeeded: 0,
    };
  } catch (error) {
    return {
      eligible: false,
      estimatedDiscount: 0,
      reason: error.message || 'This coupon is not eligible for your bag',
      reasonCode: error.errorCode || 'INVALID_COUPON',
      amountNeeded: Number(error.amountNeeded || 0),
      budgetRemaining: Number(error.budgetRemaining || 0),
    };
  }
}

/**
 * Increments usage only while the limit still allows it, so two orders racing
 * for the last redemption cannot both consume it.
 */
function couponIdentityFilter(code, couponId) {
  if (couponId) return { _id: couponId };
  return { code: String(code || '').toUpperCase() };
}

async function consumeCoupon(code, { session, tenantFilter = {}, userId, discountAmount = 0, couponId } = {}) {
  if (!code && !couponId) return null;
  const saving = Math.max(0, Number(discountAmount || 0));
  const constraints = [
    {
      $or: [
        { usageLimit: { $exists: false } },
        { usageLimit: null },
        { usageLimit: 0 },
        { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
      ],
    },
  ];
  if (saving > 0) constraints.push({
    $or: [
      { totalBudget: { $exists: false } },
      { totalBudget: null },
      { totalBudget: 0 },
      { $expr: { $lte: [{ $add: [{ $ifNull: ['$spentAmount', 0] }, saving] }, '$totalBudget'] } },
    ],
  });

  const withinLimit = await Coupon.findOneAndUpdate(
    andFilter({
      ...couponIdentityFilter(code, couponId),
      isActive: true,
      isArchived: { $ne: true },
      $and: constraints,
    }, tenantFilter),
    { $inc: { usedCount: 1, spentAmount: saving } },
    { new: true, session },
  );

  if (!withinLimit) {
    throw new ApiError('INVALID_COUPON', 'This coupon has reached its usage limit or campaign budget');
  }
  if (withinLimit.firstOrderOnly || Number(withinLimit.customerLimit || 0) > 0) {
    if (!userId) {
      await Coupon.updateOne({ _id: withinLimit._id }, { $inc: { usedCount: -1, spentAmount: -saving } }, { session });
      throw new ApiError('AUTH_REQUIRED', 'Sign in to use this customer-specific coupon', { statusCode: 401 });
    }
    const customerLimit = Number(withinLimit.customerLimit || 0);
    const effectiveLimit = customerLimit > 0 ? customerLimit : 1;
    const usageFilter = andFilter({ coupon: withinLimit._id, user: userId }, withinLimit.storeId ? { storeId: withinLimit.storeId } : {});
    const usageUpdate = {
      $inc: { usedCount: 1 },
      $set: { firstOrderClaim: Boolean(withinLimit.firstOrderOnly) },
    };
    try {
      let reserved = await CouponCustomerUsage.findOneAndUpdate(
        { ...usageFilter, $or: [{ usedCount: { $lt: effectiveLimit } }, { usedCount: { $exists: false } }] },
        usageUpdate,
        { new: true, session },
      );
      if (!reserved) {
        const [created] = await CouponCustomerUsage.create([{
          coupon: withinLimit._id,
          user: userId,
          ...(withinLimit.storeId ? { storeId: withinLimit.storeId } : {}),
          usedCount: 1,
          firstOrderClaim: Boolean(withinLimit.firstOrderOnly),
        }], session ? { session } : {});
        reserved = created;
      }
    } catch (error) {
      await Coupon.updateOne({ _id: withinLimit._id }, { $inc: { usedCount: -1, spentAmount: -saving } }, { session }).catch(() => null);
      if (error?.code === 11000) throw new ApiError('INVALID_COUPON', withinLimit.firstOrderOnly ? 'A first-order offer is already reserved for this customer' : 'You have already used this coupon the maximum number of times');
      throw error;
    }
  }
  return withinLimit;
}

/** Gives a redemption back; never drives usedCount below zero. */
async function releaseCoupon(code, { session, tenantFilter = {}, userId, discountAmount = 0, couponId } = {}) {
  if (!code && !couponId) return null;
  const coupon = await Coupon.findOneAndUpdate(
    andFilter({ ...couponIdentityFilter(code, couponId), usedCount: { $gt: 0 } }, tenantFilter),
    { $inc: { usedCount: -1, spentAmount: -Math.max(0, Number(discountAmount || 0)) } },
    { new: true, session },
  );
  if (coupon && userId && (coupon.firstOrderOnly || Number(coupon.customerLimit || 0) > 0)) {
    await CouponCustomerUsage.findOneAndUpdate(
      andFilter({ coupon: coupon._id, user: userId, usedCount: { $gt: 0 } }, coupon.storeId ? { storeId: coupon.storeId } : {}),
      { $inc: { usedCount: -1 }, ...(coupon.firstOrderOnly ? { $set: { firstOrderClaim: false } } : {}) },
      { new: true, session },
    );
  }
  if (coupon && coupon.spentAmount < 0) {
    coupon.spentAmount = 0;
    await coupon.save({ session });
  }
  return coupon;
}

async function releaseCouponForFullyRefundedOrder(orderId, { session } = {}) {
  const order = await Order.findOneAndUpdate({
    _id: orderId,
    paymentStatus: 'Refunded',
    couponConsumed: true,
    couponReleased: { $ne: true },
    'coupon.restoreOnFullRefund': true,
  }, { $set: { couponReleased: true } }, { new: true, session });
  if (!order?.coupon?.code && !order?.coupon?.couponId) return false;
  try {
    await releaseCoupon(order.coupon?.code, {
      session, userId: order.user, couponId: order.coupon?.couponId,
      discountAmount: order.coupon?.savingAmount ?? order.coupon?.discountAmount,
      tenantFilter: order.coupon?.couponId ? {} : (order.storeId ? defaultStoreFilter(order.storeId) : {}),
    });
    return true;
  } catch (error) {
    await Order.updateOne({ _id: order._id, couponReleased: true }, { $set: { couponReleased: false } }, { session }).catch(() => null);
    throw error;
  }
}

module.exports = {
  calculateDiscount,
  consumeCoupon,
  evaluateCoupon,
  findBestAutomatic,
  prepareCustomerContext,
  releaseCoupon,
  releaseCouponForFullyRefundedOrder,
  validateAndPrice,
  validateCoupon,
};
