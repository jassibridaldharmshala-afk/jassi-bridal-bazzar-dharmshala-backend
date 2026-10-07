const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { reviewFrameViews } = require('./productFrameVision.service');

const SIDE = 160;
const FRAME_BYTES = SIDE * SIDE * 3;
const MAX_SAMPLES = 180;
const VERSION = 'quality-v1';
const clamp = (value) => Math.max(0, Math.min(1, value));
const rounded = (value) => Math.round(value * 1000) / 1000;

function run(binary, args, { signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Frame selection cancelled.'), { code: 'REEL_WORKER_TIMEOUT' }));
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let stopped = false; let settled = false;
    const abort = () => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-512000); });
    child.once('error', () => finish(Object.assign(new Error('Video analysis tools are unavailable.'), { code: 'FFMPEG_UNAVAILABLE' })));
    // Wait for the process to close before callers clean up its output files.
    child.once('close', (code) => finish(code === 0 && !stopped ? null : Object.assign(new Error(stopped ? 'Frame selection cancelled or timed out.' : 'The video could not be analyzed.'), { code: stopped ? 'REEL_WORKER_TIMEOUT' : 'FRAME_ANALYSIS_FAILED' })));
  });
}

function measureFrame(rgb, width = SIDE, height = SIDE) {
  if (rgb.length !== width * height * 3) throw new Error('Incomplete frame pixels.');
  const gray = new Float32Array(width * height); const signature = new Float32Array(16 * 16 * 3); const counts = new Uint16Array(256);
  let total = 0; let total2 = 0; let dark = 0; let bright = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x; const offset = i * 3;
    const luma = rgb[offset] * .2126 + rgb[offset + 1] * .7152 + rgb[offset + 2] * .0722;
    gray[i] = luma;
    // Ignore border pixels when measuring exposure; letterboxing should not dominate.
    if (x > width * .1 && x < width * .9 && y > height * .1 && y < height * .9) {
      total += luma; total2 += luma * luma; dark += luma < 18; bright += luma > 242;
    }
    const cell = Math.floor(y / height * 16) * 16 + Math.floor(x / width * 16); counts[cell]++;
    for (let channel = 0; channel < 3; channel++) signature[cell * 3 + channel] += rgb[offset + channel];
  }
  for (let cell = 0; cell < 256; cell++) for (let channel = 0; channel < 3; channel++) signature[cell * 3 + channel] /= counts[cell] || 1;
  let lap = 0; let lap2 = 0; let weight = 0; let boundaryEdges = 0; let boundaryCount = 0; let innerEdges = 0; let innerCount = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const value = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
    const w = x > width * .2 && x < width * .8 && y > height * .1 && y < height * .9 ? 3 : 1;
    lap += value * w; lap2 += value * value * w; weight += w;
    if (x < width * .12 || x > width * .88 || y < height * .12) { boundaryEdges += Math.abs(value); boundaryCount++; }
    else { innerEdges += Math.abs(value); innerCount++; }
  }
  const count = (Math.ceil(width * .9) - Math.floor(width * .1) - 1) * (Math.ceil(height * .9) - Math.floor(height * .1) - 1);
  const variance = Math.max(0, lap2 / weight - (lap / weight) ** 2);
  const contrast = Math.sqrt(Math.max(0, total2 / count - (total / count) ** 2));
  const sharpnessScore = clamp(Math.log1p(variance) / Math.log(1601));
  const exposureScore = clamp(1 - Math.max(dark / count, bright / count) * 1.3);
  // Quiet space at the top/sides can favour a wider view over an edge-to-edge
  // close-up. This is a composition hint, not a claim that the whole item is visible.
  const framingScore = clamp(1 - .55 * (boundaryEdges / boundaryCount) / Math.max(.1, innerEdges / innerCount));
  const rejectionReasons = [];
  if (variance < 14) rejectionReasons.push('Too blurry');
  if (dark / count > .65) rejectionReasons.push('Too dark');
  if (bright / count > .72) rejectionReasons.push('Overexposed');
  if (contrast < 7) rejectionReasons.push('Too little visible detail');
  return { signature, variance, framingScore: rounded(framingScore), sharpnessScore: rounded(sharpnessScore), exposureScore: rounded(exposureScore),
    qualityScore: rounded(.7 * sharpnessScore + .2 * exposureScore + .1 * clamp(contrast / 55)), rejectionReasons };
}

function visualDistance(a, b) {
  if (!a?.length || a.length !== b?.length) return 1;
  let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length / 255;
}

function rankFrames(frames, { maxFrames = 12, recommendedCount = 6, chronological = false } = {}) {
  const bestVariance = Math.max(0, ...frames.filter((frame) => !frame.rejectionReasons.length).map((frame) => frame.variance));
  const reviewed = frames.map((frame) => ({ ...frame, rejectionReasons: [...frame.rejectionReasons] }));
  for (const frame of reviewed) {
    // Relative rejection catches motion blur while the absolute floor handles all-blurry clips.
    if (!frame.rejectionReasons.length && frame.variance < Math.min(90, bestVariance * .14)) frame.rejectionReasons.push('Softer than other views');
  }
  const usable = reviewed.filter((frame) => !frame.rejectionReasons.length).sort((a, b) => b.qualityScore - a.qualityScore || a.timestampSeconds - b.timestampSeconds);
  const unique = []; let duplicates = 0;
  for (const frame of usable) {
    if (unique.some((other) => visualDistance(frame.signature, other.signature) < .035)) { duplicates++; continue; }
    unique.push(frame);
  }
  const selected = [];
  // Prefer strong frames with different appearances instead of filling the gallery with one pose.
  while (unique.length && selected.length < maxFrames) {
    let best = 0; let bestScore = -1;
    unique.forEach((frame, index) => {
      const diversity = selected.length ? Math.min(...selected.map((other) => visualDistance(frame.signature, other.signature))) : 0;
      const score = frame.qualityScore + Math.min(.16, diversity * .6);
      if (score > bestScore) { best = index; bestScore = score; }
    });
    selected.push(unique.splice(best, 1)[0]);
  }
  const qualityFloor = (selected[0]?.qualityScore || 0) * .85;
  const cover = [...selected].filter((frame) => frame.qualityScore >= qualityFloor).sort((a, b) => (.65 * b.qualityScore + .35 * (b.framingScore ?? .5)) - (.65 * a.qualityScore + .35 * (a.framingScore ?? .5)))[0];
  selected.sort((a, b) => Number(b === cover) - Number(a === cover));
  selected.forEach((frame, index) => { frame.recommended = index < recommendedCount; frame.recommendedCover = index === 0; frame.selectionVersion = VERSION; });
  if (chronological) selected.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  return { frames: selected, statistics: { analyzedFrames: frames.length, rejectedFrames: reviewed.length - usable.length, duplicateFrames: duplicates, candidateFrames: selected.length, recommendedFrames: Math.min(selected.length, recommendedCount), selectionVersion: VERSION } };
}

async function selectProductFrames(videoPath, directory, { durationSeconds, maxFrames = 12, recommendedCount = 6, signal, chronological = false, semantic = true, onProgress } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const metadata = JSON.parse((await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', videoPath], { signal })).stdout);
  const stream = metadata.streams?.find((item) => item.codec_type === 'video') || {};
  const duration = Number(durationSeconds || metadata.format?.duration || stream.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video duration could not be read.');
  const interval = Math.max(1 / 3, duration / (MAX_SAMPLES - 1));
  const rawPath = path.join(directory, crypto.randomUUID() + '.rgb');
  let scan;
  try {
    const { stderr } = await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe', '-i', videoPath, '-an',
      '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${interval})',scale=${SIDE}:${SIDE},format=rgb24,showinfo`,
      '-vsync', '0', '-frames:v', String(MAX_SAMPLES), '-threads', '1', '-f', 'rawvideo', rawPath], { signal });
    const timestamps = [...stderr.matchAll(/\bn:\s*\d+\s+pts:\s*[-\d]+\s+pts_time:([\d.e+-]+)/g)].map((match) => Number(match[1]));
    const buffer = await fs.readFile(rawPath); const count = Math.min(MAX_SAMPLES, Math.floor(buffer.length / FRAME_BYTES));
    if (timestamps.length !== count) throw new Error('Video frame timestamps could not be verified.');
    scan = Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), timestampSeconds: timestamps[index], ...measureFrame(buffer.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES)) }));
  } finally { await fs.unlink(rawPath).catch(() => {}); }
  const result = rankFrames(scan, { maxFrames: Math.max(0, Math.min(24, maxFrames)), recommendedCount, chronological });
  await onProgress?.(result.statistics);
  for (const frame of result.frames) {
    frame.path = path.join(directory, frame.id + '.jpg');
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-ss', String(frame.timestampSeconds), '-i', videoPath,
      '-frames:v', '1', '-vf', "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', '-threads', '1', frame.path], { signal, timeoutMs: 30000 });
    frame.width = Number(stream.width || 0); frame.height = Number(stream.height || 0);
    frame.qualityWarnings = Math.max(frame.width, frame.height) < 720 ? ['Low source resolution; inspect at full size'] : [];
    delete frame.signature; delete frame.variance;
  }
  result.statistics.viewAnalysis = 'unavailable';
  if (semantic && result.frames.length) {
    const review = await reviewFrameViews(result.frames, { signal });
    result.statistics.viewAnalysis = review.status;
    if (review.status === 'completed') {
      for (const frame of result.frames) {
        const view = review.frames.find((item) => item.id === frame.id);
        if (view) {
          Object.assign(frame, view);
          if (!view.productVisible || view.obstructed || view.textOverlay) frame.qualityWarnings.push('Check product visibility or text overlay');
          frame.recommended = view.productVisible && !view.obstructed && !view.textOverlay;
        }
      }
      const choices = result.frames.filter((frame) => frame.recommended).sort((a, b) => (Number(b.fullProduct) + Number(b.viewType === 'front')) - (Number(a.fullProduct) + Number(a.viewType === 'front')) || b.qualityScore - a.qualityScore);
      const chosen = new Set(); const views = new Set();
      for (const frame of choices) if (!views.has(frame.viewType) && chosen.size < recommendedCount) { views.add(frame.viewType); chosen.add(frame.id); }
      for (const frame of choices) if (chosen.size < recommendedCount) chosen.add(frame.id);
      result.frames.forEach((frame) => { frame.recommended = chosen.has(frame.id); frame.recommendedCover = frame.id === choices[0]?.id; });
      if (!chronological) result.frames.sort((a, b) => Number(b.recommendedCover) - Number(a.recommendedCover) || Number(b.recommended) - Number(a.recommended) || b.qualityScore - a.qualityScore);
    }
  }
  result.statistics.recommendedFrames = result.frames.filter((frame) => frame.recommended).length;
  return result;
}

module.exports = { measureFrame, visualDistance, rankFrames, selectProductFrames, run, VERSION, SIDE };
