const crypto = require('crypto');
const { Connection, Post, Message } = require('./models');
const Product = require('../../models/Product');
const { defaultStoreFilter } = require('../../services/storeService');
const { decryptSecret } = require('../../utils/secretBox');
const meta = require('./meta');
const media = require('./media');
const { notifyLater } = require('../../services/notificationService');
const { createRecordOnce, invalidateRecordCreation } = require('../../services/recordCreationService');
function catalogFilter(store) { return store.isDefault ? defaultStoreFilter(store._id) : { storeId: store._id }; }
function productImages(product) { return [...new Set([product.primaryImage, ...(product.images || []).map(i => i.url)].filter(Boolean))].slice(0, 20); }
function productLink(product, store) {
  return `${meta.config().frontend}${store.isDefault ? '/product/' : '/store/' + encodeURIComponent(store.slug) + '/product/'}${encodeURIComponent(product.slug)}`;
}
async function products(req, res) {
  const search = String(req.query.search || '').slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
  const products = await Product.find({ $and: [catalogFilter(req.socialStore), { isActive: true, isArchived: { $ne: true }, ...(search ? { name: new RegExp(search, 'i') } : {}) }] }).select('name slug price images primaryImage shortDescription brand').sort({ createdAt: -1 }).skip(page * 24).limit(25).lean();
  res.json({ products: products.slice(0, 24).map(p => ({ ...p, images: productImages(p), url: productLink(p, req.socialStore) })), hasMore: products.length > 24 });
}
async function saveDraft(req, res) {
  const product = await Product.findOne({ $and: [catalogFilter(req.socialStore), { _id: req.body.productId, isActive: true, isArchived: { $ne: true } }] });
  if (!product) throw meta.fail('Choose an active product from this store.', 404);
  const allowed = productImages(product), images = Array.isArray(req.body.images) ? [...new Set(req.body.images)] : allowed.slice(0, 4);
  if (!images.length || images.length > 6 || images.some(url => !allowed.includes(url))) throw meta.fail('Select 1 to 6 photos belonging to this product.');
  const caption = String(req.body.caption ?? `${product.name}\nRs. ${product.price.toLocaleString('en-IN')}\n\n${productLink(product, req.socialStore)}`).trim();
  if (!caption || caption.length > 2200) throw meta.fail('Add a caption of up to 2,200 characters.');
  const channelCaptions = {};
  for (const provider of ['instagram', 'facebook']) {
    const value = String(req.body.channelCaptions?.[provider] ?? caption).trim();
    if (!value || value.length > 2200) throw meta.fail(`${provider === 'instagram' ? 'Instagram' : 'Facebook'} caption must be between 1 and 2,200 characters.`);
    channelCaptions[provider] = value;
  }
  const campaign = String(req.body.campaign || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const kind = req.body.kind === 'reel' ? 'reel' : 'photos';
  const values = { productId: product._id, productName: product.name, productPrice: product.price, productUrl: productLink(product, req.socialStore), images, caption, channelCaptions, campaign, kind };
  let draft;
  let discardedAssets = [];
  if (req.params.id) {
    const versionFilter = req.body.updatedAt ? { updatedAt: new Date(req.body.updatedAt) } : {};
    draft = await Post.findOne({ _id: req.params.id, storeId: req.socialStore._id, status: 'draft', videoStatus: { $nin: ['queued', 'processing'] }, ...versionFilter });
    if (!draft) throw meta.fail('This post is processing or has already been submitted. Create a new draft to make changes.', 409);
    if (JSON.stringify(draft.images) !== JSON.stringify(images) || String(draft.productId) !== String(product._id) || draft.productName !== product.name || draft.productPrice !== product.price) {
      discardedAssets = media.generatedAssets(draft);
      draft.videoUrl = ''; draft.videoStatus = 'none'; draft.preparedImages = []; draft.generationAssets = {};
    }
    Object.assign(draft, values); await draft.save();
  } else draft = await createRecordOnce(req, { Model: Post, filter: { storeId: req.socialStore._id }, create: identity => Post.create({ ...values, ...identity, storeId: req.socialStore._id, createdBy: req.user._id }) });
  if (discardedAssets.length) setImmediate(() => media.removeAssets(discardedAssets));
  res.json({ post: draft });
}
async function list(req, res) {
  const page = Math.max(0, Math.min(1000, parseInt(req.query.page, 10) || 0));
  const filter = { storeId: req.socialStore._id };
  if (['draft', 'scheduled', 'queued', 'processing', 'published', 'partial', 'failed', 'review'].includes(req.query.status)) filter.status = req.query.status;
  if (['photos', 'reel'].includes(req.query.kind)) filter.kind = req.query.kind;
  if (req.query.campaign) filter.campaign = String(req.query.campaign).slice(0, 80);
  const rows = await Post.find(filter).sort({ createdAt: -1 }).skip(page * 20).limit(21).lean();
  res.json({ posts: rows.slice(0, 20), hasMore: rows.length > 20 });
}
async function get(req, res) {
  const post = await Post.findOne({ _id: req.params.id, storeId: req.socialStore._id }).lean();
  if (!post) throw meta.fail('Post not found.', 404); res.json({ post });
}
async function generate(req, res) {
  const count = await Post.countDocuments({ storeId: req.socialStore._id, videoStatus: { $in: ['queued', 'processing'] } });
  if (count >= 3) throw meta.fail('Three videos are already in the queue. Wait for one to finish.', 409);
  const post = await Post.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, status: 'draft', videoStatus: { $nin: ['queued', 'processing'] } }, { $set: { videoStatus: 'queued', videoError: '', kind: 'reel', attempts: 0 } }, { new: true });
  if (!post) throw meta.fail('This post is already processing or is no longer a draft.', 409);
  res.status(202).json({ post }); kick();
}
async function publish(req, res) {
  const post = await Post.findOne({ _id: req.params.id, storeId: req.socialStore._id });
  if (!post) throw meta.fail('Post not found.', 404);
  if (post.status !== 'draft') return res.json({ post }); // Duplicate clicks cannot publish twice.
  if (['queued', 'processing'].includes(post.videoStatus)) throw meta.fail('Wait for the video preview to finish.', 409);
  if (post.kind === 'reel' && (post.videoStatus !== 'ready' || !post.videoUrl)) throw meta.fail('Create and review the video before publishing.');
  if (post.kind === 'reel') media.trustedUrl(post.videoUrl);
  const ids = [...new Set(Array.isArray(req.body.connectionIds) ? req.body.connectionIds.map(String) : [])];
  if (!ids.length || ids.length > 20) throw meta.fail('Choose at least one connected destination.');
  const accounts = await Connection.find({ _id: { $in: ids }, storeId: req.socialStore._id, status: 'connected' });
  if (accounts.length !== ids.length || accounts.some(a => !meta.capabilities(a).publish || (a.expiresAt && a.expiresAt <= new Date()))) throw meta.fail('Reconnect the selected accounts with publishing permission.');
  let scheduledFor = null;
  if (req.body.scheduledFor) {
    scheduledFor = new Date(req.body.scheduledFor);
    if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor < new Date(Date.now() + 5 * 60000) || scheduledFor > new Date(Date.now() + 90 * 86400000)) throw meta.fail('Schedule the post between 5 minutes and 90 days from now.');
  }
  const updated = await Post.findOneAndUpdate({ _id: post._id, status: 'draft', __v: post.__v }, { $set: { status: scheduledFor ? 'scheduled' : 'queued', scheduledFor, scheduledBy: scheduledFor ? req.user._id : null, submittedAt: new Date(), targets: accounts.map(a => ({ connectionId: a._id, provider: a.provider, name: a.name, status: 'queued', caption: post.channelCaptions?.[a.provider] || post.caption })), attempts: 0 }, $inc: { __v: 1 } }, { new: true });
  if (!updated) throw meta.fail('The draft changed. Reload it before publishing.', 409);
  res.status(202).json({ post: updated }); if (!scheduledFor) kick();
}
async function remove(req, res) {
  const post = await Post.findOneAndDelete({ _id: req.params.id, storeId: req.socialStore._id, status: 'draft', videoStatus: { $nin: ['queued', 'processing'] } });
  if (!post) throw meta.fail('Only idle drafts can be deleted.', 409);
  await invalidateRecordCreation(post._id);
  setImmediate(() => media.removeAssets(media.generatedAssets(post)));
  res.json({ success: true });
}
async function cancelSchedule(req, res) {
  const post = await Post.findOneAndUpdate({ _id: req.params.id, storeId: req.socialStore._id, status: 'scheduled', scheduledFor: { $gt: new Date() }, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] }, { $set: { status: 'draft', targets: [] }, $unset: { scheduledFor: 1, scheduledBy: 1, submittedAt: 1 } }, { new: true });
  if (!post) throw meta.fail('This schedule has already started or no longer exists.', 409);
  res.json({ post });
}
async function retry(req, res) {
  const post = await Post.findOne({ _id: req.params.id, storeId: req.socialStore._id, status: { $in: ['failed', 'partial', 'review'] } });
  if (!post) throw meta.fail('This post is not ready to retry.', 409);
  let changed = false;
  post.targets.forEach(t => { if (t.status === 'failed') { t.status = 'queued'; t.error = ''; t.containerId = ''; t.childIds = []; changed = true; } });
  if (!changed) throw meta.fail('There are no confirmed failures to retry. Check uncertain results directly on Meta.');
  post.status = 'queued'; await post.save(); res.status(202).json({ post }); kick();
}
async function checkpoint(post, target, values) { Object.assign(target, values); await post.save(); }
async function publishTarget(post, target) {
  if (['published', 'failed', 'unknown', 'disconnected'].includes(target.status)) return;
  const account = await Connection.findOne({ _id: target.connectionId, storeId: post.storeId, status: 'connected' }).select('+token');
  if (!account) { await checkpoint(post, target, { status: 'failed', error: 'Reconnect this account before retrying.' }); return; }
  const token = decryptSecret(account.token);
  const api = (edge, method = 'GET', params = {}) => meta.request(edge, { host: account.apiHost || 'graph.facebook.com', token, method, params });
  const caption = target.caption || post.channelCaptions?.[target.provider] || post.caption;
  // A worker may have stopped after Meta accepted a write. Do not repeat that write.
  if (target.status === 'publishing') { await checkpoint(post, target, { status: 'unknown', error: 'Publishing was interrupted before confirmation. Check this account on Meta before creating another post.' }); return; }
  let accepted = false;
  try {
    if (!target.startedAt) await checkpoint(post, target, { startedAt: new Date() });
    if (Date.now() - new Date(target.startedAt).getTime() > 30 * 60000) throw Object.assign(meta.fail('Meta processing has not finished. Check the account before retrying.'), { ambiguous: target.status === 'verifying' });
    if (account.provider === 'instagram') {
      if (!target.containerId) {
        if (post.kind === 'reel') {
          const result = await api(`${account.accountId}/media`, 'POST', { media_type: 'REELS', video_url: post.videoUrl, caption, share_to_feed: true });
          await checkpoint(post, target, { containerId: result.id, status: 'processing', startedAt: new Date() }); return;
        }
        if (post.preparedImages.length > 1) {
          for (let i = target.childIds.length; i < post.preparedImages.length; i++) {
            const child = await api(`${account.accountId}/media`, 'POST', { image_url: post.preparedImages[i], is_carousel_item: true });
            target.childIds.push(child.id); await post.save();
          }
          for (const id of target.childIds) { const state = await api(id, 'GET', { fields: 'status_code' }); if (state.status_code !== 'FINISHED') { if (['ERROR', 'EXPIRED'].includes(state.status_code)) throw meta.fail('Instagram could not prepare a carousel photo.'); return; } }
        }
        const result = await api(`${account.accountId}/media`, 'POST', post.preparedImages.length > 1 ? { media_type: 'CAROUSEL', children: target.childIds.join(','), caption } : { image_url: post.preparedImages[0], caption });
        await checkpoint(post, target, { containerId: result.id, status: 'processing', startedAt: new Date() }); return;
      }
      const state = await api(target.containerId, 'GET', { fields: 'status_code,status' });
      if (['ERROR', 'EXPIRED'].includes(state.status_code)) throw meta.fail('Instagram could not process this media. Review the photos or regenerate the video.');
      if (state.status_code !== 'FINISHED') { if (Date.now() - new Date(target.startedAt).getTime() > 30 * 60000) throw meta.fail('Instagram media processing timed out.'); return; }
      await checkpoint(post, target, { status: 'publishing' });
      const result = await api(`${account.accountId}/media_publish`, 'POST', { creation_id: target.containerId });
      if (!result.id) throw Object.assign(meta.fail('Instagram did not return a publication ID.'), { ambiguous: true });
      accepted = true;
      await checkpoint(post, target, { externalId: result.id, status: 'published' });
      const link = await api(result.id, 'GET', { fields: 'permalink' }).catch(() => null);
      if (link?.permalink) await checkpoint(post, target, { permalink: link.permalink });
    } else if (post.kind === 'reel') {
      if (!target.containerId) {
        const result = await api(`${account.pageId}/video_reels`, 'POST', { upload_phase: 'start' });
        await checkpoint(post, target, { containerId: result.video_id, status: 'uploading', startedAt: new Date() });
      }
      if (target.status === 'uploading') {
        await meta.uploadReel(target.containerId, post.videoUrl, token);
        await checkpoint(post, target, { status: 'processing' });
      }
      const result = await api(target.containerId, 'GET', { fields: 'status' });
      const state = result.status || {};
      if (state.publishing_phase?.status === 'complete') { await checkpoint(post, target, { status: 'published', externalId: target.containerId, permalink: `https://www.facebook.com/reel/${target.containerId}` }); return; }
      if (state.video_status === 'error' || ['error', 'failed'].includes(state.processing_phase?.status)) throw meta.fail('Facebook could not process this video. Regenerate it before retrying.');
      if (Date.now() - new Date(target.startedAt).getTime() > 30 * 60000) throw Object.assign(meta.fail('Facebook has not confirmed this reel yet. Check its status on Facebook.'), { ambiguous: target.status === 'verifying' });
      if (target.status === 'verifying') return;
      if (state.uploading_phase?.status !== 'complete') return;
      await checkpoint(post, target, { status: 'publishing' });
      const published = await api(`${account.pageId}/video_reels`, 'POST', { upload_phase: 'finish', video_state: 'PUBLISHED', video_id: target.containerId, description: caption });
      if (!published.success) throw Object.assign(meta.fail('Facebook did not confirm the reel.'), { ambiguous: true });
      accepted = true;
      await checkpoint(post, target, { status: 'verifying' });
    } else {
      for (let i = target.childIds.length; i < post.preparedImages.length; i++) {
        const image = await api(`${account.pageId}/photos`, 'POST', { url: post.preparedImages[i], published: false });
        if (!image.id) throw meta.fail('Facebook could not prepare a photo.'); target.childIds.push(image.id); await post.save();
      }
      await checkpoint(post, target, { status: 'publishing' });
      const result = await api(`${account.pageId}/feed`, 'POST', { message: caption, attached_media: target.childIds.map(id => ({ media_fbid: id })) });
      if (!result.id) throw Object.assign(meta.fail('Facebook did not return a publication ID.'), { ambiguous: true });
      accepted = true;
      await checkpoint(post, target, { status: 'published', externalId: result.id, permalink: `https://www.facebook.com/${result.id}` });
    }
  } catch (error) {
    if (error.name === 'VersionError') throw error;
    await checkpoint(post, target, { status: accepted || error.ambiguous ? 'unknown' : 'failed', error: accepted ? 'Meta accepted the post but local confirmation was interrupted. Check the account before publishing again.' : error.message });
  }
}
let running = false, timer;
async function tick() {
  if (running) return;
  running = true;
  const workerId = crypto.randomUUID();
  try {
    await Message.updateMany({ status: 'sending', createdAt: { $lt: new Date(Date.now() - 120000) } }, { $set: { status: 'unknown', error: 'Sending was interrupted. Sync the conversation and check Meta before sending again.' } });
    const post = await Post.findOneAndUpdate({ $and: [{ $or: [{ status: { $in: ['queued', 'processing'] } }, { status: 'scheduled', scheduledFor: { $lte: new Date() } }, { status: 'draft', videoStatus: { $in: ['queued', 'processing'] } }] }, { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] }] }, { $set: { leaseUntil: new Date(Date.now() + 10 * 60000), workerId }, $inc: { attempts: 1 } }, { new: true, sort: { scheduledFor: 1, updatedAt: 1 } });
    if (!post) return;
    const heartbeat = setInterval(() => Post.updateOne({ _id: post._id, workerId }, { $set: { leaseUntil: new Date(Date.now() + 10 * 60000) } }).catch(() => {}), 30000); heartbeat.unref();
    try {
      if (post.status === 'draft') {
        if (post.attempts > 3) throw meta.fail('Video creation was interrupted repeatedly. Please try again.');
        post.videoStatus = 'processing'; await post.save();
        post.videoUrl = await media.prepare(post, true); post.videoStatus = 'ready'; post.videoError = ''; await post.save();
      } else {
        post.status = 'processing'; await post.save();
        if (post.kind === 'photos' && !post.preparedImages.length) { post.preparedImages = await media.prepare(post, false); await post.save(); }
        for (const url of post.kind === 'reel' ? [post.videoUrl] : post.preparedImages) media.trustedUrl(url);
        for (const target of post.targets) await publishTarget(post, target);
        const terminal = post.targets.every(t => ['published', 'failed', 'unknown', 'disconnected'].includes(t.status));
        if (terminal) post.status = post.targets.every(t => t.status === 'published') ? 'published' : post.targets.some(t => t.status === 'unknown') ? 'review' : post.targets.some(t => t.status === 'published') ? 'partial' : 'failed';
        await post.save();
        if (terminal && ['failed', 'partial', 'review'].includes(post.status)) notifyLater({ event: 'SOCIAL_POST_FAILED', adminEvent: 'SOCIAL_POST_FAILED', channels: ['IN_APP'], storeId: post.storeId, metadata: { socialPostId: post._id } });
      }
    } catch (error) {
      if (post.status === 'draft') { post.videoStatus = 'failed'; post.videoError = error.message; }
      else { post.targets.forEach(t => { if (!['published', 'unknown', 'failed', 'disconnected'].includes(t.status)) { t.status = t.status === 'publishing' ? 'unknown' : 'failed'; t.error = error.message; } }); post.status = post.targets.some(t => t.status === 'unknown') ? 'review' : 'failed'; }
      await post.save().catch(() => {});
      if (post.status !== 'draft') notifyLater({ event: 'SOCIAL_POST_FAILED', adminEvent: 'SOCIAL_POST_FAILED', channels: ['IN_APP'], storeId: post.storeId, metadata: { socialPostId: post._id } });
    } finally { clearInterval(heartbeat); await Post.updateOne({ _id: post._id, workerId }, { $unset: { workerId: 1, leaseUntil: 1 } }); }
  } finally { running = false; }
}
function kick() { setImmediate(() => tick().catch(() => {})); }
function startWorker() { if (!timer) { timer = setInterval(kick, 30000); timer.unref(); kick(); } }
function stopWorker() { clearInterval(timer); timer = null; }
module.exports = { products, saveDraft, list, get, generate, publish, cancelSchedule, remove, retry, publishTarget, tick, startWorker, stopWorker, productImages, productLink };
