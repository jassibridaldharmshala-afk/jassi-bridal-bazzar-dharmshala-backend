const ReportView = require('../models/ReportView');
const { roleAllows } = require('../models/StoreMember');
const { isMasterOwner } = require('../config/masterOwner');
const { asyncHandler } = require('../middleware/validate');
const { logAudit } = require('../services/auditService');
const { generateBundle, buildReportCsv } = require('../services/reportExportService');
const { createReportContext, generateSection, reportOptions, SECTIONS } = require('../services/reportingService');
const { nextRun, runScheduledView } = require('../services/reportScheduleService');
const { ApiError } = require('../utils/apiError');

const FILTER_KEYS = ['range', 'from', 'to', 'status', 'paymentMethod', 'product', 'category', 'coupon', 'campaign', 'source', 'city', 'pincode', 'provider', 'scope', 'store', 'device', 'browser'];
const isAdmin = (req) => req.user?.role === 'admin' && req.user.activeMode === 'admin';
const allows = (req, permission) => (isAdmin(req) && !req.storeMember) || roleAllows(req.storeMember?.role, permission);

function capabilities(req) {
  const sections = {
    summary: allows(req, 'reports.read'),
    products: allows(req, 'reports.manage') || allows(req, 'catalog.read') || allows(req, 'inventory.read'),
    customers: allows(req, 'reports.manage') || allows(req, 'crm.read'),
    marketing: allows(req, 'reports.manage') || allows(req, 'marketing.read'),
    traffic: allows(req, 'reports.read'),
    fulfillment: allows(req, 'reports.manage') || allows(req, 'orders.read') || allows(req, 'returns.read'),
  };
  return {
    canRead: allows(req, 'reports.read'),
    canExport: allows(req, 'reports.export'),
    canViewProfit: allows(req, 'reports.profit.read'),
    canManage: allows(req, 'reports.manage'),
    canSchedule: allows(req, 'reports.manage') && allows(req, 'reports.export') && Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL),
    sections,
  };
}

function allowedSections(req) {
  const access = capabilities(req).sections;
  return SECTIONS.filter((section) => access[section]);
}

function reportScope(req) {
  if (String(req.query.scope || req.body?.filters?.scope || '') === 'all') {
    if (!isAdmin(req) || !isMasterOwner(req.user)) throw new ApiError('FORBIDDEN', 'Only the platform owner can view reports across all stores.');
    return { tenantFilter: {}, store: null, allStores: true };
  }
  return { tenantFilter: req.tenantFilter || {}, store: req.store || null, allStores: false };
}

async function contextFor(req, query = req.query) {
  const scope = reportScope({ ...req, query, body: req.body });
  return { ...await createReportContext({ query, tenantFilter: scope.tenantFilter, store: scope.store }), allStores: scope.allStores };
}

function redactProfit(section, response, allowed) {
  response.capabilities = { ...response.capabilities, canViewProfit: allowed };
  if (allowed) return response;
  if (section === 'summary') {
    delete response.data.metrics?.estimatedProfit;
    ['cost', 'costCoveredUnits', 'costCoverage', 'estimatedProfit', 'estimatedMargin'].forEach((key) => { delete response.data.current?.[key]; delete response.data.previous?.[key]; });
    delete response.data.definitions?.estimatedProfit;
  }
  if (section === 'products') {
    response.data.items?.forEach((item) => ['estimatedCost', 'estimatedProfit', 'estimatedMargin', 'costCoverage'].forEach((key) => delete item[key]));
    response.data.slowMoving?.forEach((item) => { delete item.costPrice; });
    if (response.data.inventory) delete response.data.inventory.valueAtCost;
    delete response.data.definitions?.profit;
  }
  return response;
}

function safeFilters(source = {}) {
  return Object.fromEntries(FILTER_KEYS.filter((key) => source[key] !== undefined && source[key] !== '').map((key) => [key, String(source[key]).slice(0, 160)]));
}

function savedScope(req, allStores = false) {
  if (allStores) return { storeId: null, createdBy: req.user._id };
  if (!req.store?._id) throw new ApiError('VALIDATION_ERROR', 'Choose a store before saving this report.');
  return { storeId: req.store._id, createdBy: req.user._id };
}

function viewResponse(view) {
  return {
    id: String(view._id), name: view.name, filters: view.filters || {}, sections: view.sections || SECTIONS,
    schedule: view.schedule || {}, createdAt: view.createdAt, updatedAt: view.updatedAt,
  };
}

exports.options = asyncHandler(async (req, res) => {
  const scope = reportScope(req);
  const data = await reportOptions({ tenantFilter: scope.tenantFilter, includeStores: isAdmin(req) && isMasterOwner(req.user) });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({ ...data, capabilities: capabilities(req), currentStore: req.store ? { id: String(req.store._id), name: req.store.name, slug: req.store.slug, timezone: req.store.timezone, currency: req.store.currency } : null });
});

exports.section = asyncHandler(async (req, res) => {
  const section = String(req.params.section || '').toLowerCase();
  if (!allowedSections(req).includes(section)) throw new ApiError('FORBIDDEN', 'You do not have permission to view this report section.');
  const context = await contextFor(req);
  const response = await generateSection(section, context);
  response.scope = context.allStores ? 'all' : 'store'; response.store = context.store ? { id: String(context.store._id), name: context.store.name, slug: context.store.slug } : null;
  response.capabilities = capabilities(req);
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json(redactProfit(section, response, response.capabilities.canViewProfit));
});

exports.exportReport = asyncHandler(async (req, res) => {
  const access = capabilities(req);
  if (!access.canExport) throw new ApiError('FORBIDDEN', 'You do not have permission to export reports.');
  const query = safeFilters(req.body?.filters || {});
  const context = await contextFor({ ...req, query, body: { filters: query } }, query);
  const permitted = allowedSections(req);
  const sections = (Array.isArray(req.body?.sections) ? req.body.sections : permitted).filter((section) => permitted.includes(section));
  if (!sections.length) throw new ApiError('FORBIDDEN', 'You do not have permission to export the selected report sections.');
  const bundle = await generateBundle(context, sections);
  Object.entries(bundle.sections).forEach(([section, response]) => redactProfit(section, response, access.canViewProfit));
  const csv = buildReportCsv(bundle);
  await logAudit({ req, action: 'REPORT_EXPORT', entityType: 'Report', entityId: `${context.range.fromDate}-${context.range.toDate}`, storeId: context.store?._id, after: { sections: Object.keys(bundle.sections), filters: query, scope: context.allStores ? 'all' : 'store' } });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({ filename: `reports-${context.range.fromDate}-${context.range.toDate}.csv`, csv, bundle });
});

exports.listViews = asyncHandler(async (req, res) => {
  const allStores = String(req.query.scope || '') === 'all';
  if (allStores && (!isAdmin(req) || !isMasterOwner(req.user))) throw new ApiError('FORBIDDEN', 'Only the platform owner can manage all-store reports.');
  const views = await ReportView.find(savedScope(req, allStores)).sort({ updatedAt: -1 }).lean();
  res.json({ items: views.map(viewResponse), capabilities: capabilities(req) });
});

exports.createView = asyncHandler(async (req, res) => {
  if (!capabilities(req).canManage) throw new ApiError('FORBIDDEN', 'You do not have permission to save report views.');
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) throw new ApiError('VALIDATION_ERROR', 'Enter a report view name.');
  const filters = safeFilters(req.body?.filters || {});
  const allStores = filters.scope === 'all';
  if (allStores && (!isAdmin(req) || !isMasterOwner(req.user))) throw new ApiError('FORBIDDEN', 'Only the platform owner can save all-store reports.');
  const permitted = allowedSections(req);
  const sections = [...new Set((Array.isArray(req.body?.sections) ? req.body.sections : permitted).filter((item) => permitted.includes(item)))];
  if (!sections.length) throw new ApiError('VALIDATION_ERROR', 'Choose at least one report section.');
  const frequency = String(req.body?.schedule?.frequency || 'NONE').toUpperCase();
  if (!['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid report schedule.');
  const recipient = String(req.body?.schedule?.recipient || '').trim().toLowerCase().slice(0, 160);
  if (frequency !== 'NONE' && !/^\S+@\S+\.\S+$/.test(recipient)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid report recipient email.');
  if (frequency !== 'NONE' && (filters.from || filters.to)) throw new ApiError('VALIDATION_ERROR', 'Scheduled reports need a rolling preset such as 7, 30 or 90 days.');
  if (frequency !== 'NONE' && !capabilities(req).canSchedule) throw new ApiError('REPORT_EMAIL_NOT_CONFIGURED', 'Configure Brevo transactional email before enabling scheduled reports.');
  try {
    const view = await ReportView.create({ ...savedScope(req, allStores), name, filters, sections, createdBy: req.user._id, schedule: { frequency, recipient, enabled: frequency !== 'NONE', nextRunAt: nextRun(frequency) } });
    await logAudit({ req, action: 'REPORT_VIEW_CREATE', entityType: 'ReportView', entityId: view._id, storeId: view.storeId, after: { name, frequency, sections } });
    res.status(201).json(viewResponse(view));
  } catch (error) {
    if (error?.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'A saved report with this name already exists.');
    throw error;
  }
});

exports.updateView = asyncHandler(async (req, res) => {
  if (!capabilities(req).canManage) throw new ApiError('FORBIDDEN', 'You do not have permission to manage report views.');
  const view = await ReportView.findOne({ _id: req.params.id, ...savedScope(req, String(req.body?.filters?.scope || req.query.scope || '') === 'all') });
  if (!view) throw new ApiError('NOT_FOUND', 'Saved report not found.', { statusCode: 404 });
  if (req.body.name !== undefined) { view.name = String(req.body.name || '').trim().slice(0, 80); if (!view.name) throw new ApiError('VALIDATION_ERROR', 'Enter a report view name.'); }
  if (req.body.filters) view.filters = safeFilters(req.body.filters);
  if (Array.isArray(req.body.sections)) { const permitted = allowedSections(req); const sections = [...new Set(req.body.sections.filter((item) => permitted.includes(item)))]; if (!sections.length) throw new ApiError('VALIDATION_ERROR', 'Choose at least one permitted report section.'); view.sections = sections; }
  if (req.body.schedule) {
    const frequency = String(req.body.schedule.frequency || 'NONE').toUpperCase(); const recipient = String(req.body.schedule.recipient || '').trim().toLowerCase().slice(0, 160);
    if (!['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid report schedule.');
    if (frequency !== 'NONE' && !/^\S+@\S+\.\S+$/.test(recipient)) throw new ApiError('VALIDATION_ERROR', 'Enter a valid report recipient email.');
    if (frequency !== 'NONE' && (view.filters?.from || view.filters?.to)) throw new ApiError('VALIDATION_ERROR', 'Scheduled reports need a rolling date preset.');
    if (frequency !== 'NONE' && !capabilities(req).canSchedule) throw new ApiError('REPORT_EMAIL_NOT_CONFIGURED', 'Configure Brevo transactional email before enabling scheduled reports.');
    view.schedule = { ...view.schedule?.toObject?.(), frequency, recipient, enabled: frequency !== 'NONE', nextRunAt: nextRun(frequency), lastStatus: view.schedule?.lastStatus || 'NEVER' };
  }
  await view.save();
  await logAudit({ req, action: 'REPORT_VIEW_UPDATE', entityType: 'ReportView', entityId: view._id, storeId: view.storeId, after: { name: view.name, frequency: view.schedule?.frequency, sections: view.sections } });
  res.json(viewResponse(view));
});

exports.deleteView = asyncHandler(async (req, res) => {
  if (!capabilities(req).canManage) throw new ApiError('FORBIDDEN', 'You do not have permission to delete report views.');
  const allStores = String(req.query.scope || '') === 'all';
  const view = await ReportView.findOneAndDelete({ _id: req.params.id, ...savedScope(req, allStores) });
  if (!view) throw new ApiError('NOT_FOUND', 'Saved report not found.', { statusCode: 404 });
  await logAudit({ req, action: 'REPORT_VIEW_DELETE', entityType: 'ReportView', entityId: view._id, storeId: view.storeId, before: { name: view.name } });
  res.json({ success: true });
});

exports.runView = asyncHandler(async (req, res) => {
  if (!capabilities(req).canManage) throw new ApiError('FORBIDDEN', 'You do not have permission to send scheduled reports.');
  const allStores = String(req.query.scope || '') === 'all';
  const view = await ReportView.findOne({ _id: req.params.id, ...savedScope(req, allStores) });
  if (!view) throw new ApiError('NOT_FOUND', 'Saved report not found.', { statusCode: 404 });
  if (!view.schedule?.recipient) throw new ApiError('VALIDATION_ERROR', 'Add a recipient email before sending this report.');
  if (!capabilities(req).canSchedule) throw new ApiError('REPORT_EMAIL_NOT_CONFIGURED', 'Configure Brevo transactional email before sending scheduled reports.');
  await runScheduledView(view.toObject());
  view.schedule.lastRunAt = new Date(); view.schedule.lastStatus = 'SENT'; view.schedule.lastError = '';
  if (view.schedule.enabled) view.schedule.nextRunAt = nextRun(view.schedule.frequency);
  await view.save();
  res.json(viewResponse(view));
});

exports.capabilities = capabilities;
