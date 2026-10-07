const crypto = require('node:crypto');
const Configuration = require('../models/OrderAlertConfiguration');
const Delivery = require('../models/OrderAlertDelivery');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Settings = require('../models/Settings');
const providers = require('./orderAlertProviders');
const { encryptSecret } = require('../utils/secretBox');
const { ApiError } = require('../utils/apiError');
const { defaultStoreFilter } = require('./storeService');

const secretFields = '+email.apiKey +whatsapp.accessToken';
const active = config => Boolean(config?.email?.enabled || config?.whatsapp?.enabled);
const invalid = message => { throw new ApiError('VALIDATION_ERROR', message); };
const clean = (value, max = 200) => {
  if (value !== undefined && typeof value !== 'string') invalid('Order alert text fields must contain text.');
  const text = (value || '').trim();
  if (text.length > max || /[\r\n\x00-\x1f]/.test(text)) invalid('Order alert text is too long or contains unsupported characters.');
  return text;
};
const emailValid = value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

async function read(storeId) {
  const config = await Configuration.findOne({ storeId }).select(secretFields).lean();
  const deliveries = await Delivery.find({ storeId }).select('-leaseToken').sort('-createdAt').limit(30).lean();
  return {
    revision: config?.revision || 0,
    enabledAt: config?.enabledAt || null,
    storefrontUrl: config?.storefrontUrl || '',
    email: { enabled: Boolean(config?.email?.enabled), recipient: config?.email?.recipient || '', senderEmail: config?.email?.senderEmail || '', senderName: config?.email?.senderName || '', hasApiKey: Boolean(config?.email?.apiKey) },
    whatsapp: { enabled: Boolean(config?.whatsapp?.enabled), recipient: config?.whatsapp?.recipient || '', phoneNumberId: config?.whatsapp?.phoneNumberId || '', templateName: config?.whatsapp?.templateName || '', language: config?.whatsapp?.language || 'en', consent: Boolean(config?.whatsapp?.consent), hasAccessToken: Boolean(config?.whatsapp?.accessToken) },
    deliveries: deliveries.map(({ _id, orderId, channel, status, test, attempts, reason, createdAt, nextAttemptAt, acceptedAt }) => ({ _id, orderId, channel, status, test, attempts, reason, createdAt, nextAttemptAt, acceptedAt })),
  };
}

async function save(storeId, input, actorId) {
  if (!input || Array.isArray(input) || typeof input !== 'object') invalid('Invalid order alert settings.');
  await Configuration.init();
  const previous = await Configuration.findOne({ storeId }).select(secretFields).lean();
  if (!Number.isInteger(input.revision) || input.revision !== (previous?.revision || 0)) throw new ApiError('DUPLICATE_REQUEST', 'Order alert settings changed. Reload and review your changes.');
  if (Object.keys(input).some(key => !['revision', 'storefrontUrl', 'email', 'whatsapp'].includes(key))) invalid('Unsupported order alert setting.');
  const email = { ...(previous?.email || {}), enabled: false }, whatsapp = { ...(previous?.whatsapp || {}), enabled: false };
  for (const [name, target, fields, secret] of [
    ['email', email, ['recipient', 'senderEmail', 'senderName'], 'apiKey'],
    ['whatsapp', whatsapp, ['recipient', 'phoneNumberId', 'templateName', 'language'], 'accessToken'],
  ]) {
    const value = input[name] || {};
    if (typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${name} settings.`);
    if (Object.keys(value).some(key => !['enabled', 'consent', ...fields, secret].includes(key))) invalid(`Unsupported ${name} setting.`);
    if (typeof value.enabled !== 'boolean') invalid(`Choose whether ${name} alerts are enabled.`);
    target.enabled = value.enabled;
    for (const field of fields) if (value[field] !== undefined) target[field] = clean(value[field], 254);
    if (value[secret] !== undefined && typeof value[secret] !== 'string') invalid('Provider credentials must contain text.');
    if (typeof value[secret] === 'string' && value[secret].trim()) {
      if (value[secret].length > 4096) invalid('Provider credential is too long.');
      target[secret] = encryptSecret(value[secret].trim());
    }
  }
  whatsapp.consent = input.whatsapp?.consent === true;
  whatsapp.recipient = String(whatsapp.recipient || '').replace(/[\s()-]/g, '');
  if (email.enabled && (!emailValid(email.recipient) || !emailValid(email.senderEmail) || !email.apiKey)) invalid('Email alerts need a valid recipient, verified sender email and Brevo API key.');
  if (whatsapp.enabled && (!/^\+[1-9]\d{7,14}$/.test(whatsapp.recipient) || !/^\d{5,30}$/.test(whatsapp.phoneNumberId || '') || !/^[a-z0-9_]{1,100}$/.test(whatsapp.templateName || '') || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(whatsapp.language || '') || !whatsapp.accessToken || !whatsapp.consent)) invalid('WhatsApp needs an international recipient (+country code), consent, phone-number ID, access token and approved template/language.');
  let storefrontUrl = clean(input.storefrontUrl, 500);
  if (storefrontUrl) {
    try {
      const parsed = new URL(storefrontUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      storefrontUrl = parsed.origin;
    } catch { invalid('Enter your storefront HTTPS URL without login details, query parameters or fragments.'); }
  }
  if ((email.enabled || whatsapp.enabled) && !storefrontUrl) invalid('Add the storefront URL for secure order links.');
  const values = { email, whatsapp, storefrontUrl, updatedBy: actorId,
    ...(!active(previous) && (email.enabled || whatsapp.enabled) ? { enabledAt: new Date() } : {}) };
  if (previous) {
    const result = await Configuration.updateOne({ _id: previous._id, revision: input.revision }, { $set: values, $inc: { revision: 1 } });
    if (!result.modifiedCount) throw new ApiError('DUPLICATE_REQUEST', 'Order alert settings changed. Reload and review your changes.');
  } else {
    try { await Configuration.create({ storeId, ...values, revision: 1 }); }
    catch (error) { if (error.code === 11000) throw new ApiError('DUPLICATE_REQUEST', 'Order alert settings changed. Reload and review your changes.'); throw error; }
  }
  return read(storeId);
}

function eligible(order) {
  return order && !['Cancelled', 'Refunded', 'Failed'].includes(order.orderStatus)
    && (order.paymentMethod === 'COD' || order.paymentStatus === 'Paid');
}

async function enqueue(order, config) {
  if (!eligible(order) || !active(config) || !config.enabledAt || new Date(order.createdAt) < new Date(config.enabledAt)) return;
  await Delivery.init();
  for (const [channel, settings] of [['EMAIL', config.email], ['WHATSAPP', config.whatsapp]]) {
    if (!settings?.enabled) continue;
    const dedupeKey = `${config.storeId}:${order._id}:${channel}`;
    try {
      await Delivery.updateOne({ dedupeKey }, { $setOnInsert: {
        storeId: config.storeId, orderId: order._id, channel, dedupeKey, recipient: settings.recipient,
        status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(),
      } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
  }
  // Only mark after every channel was durably queued. A partial failure is
  // recovered by the worker; unique keys prevent duplicate jobs.
  await Order.updateOne({ _id: order._id }, { $set: { ownerAlertQueued: true } }, { timestamps: false });
}

async function queueOrder(orderId) {
  const order = await Order.findById(orderId).select('+ownerAlertQueued').lean();
  if (!order || order.ownerAlertQueued || !eligible(order)) return;
  const store = order.storeId ? await Store.findById(order.storeId).select('_id').lean() : await Store.findOne({ isDefault: true }).select('_id').lean();
  if (!store) return;
  const config = await Configuration.findOne({ storeId: store._id }).lean();
  await enqueue(order, config);
}

function queueLater(orderId) {
  setImmediate(() => queueOrder(orderId).catch(() => console.warn('Order alert enqueue deferred; recovery worker will retry.')));
}

async function recover() {
  // Orders are the durable source of truth. Reconcile after a crash between
  // checkout commit and enqueue, without relying on fire-and-forget callbacks.
  const configs = Configuration.find({ $or: [{ 'email.enabled': true }, { 'whatsapp.enabled': true }] }).lean().cursor();
  for await (const config of configs) {
    if (!config.enabledAt) continue;
    const store = await Store.findById(config.storeId).select('isDefault').lean();
    if (!store) continue;
    const scope = store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id };
    const orders = await Order.find({ $and: [scope, {
      ownerAlertQueued: { $ne: true }, createdAt: { $gte: config.enabledAt },
      orderStatus: { $nin: ['Cancelled', 'Refunded', 'Failed'] },
      $or: [{ paymentMethod: 'COD' }, { paymentStatus: 'Paid' }],
    }] }).sort('createdAt').limit(50).lean();
    for (const order of orders) await enqueue(order, config);
  }
}

async function processOne(id) {
  const now = new Date(), leaseToken = crypto.randomUUID();
  const job = await Delivery.findOneAndUpdate({ ...(id ? { _id: id } : {}), status: { $in: ['QUEUED', 'RETRY'] }, nextAttemptAt: { $lte: now } }, {
    $set: { status: 'SENDING', leaseToken, leaseUntil: new Date(Date.now() + 60000) }, $inc: { attempts: 1 },
  }, { new: true, sort: { nextAttemptAt: 1 } }).select('+recipient');
  if (!job) return false;
  let update;
  try {
    const config = await Configuration.findOne({ storeId: job.storeId }).select(secretFields).lean();
    const channelConfig = job.channel === 'EMAIL' ? config?.email : config?.whatsapp;
    const store = await Store.findById(job.storeId).select('name isDefault').lean();
    const order = job.test || !store ? null : await Order.findOne({ $and: [{ _id: job.orderId }, store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }] }).lean();
    if (!channelConfig?.enabled || channelConfig.recipient !== job.recipient || (!job.test && !eligible(order))) {
      update = { status: 'SKIPPED', reason: 'Channel/recipient changed or order is no longer eligible.' };
    } else {
      if (!store) throw new Error('Store unavailable');
      const presentation = await Settings.findOne(store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }).select('storeName').lean();
      const number = job.test ? 'TEST-ORDER' : String(order.invoiceNumber || order._id).slice(-40);
      const route = store.isDefault ? '/admin/orders/detail' : '/seller/orders/detail';
      const message = {
        test: job.test, storeName: presentation?.storeName || store.name, number,
        amount: job.test ? 'INR 999.00' : `INR ${Number(order.finalAmount || 0).toFixed(2)}`,
        payment: job.test ? 'Test only - no order created' : order.paymentMethod === 'COD'
          ? order.codVerification?.required && order.codVerification.status !== 'VERIFIED' ? 'COD - verification pending' : 'Cash on delivery'
          : 'Paid online',
        itemCount: job.test ? 1 : (order.orderItems || []).reduce((count, item) => count + Number(item.quantity || 0), 0),
        link: `${config.storefrontUrl}${job.test ? (store.isDefault ? '/admin/orders' : '/seller/orders') : `${route}?id=${encodeURIComponent(String(order._id))}`}`,
      };
      const result = await providers.deliver(job.channel, config, job.recipient, message);
      update = { status: 'ACCEPTED', providerMessageId: result.messageId, acceptedAt: new Date(), reason: 'Accepted by provider; inbox/WhatsApp delivery is not independently verified.' };
    }
  } catch (error) {
    update = error.uncertain ? { status: 'UNCERTAIN', reason: error.message }
      : error.retryable && job.attempts < 5 ? { status: 'RETRY', nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** (job.attempts - 1))), reason: error.message }
      : { status: 'FAILED', reason: error.retryable ? 'Provider retry limit reached. Review settings and retry manually.' : 'Unable to send. Review provider credentials, approved template, sender and recipient.' };
  }
  await Delivery.updateOne({ _id: job._id, status: 'SENDING', leaseToken }, { $set: update, $unset: { leaseUntil: 1, leaseToken: 1 } });
  return true;
}

async function tick() {
  await Promise.all([Configuration.init(), Delivery.init()]);
  await Delivery.updateMany({ status: 'SENDING', leaseUntil: { $lte: new Date() } }, { $set: { status: 'UNCERTAIN', reason: 'Sending was interrupted. Check the provider before retrying to avoid duplicates.' }, $unset: { leaseUntil: 1, leaseToken: 1 } });
  await recover();
  for (let index = 0; index < 20; index += 1) if (!(await processOne())) break;
}

function startWorker() {
  let running = null, stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = tick().catch(() => console.warn('Order alert worker deferred; it will retry automatically.')).finally(() => { running = null; });
  };
  run();
  const timer = setInterval(run, 15000); timer.unref();
  return async () => { stopped = true; clearInterval(timer); if (running) await running; };
}

async function sendTest(storeId, channel) {
  if (!['EMAIL', 'WHATSAPP'].includes(channel)) invalid('Choose Email or WhatsApp.');
  const config = await Configuration.findOneAndUpdate({ storeId,
    [channel === 'EMAIL' ? 'email.enabled' : 'whatsapp.enabled']: true,
    $or: [{ lastTestAt: { $exists: false } }, { lastTestAt: null }, { lastTestAt: { $lte: new Date(Date.now() - 60000) } }],
  }, { $set: { lastTestAt: new Date() } }, { new: true }).lean();
  if (!config) invalid('Save and enable this channel first. Wait one minute between tests.');
  const job = await Delivery.create({ storeId, channel, test: true, dedupeKey: `test:${crypto.randomUUID()}`, recipient: channel === 'EMAIL' ? config.email.recipient : config.whatsapp.recipient });
  await processOne(job._id);
  return read(storeId);
}

async function retry(storeId, id, confirmUncertain) {
  const job = await Delivery.findOne({ _id: id, storeId });
  if (!job || !['FAILED', 'UNCERTAIN'].includes(job.status)) invalid('Only failed or uncertain alerts can be retried.');
  if (job.status === 'UNCERTAIN' && confirmUncertain !== true) invalid('Check the provider first, then confirm that retrying may send a duplicate.');
  const result = await Delivery.updateOne({ _id: id, storeId, status: job.status, attempts: job.attempts }, {
    $set: { status: 'QUEUED', nextAttemptAt: new Date(), reason: 'Manual retry requested.', attempts: 0 },
  });
  if (!result.modifiedCount) throw new ApiError('DUPLICATE_REQUEST', 'This alert changed. Refresh its status.');
  return read(storeId);
}

module.exports = { read, save, eligible, queueLater, queueOrder, recover, processOne, tick, startWorker, sendTest, retry };
