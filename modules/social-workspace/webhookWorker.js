const crypto = require('crypto');
const { WebhookEvent } = require('./models');
const { decryptSecret } = require('../../utils/secretBox');

let running = false;
let timer;
async function tick() {
  if (running) return false;
  running = true;
  const workerId = crypto.randomUUID();
  try {
    const now = new Date();
    const event = await WebhookEvent.findOneAndUpdate({ status: { $in: ['pending', 'processing'] }, nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $set: { status: 'processing', workerId, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).select('+encryptedPayload');
    if (!event) return false;
    try {
      await require('./inbox').processWebhookPayload(JSON.parse(decryptSecret(event.encryptedPayload)));
      await WebhookEvent.updateOne({ _id: event._id, workerId }, { $set: { status: 'processed', processedAt: new Date(), lastError: '' }, $unset: { workerId: 1, leaseUntil: 1, encryptedPayload: 1 } });
    } catch (error) {
      const terminal = event.attempts >= 5;
      await WebhookEvent.updateOne({ _id: event._id, workerId }, { $set: { status: terminal ? 'failed' : 'pending', lastError: String(error.message || error).slice(0, 500), nextAttemptAt: new Date(Date.now() + Math.min(15 * 60000, 15000 * (2 ** Math.max(0, event.attempts - 1)))) }, $unset: { workerId: 1, leaseUntil: 1 } });
    }
    return true;
  } finally { running = false; }
}
function kick() { setImmediate(async () => { while (await tick().catch(() => false)) { /* drain pending events */ } }); }
function startWorker() { if (!timer) { timer = setInterval(kick, 30000); timer.unref(); kick(); } }
function stopWorker() { if (timer) clearInterval(timer); timer = null; }
module.exports = { tick, kick, startWorker, stopWorker };
