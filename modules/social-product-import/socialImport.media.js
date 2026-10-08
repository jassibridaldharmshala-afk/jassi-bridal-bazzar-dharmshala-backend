const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { ApiError } = require('../../utils/apiError');
const network = require('./socialImport.network');
const r2 = require('../../services/r2Upload');
const cloudinary = require('../../services/cloudinaryUpload');
const { selectProductFrames } = require('../../services/productFrameSelection.service');
const { preparePhotoFile } = require('../../services/photoCompressionService');

const storageReady = () => process.env.NODE_ENV !== 'production' || r2.isR2Configured() || cloudinary.isCloudinaryConfigured();
function run(binary, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(output); };
    const abort = () => { child.kill('SIGKILL'); finish(new ApiError('SOCIAL_CANCELLED', 'Media processing stopped. Please retry.')); };
    const timer = setTimeout(abort, 45000);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-65536); });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new ApiError('SOCIAL_MEDIA_PROCESSING', 'Media processing is unavailable on this server.')));
    child.once('exit', (code) => finish(code === 0 ? null : new ApiError('SOCIAL_MEDIA_PROCESSING', 'This media could not be processed. Try uploading a clearer photo or the original video.')));
  });
}
function imageType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new ApiError('SOCIAL_MEDIA_TYPE', 'The post did not provide a supported product image.');
}
async function downloadImage(url, directory, signal) {
  const result = await network.safeRead(url, { media: true, maxBytes: 12 * 1024 * 1024, signal });
  const type = imageType(result.buffer); const id = crypto.randomUUID();
  const input = path.join(directory, id + '.' + type); const output = path.join(directory, id + '.webp');
  // Use a distinct input name when the original is already WebP.
  const original = input === output ? path.join(directory, id + '-original.webp') : input;
  await fs.writeFile(original, result.buffer);
  // Preserve the downloaded master; display versions are generated during storage.
  return { path: original, id, kind: 'photo' };
}
async function downloadVideo(url, directory, signal, frameCount = 12) {
  const result = await network.safeRead(url, { media: true, maxBytes: 80 * 1024 * 1024, signal });
  if (result.buffer.toString('ascii', 4, 8) !== 'ftyp') throw new ApiError('SOCIAL_MEDIA_TYPE', 'This reel did not provide a downloadable MP4 video.');
  const id = crypto.randomUUID(); const filePath = path.join(directory, id + '.mp4');
  await fs.writeFile(filePath, result.buffer);
  const metadata = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-of', 'json', filePath], signal));
  const duration = Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300) throw new ApiError('SOCIAL_VIDEO_LENGTH', 'Use a product reel shorter than 5 minutes.');
  const selection = frameCount > 0 ? await selectProductFrames(filePath, directory, { durationSeconds: duration, maxFrames: frameCount, recommendedCount: Math.min(6, frameCount), signal }) : { frames: [], statistics: null };
  const frames = [];
  for (const frame of selection.frames) {
    frames.push({ ...frame, kind: 'frame', timestamp: frame.timestampSeconds });
  }
  return { video: { id, path: filePath }, frames, statistics: selection.statistics };
}
async function persist(file, jobId, video = false) {
  if (!storageReady()) throw new ApiError('SOCIAL_STORAGE_REQUIRED', 'Permanent media storage must be configured before importing products.');
  const name = `social-${jobId}-${file.id}.${video ? 'mp4' : 'webp'}`;
  const input = await preparePhotoFile({ path: file.path, originalname: name, mimetype: video ? 'video/mp4' : 'image/webp', size: (await fs.stat(file.path)).size });
  const generated = require('../../services/generatedMediaService');
  const stored = await generated.persistGeneratedFile(input, { namespace: 'social-media', ownerId: jobId, slot: file.id, recipe: ['native-v1', await generated.fileDigest(input)] }, { video, folder: 'products/social-imports' });
  const provider = stored.provider;
  return { id: file.id, url: provider === 'local' ? new URL(stored.url).pathname : stored.url, publicId: stored.storageKey, variants: stored.variants?.map(variant => provider === 'local' ? { ...variant, url: new URL(variant.url).pathname } : variant), provider, kind: file.kind, timestamp: file.timestamp,
    qualityScore: file.qualityScore, sharpnessScore: file.sharpnessScore, exposureScore: file.exposureScore, recommended: file.recommended,
    recommendedCover: file.recommendedCover, viewType: file.viewType, qualityWarnings: file.qualityWarnings,
    width: input.photo?.width || file.width, height: input.photo?.height || file.height, sizeBytes: input.size, mimeType: input.mimetype, selectionVersion: file.selectionVersion };
}
module.exports = { downloadImage, downloadVideo, persist, storageReady, imageType, run };
