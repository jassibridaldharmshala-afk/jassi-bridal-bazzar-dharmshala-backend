const { asyncHandler } = require('../middleware/validate');
const { ApiError } = require('../utils/apiError');
const { STORE_PLANS, hasStoreFeature, planSummary } = require('../config/storePlans');
const controlPlane = require('../services/controlPlaneClient');
const { logAudit } = require('../services/auditService');
const {
  answerBusinessQuestion,
  buildBusinessHealth,
  createCustomerOffer,
  createRecoveryReminder,
  listAbandonedCarts,
  updateFestivalCampaign,
} = require('../services/businessOperationsService');

async function effectivePlatform(req) {
  if (!controlPlane.configuration().managed) return planSummary(req.store);
  const status = req.platformLicense || await controlPlane.licenseStatus();
  const planId = String(status.plan || status.id || '').toUpperCase();
  const plan = STORE_PLANS[planId];
  return {
    id: planId || 'MANAGED',
    name: plan?.name || planId || 'Managed',
    description: plan?.description || 'Access managed by the platform owner.',
    status: status.status,
    billingCycle: status.billingCycle || null,
    startsAt: status.startsAt || null,
    endsAt: status.endsAt || null,
    daysRemaining: status.daysRemaining ?? null,
    renewalMessage: status.renewalMessage || '',
    features: Array.isArray(status.features) ? status.features : [],
    limits: status.limits || {},
    managed: true,
    source: status.source,
  };
}

async function requireFeature(req, feature) {
  const plan = await effectivePlatform(req);
  const allowed = plan.managed
    ? !['EXPIRED', 'SUSPENDED', 'REVOKED'].includes(plan.status) && plan.features.includes(feature)
    : hasStoreFeature(req.store, feature);
  if (!allowed) {
    const reason = ['EXPIRED', 'SUSPENDED', 'REVOKED'].includes(plan.status)
      ? `The ${plan.name} licence is ${plan.status.toLowerCase()}.`
      : `This tool is not included in the ${plan.name} plan.`;
    throw new ApiError('FORBIDDEN', `${reason} Ask the platform owner to update the store plan.`);
  }
  return plan;
}

exports.overview = asyncHandler(async (req, res) => {
  const [health, platform] = await Promise.all([
    buildBusinessHealth(req.store, req.query || {}),
    effectivePlatform(req),
  ]);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    store: { id: String(req.store._id), name: req.store.name, slug: req.store.slug, industry: req.store.industry, status: req.store.status },
    platform,
    festivalCampaign: req.store.festivalCampaign || { enabled: false },
    health,
  });
});

exports.abandonedCarts = asyncHandler(async (req, res) => {
  await requireFeature(req, 'abandonedCart');
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(await listAbandonedCarts(req.store, req.query));
});

exports.remindAbandonedCart = asyncHandler(async (req, res) => {
  await requireFeature(req, 'abandonedCart');
  const result = await createRecoveryReminder(req.store, req.params.id, req.body || {});
  await logAudit({
    req,
    action: result.channel === 'IN_APP' ? 'ABANDONED_CART_REMINDER' : 'ABANDONED_CART_WHATSAPP_PREPARED',
    entityType: 'Cart',
    entityId: req.params.id,
    after: { channel: result.channel, sent: Boolean(result.sent) },
  });
  res.json(result);
});

exports.assistant = asyncHandler(async (req, res) => {
  await requireFeature(req, 'businessAssistant');
  res.set('Cache-Control', 'private, no-store, max-age=0');
  const result = await answerBusinessQuestion(req.store, req.body?.question);
  await logAudit({
    req,
    action: 'BUSINESS_ASSISTANT_QUERY',
    entityType: 'Store',
    entityId: req.store._id,
    summary: result.question,
    after: { question: result.question, answer: result.answer, actions: result.actions },
  });
  res.json(result);
});

exports.customerOffer = asyncHandler(async (req, res) => {
  await requireFeature(req, 'crm');
  const result = await createCustomerOffer(req.store, req.body || {});
  await logAudit({
    req,
    action: result.channel === 'IN_APP' ? 'CRM_OFFER_SENT' : 'CRM_WHATSAPP_PREPARED',
    entityType: 'CustomerCrm',
    after: { channel: result.channel, sent: result.sent || 0, prepared: result.prepared || 0, customerCount: req.body?.customerIds?.length || 0 },
  });
  res.json(result);
});

exports.updateFestival = asyncHandler(async (req, res) => {
  await requireFeature(req, 'festival');
  const campaign = await updateFestivalCampaign(req.store, req.body || {});
  await logAudit({ req, action: 'FESTIVAL_CAMPAIGN_UPDATE', entityType: 'Store', entityId: req.store._id, after: campaign });
  res.json(campaign);
});
