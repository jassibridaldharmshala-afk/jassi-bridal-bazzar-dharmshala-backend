const ReportView = require('../models/ReportView');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const User = require('../models/User');
const { roleAllows } = require('../models/StoreMember');
const { hasStoreFeature } = require('../config/storePlans');
const { isOwnerAccount } = require('../config/masterOwner');
const { isMasterOwner } = require('../config/masterOwner');
const { escapeHtml } = require('./orderAlertProviders');
const { defaultStoreFilter } = require('./storeService');
const { createReportContext } = require('./reportingService');
const { buildReportCsv, generateBundle } = require('./reportExportService');
const { sendTransactionalEmail } = require('./emailService');
const { logAudit } = require('./auditService');

let worker;
let running = false;

function nextRun(frequency, from = new Date()) {
  const date = new Date(from);
  date.setSeconds(0, 0);
  if (frequency === 'DAILY') date.setDate(date.getDate() + 1);
  else if (frequency === 'WEEKLY') date.setDate(date.getDate() + 7);
  else if (frequency === 'MONTHLY') {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }
  else return undefined;
  return date;
}

async function assertViewAccess(view, store) {
  if (view.storeId && !store) throw new Error('The report store no longer exists.');
  const user = await User.findById(view.createdBy).select('+systemRole role activeMode phone isPhoneVerified isBlocked').lean();
  if (!user || user.isBlocked || !user.isPhoneVerified) throw new Error('The report owner no longer has an active account.');
  if (!store) {
    if (!(user.role === 'admin' && user.activeMode === 'admin' && user.systemRole === 'MASTER_OWNER' && isOwnerAccount(user))) throw new Error('All-store report permission is no longer active.');
    return;
  }
  if (user.role === 'admin' && user.activeMode === 'admin' && (store.isDefault || isMasterOwner(user))) return;
  const membership = await StoreMember.findOne({ store: store._id, user: user._id, status: 'ACTIVE' }).lean();
  if (!membership || !roleAllows(membership.role, 'reports.manage') || !roleAllows(membership.role, 'reports.export')) throw new Error('The report owner no longer has permission to email reports.');
  if (!hasStoreFeature(store, 'analytics')) throw new Error('Analytics is not active for this store.');
  if (store.catalogStructure?.clientPermissions?.reports === false) throw new Error('Reports are disabled for this store.');
}

async function runScheduledView(view) {
  const store = view.storeId ? await Store.findById(view.storeId).lean() : null;
  await assertViewAccess(view, store);
  const tenantFilter = store ? (store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }) : {};
  const context = await createReportContext({ query: view.filters || {}, tenantFilter, store });
  const bundle = await generateBundle(context, view.sections);
  const csv = buildReportCsv(bundle);
  const primary = bundle.sections.summary || Object.values(bundle.sections)[0];
  const period = primary?.range || context.range;
  const timezone = primary?.timezone || context.timezone;
  await sendTransactionalEmail({
    to: view.schedule.recipient,
    subject: `${store?.name || 'Managed stores'} report: ${view.name}`,
    htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2937"><h2>${escapeHtml(view.name)}</h2><p>Your scheduled report is attached.</p><p>Period: ${period.fromDate} to ${period.toDate} (${escapeHtml(timezone)}).</p></div>`,
    attachments: [{ name: `report-${period.fromDate}-${period.toDate}.csv`, content: csv }],
  });
  await logAudit({ action: 'REPORT_SCHEDULE_SENT', entityType: 'ReportView', entityId: view._id, storeId: view.storeId, source: 'SYSTEM', after: { name: view.name, recipient: view.schedule.recipient, frequency: view.schedule.frequency } });
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await ReportView.find({ 'schedule.enabled': true, 'schedule.nextRunAt': { $lte: new Date() } }).limit(10).lean();
    for (const candidate of due) {
      const leaseUntil = new Date(Date.now() + 15 * 60 * 1000);
      const claimed = await ReportView.findOneAndUpdate(
        { _id: candidate._id, 'schedule.enabled': true, 'schedule.nextRunAt': candidate.schedule.nextRunAt },
        { $set: { 'schedule.nextRunAt': leaseUntil } }, { new: true },
      ).lean();
      if (!claimed) continue;
      try {
        await runScheduledView(claimed);
        await ReportView.updateOne({ _id: claimed._id }, { $set: { 'schedule.lastRunAt': new Date(), 'schedule.lastStatus': 'SENT', 'schedule.lastError': '', 'schedule.nextRunAt': nextRun(claimed.schedule.frequency) } });
      } catch (error) {
        await ReportView.updateOne({ _id: claimed._id }, { $set: { 'schedule.lastRunAt': new Date(), 'schedule.lastStatus': 'FAILED', 'schedule.lastError': String(error.message || 'Report delivery failed').slice(0, 300), 'schedule.nextRunAt': nextRun(claimed.schedule.frequency) } });
      }
    }
  } finally { running = false; }
}

function startReportScheduleWorker() {
  if (worker || process.env.NODE_ENV === 'test') return stopReportScheduleWorker;
  const configured = Number(process.env.REPORT_SCHEDULE_INTERVAL_MS || 300000);
  const interval = Number.isFinite(configured) ? Math.min(86400000, Math.max(60000, configured)) : 300000;
  tick().catch(() => {});
  worker = setInterval(() => tick().catch(() => {}), interval);
  worker.unref();
  return stopReportScheduleWorker;
}

function stopReportScheduleWorker() {
  if (worker) clearInterval(worker);
  worker = null;
}

module.exports = { nextRun, runScheduledView, startReportScheduleWorker, stopReportScheduleWorker, tick };
