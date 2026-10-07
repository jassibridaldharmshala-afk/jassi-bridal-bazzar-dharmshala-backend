const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const SocialImport = require('../../models/SocialProductImport');
const Category = require('../../models/Category');
const { normalizeSocialUrl, MAX_IMAGES } = require('./socialImport.validation');
const source = require('./socialImport.source');
const media = require('./socialImport.media');
const context = require('../../services/productImportContext.service');
const { readConfiguration } = require('../../services/masterConfigurationService');

const active = new Map(); const waiting = new Set();
const workRoot = path.resolve(__dirname, '../../.social-import-tmp');
const ACTIVE_STATES = ['reading', 'media', 'analyzing'];

async function processImport(id) {
  const runId = crypto.randomUUID();
  const job = await SocialImport.findOneAndUpdate({ _id: id, status: 'queued' }, { $set: { status: 'reading', stage: 'Reading the post', progress: 10, runId, error: '', errorCode: '' }, $inc: { attempts: 1 } }, { new: true });
  if (!job) return;
  const controller = new AbortController(); active.set(String(id), controller);
  const timeout = setTimeout(() => controller.abort(), 6 * 60 * 1000);
  let directory;
  const current = { _id: id, runId, status: { $in: ACTIVE_STATES } };
  const update = async (fields) => {
    if (controller.signal.aborted) throw new Error('Import stopped');
    const result = await SocialImport.updateOne(current, { $set: fields });
    if (!result.matchedCount) { controller.abort(); throw new Error('Import stopped'); }
  };
  try {
    if (!media.storageReady()) throw Object.assign(new Error('Permanent media storage must be configured before importing products.'), { errorCode: 'SOCIAL_STORAGE_REQUIRED' });
    await fs.mkdir(workRoot, { recursive: true }); directory = await fs.mkdtemp(path.join(workRoot, 'job-'));
    const resolved = await source.resolveSource(normalizeSocialUrl(job.sourceUrl), { storeId: job.storeId, signal: controller.signal });
    const warnings = [...resolved.warnings];
    await update({ status: 'media', progress: 25, stage: 'Saving product media', caption: resolved.caption, method: resolved.method, resolvedUrl: resolved.resolvedUrl || job.sourceUrl });
    const files = []; const videoFiles = []; const frameSelections = [];
    for (const [index, image] of resolved.images.entries()) {
      if (files.length >= MAX_IMAGES) break;
      try { files.push(await media.downloadImage(image.url, directory, controller.signal)); }
      catch (error) { if (controller.signal.aborted) throw error; warnings.push(`Photo ${index + 1} could not be downloaded. Check the original post.`); }
      await update({ progress: 25 + Math.round((index + 1) / Math.max(1, resolved.images.length) * 25) });
    }
    for (const video of resolved.videos) {
      try {
        await update({ stage: 'Finding clear, distinct product views across the video' });
        const downloaded = await media.downloadVideo(video.url, directory, controller.signal, Math.min(12, MAX_IMAGES - files.length));
        files.push(...downloaded.frames); videoFiles.push(downloaded.video);
        if (downloaded.statistics) {
          frameSelections.push(downloaded.statistics);
          if (!downloaded.frames.length) warnings.push('This video did not contain frames that passed the clarity checks. Upload clearer product photos.');
          if (downloaded.statistics.viewAnalysis !== 'completed') warnings.push('Photos were selected by clarity and visual variety. Confirm the front, side, back and detail views yourself.');
        }
      } catch (error) { if (controller.signal.aborted) throw error; warnings.push('The original video could not be imported. Available cover photos are shown instead.'); }
    }
    if (!files.length) throw Object.assign(new Error('No usable product photos could be imported. Upload the original photos or reel instead.'), { errorCode: 'SOCIAL_NO_MEDIA' });
    // Repeated covers and identical carousel frames should not fill the gallery.
    const unique = []; const hashes = new Set();
    for (const file of files) {
      const hash = crypto.createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
      if (!hashes.has(hash)) { hashes.add(hash); unique.push(file); }
    }
    await update({ status: 'analyzing', progress: 60, stage: context.enabled() ? 'Reading product details, video text and spoken information' : 'Filling details from the post' });
    const categories = await Category.find({ ...(job.storeId ? { storeId: job.storeId } : {}), isActive: { $ne: false } }).select('_id name').limit(100).lean();
    const configuration = await readConfiguration();
    const suggestion = await context.analyzeProductContext({ caption: resolved.caption, title: resolved.title,
      filePaths: unique.slice(0, 4).map((file) => file.path), videoFiles, directory, categories,
      attributes: configuration.structure.attributes, signal: controller.signal });
    if (suggestion.contextStatus === 'failed') warnings.push(suggestion.contextError || 'Video and photo understanding was unavailable. Available caption details are filled in; you can edit them below.');
    if (!context.enabled()) warnings.push('Caption details are filled automatically. Video speech and on-screen text need the optional AI connection.');
    if (suggestion.priceAmbiguous) warnings.push('The source contains an unclear price or several products. Enter the selling price for your selected product.');
    if (suggestion.contextPartial) warnings.push('Some videos exceeded the context limit. Check the original post for any remaining details.');
    const images = []; const videos = [];
    for (const [index, file] of unique.entries()) {
      images.push(await media.persist(file, id));
      await update({ images, progress: 70 + Math.round((index + 1) / unique.length * 20), stage: 'Saving photos to your catalog storage' });
    }
    for (const file of videoFiles) { videos.push({ ...await media.persist(file, id, true), thumbnail: images[0]?.url }); await update({ videos }); }
    await update({ status: 'ready', stage: 'Ready to review', progress: 100, suggestion, images, videos, frameSelections, warnings: [...new Set(warnings)].slice(0, 25) });
  } catch (error) {
    await SocialImport.updateOne(current, { $set: { status: 'failed', stage: 'Import needs attention',
      errorCode: controller.signal.aborted ? 'SOCIAL_TIMEOUT' : error.errorCode || 'SOCIAL_IMPORT_FAILED',
      error: controller.signal.aborted ? 'The import timed out. Retry it or upload the original media.' : String(error.errorCode ? error.message : 'The post could not be imported. Check the link and try again, or upload its media instead.').slice(0, 500),
    } }).catch(() => {});
  } finally {
    clearTimeout(timeout); active.delete(String(id));
    if (directory && path.dirname(path.resolve(directory)) === workRoot && path.basename(directory).startsWith('job-')) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (waiting.size) {
      const id = waiting.values().next().value; waiting.delete(id);
      await processImport(id).catch(() => {});
    }
  } finally { draining = false; }
}
function enqueue(id) { waiting.add(String(id)); setImmediate(drain); }
function cancel(id) { waiting.delete(String(id)); active.get(String(id))?.abort(); }
async function recoverImports() {
  await SocialImport.updateMany({ status: { $in: ACTIVE_STATES }, updatedAt: { $lt: new Date(Date.now() - 8 * 60 * 1000) } }, { $set: { status: 'failed', stage: 'Import interrupted', errorCode: 'SOCIAL_INTERRUPTED', error: 'The import was interrupted. Retry to continue.' } });
  const pending = await SocialImport.find({ status: 'queued' }).select('_id').limit(100).lean();
  pending.forEach((job) => enqueue(job._id));
}
module.exports = { enqueue, cancel, recoverImports, processImport, ACTIVE_STATES };
