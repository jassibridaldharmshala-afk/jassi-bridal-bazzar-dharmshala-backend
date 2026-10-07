const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const dns = require('dns/promises');
const { spawn } = require('child_process');
const { persistGeneratedFile, generatedUploadId } = require('../../services/generatedMediaService');
const { Post } = require('./models');
const { storageFingerprint } = require('../../services/uploadRetryService');
const { fail } = require('./meta');
const storage = require('../../services/mediaStorage.service');
const uploads = path.resolve(__dirname, '../../uploads');
function allowedRoots() {
  const roots = [process.env.R2_PUBLIC_URL, process.env.PUBLIC_API_URL];
  if (process.env.CLOUDINARY_CLOUD_NAME) roots.push(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);
  return roots.filter(Boolean).map(root => { try { return new URL(root); } catch { return null; } }).filter(Boolean);
}
function trustedUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('A product photo has an invalid address. Upload it to your media library again.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw fail('Publishing needs publicly accessible HTTPS media.');
  if (!allowedRoots().some(root => root.origin === url.origin && (root.pathname === '/' || url.pathname.startsWith(root.pathname.replace(/\/$/, '') + '/')))) throw fail('Upload these product photos to the configured media library before creating a post.');
  return url;
}
function publicIPv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && ![0, 10, 127].includes(parts[0]) && parts[0] < 224
    && !(parts[0] === 169 && parts[1] === 254) && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    && !(parts[0] === 192 && [0, 168].includes(parts[1])) && !(parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    && !(parts[0] === 198 && [18, 19].includes(parts[1]));
}
async function download(value, destination, hop = 0) {
  const url = trustedUrl(value), addresses = await dns.lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw fail('The media address is not public.');
  const result = await new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: (_hostname, options, callback) => options?.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4), timeout: 15000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) { response.resume(); return resolve({ redirect: new URL(response.headers.location, url).href }); }
      if (response.statusCode !== 200) { response.resume(); return reject(fail('A product photo could not be downloaded.')); }
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) response.destroy(fail('Product photos must be smaller than 12 MB.')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => request.destroy(fail('Media download timed out.')), 20000);
    request.on('close', () => clearTimeout(timer)); request.on('timeout', () => request.destroy(fail('Media download timed out.'))); request.on('error', reject);
  });
  if (result.redirect) { if (hop >= 3) throw fail('Too many media redirects.'); return download(result.redirect, destination, hop + 1); }
  await fs.writeFile(destination, result.bytes);
}
async function photoFile(value, destination) {
  let relative = String(value);
  if (/^https?:/i.test(relative)) {
    const url = new URL(relative);
    if ([process.env.PUBLIC_API_URL, 'http://localhost:5000', 'http://127.0.0.1:5000'].filter(Boolean).some(root => new URL(root).origin === url.origin) && url.pathname.startsWith('/uploads/')) relative = decodeURIComponent(url.pathname);
    else return download(relative, destination);
  }
  if (!relative.startsWith('/uploads/')) throw fail('Upload this product photo to your media library first.');
  const file = await fs.realpath(path.resolve(uploads, relative.slice('/uploads/'.length))).catch(() => null);
  const root = await fs.realpath(uploads);
  if (!file || !file.startsWith(root + path.sep)) throw fail('Product photo not found.');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw fail('Product photo is too large.');
  await fs.copyFile(file, destination);
}
async function verifyImage(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(12); await handle.read(bytes, 0, 12, 0);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp) throw fail('Use JPG, PNG or WebP product photos.');
  } finally { await handle.close(); }
}
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const process = spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => process.kill(), 120000);
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(fail('Video or photo rendering failed. Check that the selected product photos are valid images.')); });
  });
}
async function persist(file, video, identity) {
  if (!identity) throw fail('Save a post before generating its media.');
  return (await persistGeneratedFile({ path: file, mimetype: video ? 'video/mp4' : 'image/jpeg', originalname: video ? 'product-reel.mp4' : 'product-photo.jpg' }, identity, { video, folder: 'social-studio' })).url;
}
async function prepare(post, video = false) {
  const recipe = ['social-render-v2', storageFingerprint(), process.env.PUBLIC_API_URL || '', post.images.slice(0, 6), ...(video ? [post.productName || '', post.productPrice ?? null] : [])];
  const identity = { namespace: video ? 'social-video' : 'social-photos', ownerId: post._id, storeId: post.storeId, slot: 'recipe', recipe };
  const key = generatedUploadId(identity);
  const checkpoint = async (slot, url) => {
    const filter = { _id: post._id, storeId: post.storeId, ...(post.workerId ? { workerId: post.workerId } : {}) };
    const result = await Post.updateOne(filter, { $set: { [`generationAssets.${key}.${slot}`]: url } });
    if (!result.matchedCount) throw fail('This post changed while media was being prepared. Reload it before retrying.', 409);
    post.generationAssets ||= {};
    post.generationAssets[key] ||= {};
    post.generationAssets[key][slot] = url;
  };
  const prior = post.generationAssets?.[key] || {};
  if (video && prior.video) return prior.video;
  if (!video && post.images.slice(0, 6).every((_, i) => prior[`photo${i}`])) return post.images.slice(0, 6).map((_, i) => prior[`photo${i}`]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'samira-social-'));
  try {
    const images = post.images.slice(0, 6);
    if (!images.length) throw fail('Select at least one product photo.');
    const outputs = [];
    for (let i = 0; i < images.length; i++) {
      if (!video && prior[`photo${i}`]) { outputs.push(null); continue; }
      const input = path.join(directory, `source-${i}`), output = path.join(directory, `photo-${i}.jpg`);
      await photoFile(images[i], input);
      await verifyImage(input);
      await run(['-protocol_whitelist', 'file,pipe', '-i', input, '-vf', 'scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=0xfff8ef,setsar=1', '-frames:v', '1', '-q:v', '2', output], directory);
      outputs.push(output);
    }
    if (!video) {
      const urls = [];
      for (let i = 0; i < outputs.length; i++) {
        const slot = `photo${i}`;
        const url = prior[slot] || await persist(outputs[i], false, { ...identity, slot });
        if (!prior[slot]) await checkpoint(slot, url);
        urls.push(url);
      }
      return urls;
    }
    const clips = [];
    for (let i = 0; i < outputs.length; i++) {
      const clip = `clip-${i}.mp4`; clips.push(clip);
      // Text is burned from a UTF-8 file, never interpolated as an ffmpeg expression.
      const label = String(post.productName || '').replace(/[\r\n]/g, ' ').slice(0, 52);
      await fs.writeFile(path.join(directory, 'caption.txt'), label + (Number.isFinite(post.productPrice) ? `\nRs. ${post.productPrice.toLocaleString('en-IN')}` : ''));
      const font = process.platform === 'win32' ? "fontfile='C\\:/Windows/Fonts/arial.ttf':" : '';
      const filter = `scale=720:1080:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:40:color=0xfff8ef,setsar=1,drawtext=${font}textfile=caption.txt:expansion=none:fontcolor=0x701b35:fontsize=25:line_spacing=12:x=(w-text_w)/2:y=h-135`;
      await run(['-loop', '1', '-i', outputs[i], '-vf', filter, '-t', '4', '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', clip], directory);
    }
    await fs.writeFile(path.join(directory, 'clips.txt'), clips.map(clip => `file '${clip}'`).join('\n'));
    const output = path.join(directory, 'product-reel.mp4');
    await run(['-f', 'concat', '-safe', '1', '-i', 'clips.txt', '-c', 'copy', '-movflags', '+faststart', output], directory);
    const url = await persist(output, true, { ...identity, slot: 'video' });
    await checkpoint('video', url);
    return url;
  } finally {
    // mkdtemp creates this exact directory; no user-provided path can reach cleanup.
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function removeAssets(values = []) {
  const provider = storage.getStorageProvider();
  for (const value of [...new Set(values.filter(Boolean))]) {
    if (!provider) {
      try {
        const root = new URL(process.env.PUBLIC_API_URL || 'http://localhost:5000');
        const local = new URL(value, root);
        const name = path.basename(decodeURIComponent(local.pathname));
        if (local.origin === root.origin && local.pathname === `/uploads/${name}` && /^(?:social-[a-f0-9-]+|retry-[a-f0-9]{64})\.(?:jpg|mp4)$/i.test(name)) await fs.unlink(path.join(uploads, name)).catch(() => {});
      } catch { /* Invalid/foreign URLs are never deletion targets. */ }
      continue;
    }
    let url; try { url = trustedUrl(value); } catch { continue; }
    try {
      if (provider === 'r2' && process.env.R2_PUBLIC_URL) {
        const root = new URL(process.env.R2_PUBLIC_URL), prefix = root.pathname.replace(/\/$/, '');
        if (url.origin === root.origin && url.pathname.startsWith(prefix + '/')) await storage.deleteObject({ provider: 'r2', storageKey: decodeURIComponent(url.pathname.slice(prefix.length + 1)) });
      } else if (provider === 'cloudinary' && process.env.CLOUDINARY_CLOUD_NAME) {
        const match = url.pathname.match(/\/(?:image|video)\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i);
        if (match) await require('../../services/cloudinaryUpload').deleteFile(decodeURIComponent(match[1]), /\.(?:mp4|mov|webm)$/i.test(url.pathname) ? 'video' : 'image');
      } else if (/^\/uploads\/(?:social-|retry-)/.test(url.pathname)) {
        const name = path.basename(decodeURIComponent(url.pathname));
        if (/^(?:social-[a-f0-9-]+|retry-[a-f0-9]{64})\.(?:jpg|mp4)$/i.test(name)) await fs.unlink(path.join(uploads, name)).catch(() => {});
      }
    } catch { /* Retention cleanup retries later; original catalogue media is never passed here. */ }
  }
}
function generatedAssets(post) {
  return [...(post.preparedImages || []), post.videoUrl, ...Object.values(post.generationAssets || {}).flatMap(slots => Object.values(slots || {}))].filter(Boolean);
}
module.exports = { trustedUrl, publicIPv4, photoFile, run, persist, prepare, removeAssets, generatedAssets };
