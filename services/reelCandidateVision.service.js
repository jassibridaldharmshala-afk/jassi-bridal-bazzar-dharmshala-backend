const {
  analyzeReelCandidateFiles,
  analyzeReelCandidateImages,
  isVisionEnabled,
} = require('./quickAddVision.service');
const contextService = require('./productImportContext.service');

async function analyzeStoredCandidate({ groupNumber, frames, sourceVideo, sourceRange, categories, attributes }) {
  if (!isVisionEnabled()) return unavailableCandidateAnalysis(groupNumber);
  const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os');
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'samira-context-'));
  try {
    const filePaths = [];
    for (const [index, frame] of frames.slice(0, 4).entries()) {
      const target = path.join(directory, `photo-${index}.jpg`);
      if (String(frame.url).startsWith('/uploads/')) {
        const uploads = path.resolve(__dirname, '../uploads'); const local = path.resolve(uploads, path.basename(frame.url));
        if (path.dirname(local) !== uploads) throw new Error('Invalid stored photo');
        await fs.copyFile(local, target);
      } else {
        const response = await fetch(frame.url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok || !response.body) throw new Error('The saved photo is unavailable');
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 5 * 1024 * 1024) throw new Error('The saved photo is too large'); chunks.push(chunk); }
        await fs.writeFile(target, Buffer.concat(chunks));
      }
      filePaths.push(target);
    }
    const videoFiles = [];
    if (sourceVideo?.storageKey || sourceVideo?.url) {
      try {
        const video = path.join(directory, 'original.mp4');
        await require('./mediaStorage.service').downloadObject(sourceVideo, video, { expectedSizeBytes: sourceVideo.sizeBytes, timeoutMs: 60000 });
        // Product information can be spoken well after the selected pose.
        // Retain the complete reel as context and use the selected photos as the target.
        videoFiles.push({ path: video, durationSeconds: 300 });
      } catch { /* Available photos can still supply context when an original was removed. */ }
    }
    const context = await contextService.analyzeProductContext({ filePaths, videoFiles, directory, categories, attributes });
    const result = toContextCandidateAnalysis(context, groupNumber, categories);
    if (!videoFiles.length && result.analysis.status === 'completed') result.analysis.error = 'The original video was unavailable. Suggestions use the saved photos only.';
    return result;
  } catch (error) { return failedCandidateAnalysis(groupNumber, error); }
  finally { if (path.dirname(path.resolve(directory)) === root && path.basename(directory).startsWith('samira-context-')) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

function toContextCandidateAnalysis(context, groupNumber, categories = []) {
  if (context.contextStatus !== 'completed') return context.contextStatus === 'failed'
    ? failedCandidateAnalysis(groupNumber, Object.assign(new Error(context.contextError || 'The AI service could not read this reel. Check the connection or try again shortly.'), { contextCode: context.contextErrorCode }))
    : unavailableCandidateAnalysis(groupNumber);
  const result = toCandidateAnalysis({ enabled: true, suggestion: { ...context, categoryId: context.category, categoryName: categories.find((item) => String(item._id) === context.category)?.name },
    analysis: { source: 'gemini-reel-context', model: context.contextModel, analyzedAt: new Date() } }, groupNumber);
  for (const key of ['price', 'originalPrice', 'sizes', 'sizeChart', 'attributeValues', 'fieldSources', 'multipleProducts', 'priceAmbiguous']) if (context[key] !== undefined) result.suggestions[key] = context[key];
  return result;
}

function clean(value, max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems = 8) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => clean(item, 60)).filter(Boolean))].slice(0, maxItems);
}

function defaultCandidateSuggestion(groupNumber) {
  return {
    name: `Product ${groupNumber}`,
    category: '',
    categoryName: '',
    subcategory: '',
    primaryColor: '',
    secondaryColors: [],
    pattern: '',
    fabric: '',
    occasion: [],
    tags: ['reel-import'],
    altText: `Reel product candidate ${groupNumber}`,
    shortDescription: '',
    description: '',
    sizingMode: 'confirm',
  };
}

function unavailableCandidateAnalysis(groupNumber, reason = '') {
  return {
    suggestions: defaultCandidateSuggestion(groupNumber),
    confidence: {
      name: 0,
      category: 0,
      primaryColor: 0,
      pattern: 0,
      fabric: 0,
      occasion: 0,
      overall: 0,
    },
    analysis: {
      status: 'unavailable',
      source: '',
      model: '',
      analyzedAt: null,
      error: clean(reason || 'Smart suggestions are not configured.', 240),
    },
  };
}

function failedCandidateAnalysis(groupNumber, error) {
  const fallback = unavailableCandidateAnalysis(groupNumber, error?.message || 'Product details could not be identified.');
  fallback.analysis.status = 'failed';
  fallback.analysis.analyzedAt = new Date();
  fallback.analysis.errorCode = clean(error?.contextCode || 'AI_MEDIA_UNAVAILABLE', 80);
  return fallback;
}

function toCandidateAnalysis(result, groupNumber) {
  if (!result?.enabled) return unavailableCandidateAnalysis(groupNumber, result?.reason);
  const suggestion = result.suggestion || {};
  const colors = cleanList(suggestion.colors);
  const tags = cleanList(suggestion.tags);
  return {
    suggestions: {
      name: clean(suggestion.name, 120) || `Product ${groupNumber}`,
      category: clean(suggestion.categoryId, 80),
      categoryName: clean(suggestion.categoryName, 80),
      subcategory: clean(suggestion.subCategory, 80),
      primaryColor: colors[0] || '',
      secondaryColors: colors.slice(1),
      pattern: clean(suggestion.pattern, 80),
      fabric: clean(suggestion.fabric, 80),
      occasion: cleanList(suggestion.occasion, 4),
      tags: tags.length ? [...new Set([...tags, 'reel-import'])].slice(0, 8) : ['reel-import'],
      altText: clean(suggestion.shortDescription || suggestion.name, 200),
      shortDescription: clean(suggestion.shortDescription, 200),
      description: clean(suggestion.description, 800),
      sizingMode: ['sized', 'free-size'].includes(suggestion.sizingMode) ? suggestion.sizingMode : 'confirm',
    },
    confidence: {
      name: Number(result.confidence?.name || 0),
      category: Number(result.confidence?.category || 0),
      primaryColor: Number(result.confidence?.primaryColor || 0),
      pattern: Number(result.confidence?.pattern || 0),
      fabric: Number(result.confidence?.fabric || 0),
      occasion: Number(result.confidence?.occasion || 0),
      overall: Number(result.confidence?.overall || 0),
    },
    analysis: {
      status: 'completed',
      source: clean(result.analysis?.source, 80),
      model: clean(result.analysis?.model, 80),
      analyzedAt: result.analysis?.analyzedAt || new Date(),
      error: '',
    },
  };
}

async function analyzeCandidateFiles({ groupNumber, filePaths, categories, subcategories, videoFiles, directory, attributes, signal }) {
  if (!isVisionEnabled()) return unavailableCandidateAnalysis(groupNumber);
  try {
    if (videoFiles?.length) return toContextCandidateAnalysis(await contextService.analyzeProductContext({ filePaths, videoFiles, directory, categories, attributes, signal }), groupNumber, categories);
    const result = await analyzeReelCandidateFiles({ filePaths, categories, subcategories });
    return toCandidateAnalysis(result, groupNumber);
  } catch (error) {
    return failedCandidateAnalysis(groupNumber, error);
  }
}

async function analyzeCandidateImages({ groupNumber, imageUrls, categories, subcategories }) {
  if (!isVisionEnabled()) return unavailableCandidateAnalysis(groupNumber);
  try {
    const result = await analyzeReelCandidateImages({ imageUrls, categories, subcategories });
    return toCandidateAnalysis(result, groupNumber);
  } catch (error) {
    return failedCandidateAnalysis(groupNumber, error);
  }
}

module.exports = {
  analyzeStoredCandidate,
  toContextCandidateAnalysis,
  analyzeCandidateFiles,
  analyzeCandidateImages,
  defaultCandidateSuggestion,
  failedCandidateAnalysis,
  isVisionEnabled,
  toCandidateAnalysis,
  unavailableCandidateAnalysis,
};
