const mongoose = require('mongoose');
const { Schema } = mongoose;
const tenant = { type: Schema.Types.ObjectId, ref: 'Store', required: true, index: true };
const CONNECTION_STATUSES = ['connected', 'degraded', 'expired', 'revoked', 'disconnected'];
const MESSAGE_STATUSES = ['received', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown'];
const POST_STATUSES = ['draft', 'scheduled', 'queued', 'processing', 'published', 'partial', 'failed', 'review'];
const TARGET_STATUSES = ['queued', 'uploading', 'processing', 'publishing', 'verifying', 'published', 'failed', 'unknown', 'disconnected'];
const connection = new Schema({
  storeId: tenant, provider: { type: String, enum: ['facebook', 'instagram'], required: true },
  accountId: { type: String, required: true }, pageId: String, name: String, username: String,
  facebookUserId: String, token: { type: String, select: false }, permissions: [String],
  authMethod: { type: String, enum: ['facebook', 'instagram'], default: 'facebook' },
  apiHost: { type: String, enum: ['graph.facebook.com', 'graph.instagram.com'], default: 'graph.facebook.com' },
  status: { type: String, enum: CONNECTION_STATUSES, default: 'connected' }, lastError: String, lastErrorAt: Date, subscribed: Boolean,
  lastSyncedAt: Date, syncCursor: String, syncLease: Date, expiresAt: Date,
  lastHealthCheckAt: Date, nextHealthCheckAt: Date, reconnectNotifiedAt: Date,
  publishingUsage: {
    quotaUsage: { type: Number, min: 0 }, config: { type: Number, min: 0 }, checkedAt: Date,
  },
}, { timestamps: true });
// A Meta identity cannot silently be attached to another merchant's workspace.
connection.index({ provider: 1, accountId: 1 }, { unique: true });
connection.index({ status: 1, nextHealthCheckAt: 1 }, { name: 'social_account_health_due' });
const oauth = new Schema({
  storeId: tenant, userId: { type: Schema.Types.ObjectId, required: true }, workspace: String,
  loginProvider: { type: String, enum: ['facebook', 'instagram'], default: 'facebook' },
  stateHash: { type: String, unique: true }, ticketHash: String, nonceHash: String,
  phase: { type: String, default: 'created' }, encryptedAccounts: { type: String, select: false },
  facebookUserId: { type: String, select: false },
  expiresAt: { type: Date, expires: 0 },
}, { timestamps: true });
const thread = new Schema({
  storeId: tenant, connectionId: { type: Schema.Types.ObjectId, required: true }, provider: String,
  participantId: { type: String, required: true }, participantName: String, externalId: String,
  lastMessageAt: Date, lastInboundAt: Date, readAt: Date, preview: String,
  resolved: { type: Boolean, default: false }, historyCursor: String,
  priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], default: 'NORMAL' },
  labels: [{ type: String, trim: true, maxlength: 40 }],
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
  customer: { type: Schema.Types.ObjectId, ref: 'User' },
  snoozedUntil: Date,
  replyLease: { user: { type: Schema.Types.ObjectId, ref: 'User' }, expiresAt: Date },
  contextType: { type: String, enum: ['message', 'story', 'comment'], default: 'message' },
  contextId: String,
  internalNotes: [new Schema({
    text: { type: String, trim: true, maxlength: 1000, required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, trim: true, maxlength: 120 },
    createdAt: { type: Date, default: Date.now },
  }, { _id: true })],
}, { timestamps: true });
thread.index({ connectionId: 1, participantId: 1 }, { unique: true });
thread.index({ storeId: 1, lastMessageAt: -1, _id: -1 });
thread.index({ storeId: 1, resolved: 1, priority: 1, lastMessageAt: -1 }, { name: 'social_inbox_work_queue' });
thread.index({ storeId: 1, assignedTo: 1, resolved: 1, lastMessageAt: -1 }, { name: 'social_inbox_assignment' });
const message = new Schema({
  storeId: tenant, threadId: { type: Schema.Types.ObjectId, required: true, index: true },
  connectionId: Schema.Types.ObjectId, externalId: { type: String }, clientId: String,
  direction: { type: String, enum: ['inbound', 'outbound'] }, text: String,
  attachments: [new Schema({ type: String, url: String }, { _id: false })], sentAt: Date,
  status: { type: String, enum: MESSAGE_STATUSES, default: 'received' }, error: String,
  deliveredAt: Date, readAt: Date,
  reaction: { emoji: String, action: { type: String, enum: ['react', 'unreact'] }, updatedAt: Date },
  context: { type: { type: String }, id: String, url: String },
}, { timestamps: true });
message.index({ connectionId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });
message.index({ threadId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
const target = new Schema({
  connectionId: Schema.Types.ObjectId, provider: String, name: String,
  status: { type: String, enum: TARGET_STATUSES, default: 'queued' }, containerId: String, childIds: [String],
  externalId: String, permalink: String, error: String, startedAt: Date,
  caption: { type: String, maxlength: 2200 },
}, { _id: false });
const post = new Schema({
  storeId: tenant, createdBy: Schema.Types.ObjectId, productId: Schema.Types.ObjectId,
  productName: String, productPrice: Number, productUrl: String, caption: String,
  kind: { type: String, enum: ['photos', 'reel'], default: 'photos' }, images: [String],
  preparedImages: [String], videoUrl: String,
  videoStatus: { type: String, default: 'none' }, videoError: String,
  status: { type: String, enum: POST_STATUSES, default: 'draft' }, targets: [target],
  channelCaptions: {
    instagram: { type: String, maxlength: 2200 }, facebook: { type: String, maxlength: 2200 },
  },
  campaign: { type: String, trim: true, maxlength: 80 },
  scheduledFor: Date, scheduledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  submittedAt: Date,
  leaseUntil: Date, workerId: String, attempts: { type: Number, default: 0 },
  preparedAssetKeys: [String], assetsPurgedAt: Date,
  generationAssets: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, optimisticConcurrency: true });
post.index({ storeId: 1, createdAt: -1 });
post.index({ status: 1, scheduledFor: 1, leaseUntil: 1, updatedAt: 1 }, { name: 'social_post_worker_due' });

const webhookEvent = new Schema({
  eventHash: { type: String, required: true, unique: true },
  encryptedPayload: { type: String, required: true, select: false },
  status: { type: String, enum: ['pending', 'processing', 'processed', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0, min: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date, workerId: String, processedAt: Date, lastError: String,
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
webhookEvent.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }, { name: 'social_webhook_worker_due' });
module.exports = {
  Connection: mongoose.model('SocialAccount', connection), OAuth: mongoose.model('SocialOAuth', oauth),
  Thread: mongoose.model('SocialThread', thread), Message: mongoose.model('SocialMessage', message),
  Post: mongoose.model('SocialPost', post),
  WebhookEvent: mongoose.model('SocialWebhookEvent', webhookEvent),
  Deletion: mongoose.model('SocialDeletion', new Schema({ code: { type: String, unique: true }, expiresAt: { type: Date, expires: 0 } }, { timestamps: true })),
};
