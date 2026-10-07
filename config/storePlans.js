const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = Math.max(1, Number.parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS || '30', 10) || 30);

const BASE_PLANS = {
  BASIC: {
    id: 'BASIC', name: 'Starter', description: 'The essentials for a new online store.',
    features: ['catalog', 'orders', 'inventory', 'coupons', 'whatsapp'],
    limits: { products: 100, ordersPerMonth: 150 },
    prices: { monthly: 999, yearly: 9990, lifetime: 24999 },
  },
  PROFESSIONAL: {
    id: 'PROFESSIONAL', name: 'Professional', description: 'Automation, analytics and customer tools for a growing store.',
    features: ['catalog', 'orders', 'inventory', 'coupons', 'whatsapp', 'socialImport', 'aiProduct', 'crm', 'abandonedCart', 'analytics', 'festival', 'advancedCustomization', 'socialStudio'],
    limits: { products: 1000, ordersPerMonth: 2000 },
    prices: { monthly: 1999, yearly: 19990, lifetime: 49999 },
  },
  PREMIUM: {
    id: 'PREMIUM', name: 'Premium', description: 'Higher limits and the complete operations toolkit.',
    features: ['catalog', 'orders', 'inventory', 'coupons', 'whatsapp', 'socialImport', 'aiProduct', 'crm', 'abandonedCart', 'analytics', 'festival', 'businessAssistant', 'socialStudio', 'advancedCustomization', 'shippingAutomation', 'multiStaff'],
    limits: { products: 10000, ordersPerMonth: 20000 },
    prices: { monthly: 3499, yearly: 34990, lifetime: 89999 },
  },
};

function configuredPrice(planId, cycle, fallback) {
  const key = `SUBSCRIPTION_${planId}_${cycle.toUpperCase()}_INR`;
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback;
}

const STORE_PLANS = Object.freeze(Object.fromEntries(Object.entries(BASE_PLANS).map(([id, plan]) => [id, Object.freeze({
  ...plan,
  features: Object.freeze([...plan.features]),
  limits: Object.freeze({ ...plan.limits }),
  prices: Object.freeze({
    monthly: configuredPrice(id, 'monthly', plan.prices.monthly),
    yearly: configuredPrice(id, 'yearly', plan.prices.yearly),
    lifetime: configuredPrice(id, 'lifetime', plan.prices.lifetime),
  }),
})])));

const PLAN_IDS = Object.keys(STORE_PLANS);
const LICENSE_STATUSES = ['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED'];
const BILLING_CYCLES = ['TRIAL', 'MONTHLY', 'YEARLY', 'LIFETIME', 'MANUAL'];
const LIMIT_KEYS = ['products', 'ordersPerMonth'];

function normalizePlan(value, fallback = 'BASIC') {
  const plan = String(value || '').trim().toUpperCase();
  return STORE_PLANS[plan] ? plan : fallback;
}

function normalizeBillingCycle(value, fallback = 'TRIAL') {
  const cycle = String(value || '').trim().toUpperCase();
  return BILLING_CYCLES.includes(cycle) ? cycle : fallback;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function trialEndsAt(store) {
  return validDate(store?.license?.trialEndsAt)
    || validDate(store?.license?.endsAt)
    || new Date((validDate(store?.license?.startsAt) || validDate(store?.createdAt) || new Date()).getTime() + TRIAL_DAYS * DAY_MS);
}

function effectiveEndsAt(store) {
  const fallbackCycle = String(store?.license?.status || '').toUpperCase() === 'TRIAL' ? 'TRIAL' : 'MANUAL';
  const cycle = normalizeBillingCycle(store?.license?.billingCycle, fallbackCycle);
  if (cycle === 'LIFETIME') return null;
  return String(store?.license?.status || '').toUpperCase() === 'TRIAL' ? trialEndsAt(store) : validDate(store?.license?.endsAt);
}

function licenseStatus(store, now = new Date()) {
  const configured = String(store?.license?.status || '').toUpperCase();
  if (configured === 'SUSPENDED') return 'SUSPENDED';
  const endsAt = effectiveEndsAt(store);
  if (endsAt && endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (LICENSE_STATUSES.includes(configured)) return configured;
  return 'ACTIVE';
}

function resolvedLimits(store, plan) {
  const overrides = store?.license?.limitOverrides || {};
  return Object.fromEntries(LIMIT_KEYS.map((key) => {
    const override = Number(overrides instanceof Map ? overrides.get(key) : overrides[key]);
    return [key, Number.isFinite(override) && override >= 0 ? Math.floor(override) : plan.limits[key]];
  }));
}

function planSummary(store, now = new Date()) {
  const planId = normalizePlan(store?.plan, store?.isDefault ? 'PREMIUM' : 'PROFESSIONAL');
  const base = STORE_PLANS[planId];
  const overrides = Array.isArray(store?.license?.featureOverrides) ? store.license.featureOverrides : [];
  const disabled = new Set(Array.isArray(store?.license?.disabledFeatures) ? store.license.disabledFeatures : []);
  const endsAt = effectiveEndsAt(store);
  const status = licenseStatus(store, now);
  const billingCycle = normalizeBillingCycle(store?.license?.billingCycle, status === 'TRIAL' ? 'TRIAL' : 'MANUAL');
  return {
    id: planId,
    name: base.name,
    description: base.description,
    status,
    billingCycle,
    startsAt: store?.license?.startsAt || null,
    endsAt,
    trialDays: TRIAL_DAYS,
    daysRemaining: endsAt && status !== 'EXPIRED' ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS)) : null,
    renewalMessage: String(store?.license?.renewalMessage || '').trim(),
    featureOverrides: [...overrides],
    features: [...new Set([...base.features, ...overrides])].filter((feature) => !disabled.has(feature)),
    disabledFeatures: [...disabled],
    limits: resolvedLimits(store, base),
    limitOverrides: Object.fromEntries(LIMIT_KEYS.map((key) => {
      const source = store?.license?.limitOverrides || {};
      const value = source instanceof Map ? source.get(key) : source[key];
      return [key, Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null];
    })),
    prices: { ...base.prices },
    lastPayment: store?.license?.lastPayment || null,
  };
}

function hasStoreFeature(store, feature) {
  const summary = planSummary(store);
  return !['EXPIRED', 'SUSPENDED'].includes(summary.status) && summary.features.includes(feature);
}

function storeLimit(store, key) {
  if (!LIMIT_KEYS.includes(key)) return null;
  return planSummary(store).limits[key];
}

function nextPeriodEnd(cycle, from = new Date()) {
  const normalized = normalizeBillingCycle(cycle);
  if (normalized === 'LIFETIME') return null;
  const end = new Date(from);
  if (normalized === 'MONTHLY') {
    const day = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  } else if (normalized === 'YEARLY') {
    const month = end.getUTCMonth();
    const day = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCMonth(month);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), month + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  }
  else if (normalized === 'TRIAL') end.setUTCDate(end.getUTCDate() + TRIAL_DAYS);
  else return null;
  return end;
}

module.exports = {
  BILLING_CYCLES, LICENSE_STATUSES, LIMIT_KEYS, PLAN_IDS, STORE_PLANS, TRIAL_DAYS,
  effectiveEndsAt, hasStoreFeature, licenseStatus, nextPeriodEnd, normalizeBillingCycle,
  normalizePlan, planSummary, storeLimit,
};
