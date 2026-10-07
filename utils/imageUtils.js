function isLocalRequest(req) {
  const host = String(req?.get?.('host') || req?.hostname || '').toLowerCase();
  return host.includes('localhost') || host.includes('127.0.0.1');
}

function getPublicApiUrl(req) {
  if (isLocalRequest(req)) {
    return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
  }

  let apiUrl = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  if (/localhost|127\.0\.0\.1/i.test(apiUrl)) {
    apiUrl = `${req.protocol}://${req.get('host')}`;
  }

  return apiUrl.replace(/\/$/, '');
}

function placeholderUrl(req) {
  return `${getPublicApiUrl(req)}/placeholder.jpg`;
}

function normalizeImageEntry(image) {
  if (!image) return null;
  if (typeof image === 'string') {
    return { url: image, primary: false };
  }
  const url = image.url || '';
  if (!url) return null;
  return {
    ...image,
    url,
    primary: Boolean(image.primary),
  };
}

function normalizeImageEntries(images = []) {
  return Array.isArray(images)
    ? images.map(normalizeImageEntry).filter(Boolean)
    : [];
}

function getPrimaryImageUrl(images = []) {
  const normalized = normalizeImageEntries(images).filter((image) => image.url && !isKnownMissingImage(image.url));
  return normalized.find((image) => image.primary)?.url || normalized[0]?.url || '';
}

function isInaccessibleImageUrl(url) {
  return /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(String(url || ''));
}

function extractUploadsPath(url = '') {
  const match = String(url).match(/\/uploads\/[^?#\s]+/i);
  return match ? match[0] : '';
}

function rewriteImageUrl(url, req) {
  if (!url || isKnownMissingImage(url)) return '';

  const uploadsPath = extractUploadsPath(url);
  if (uploadsPath && isInaccessibleImageUrl(url)) {
    return `${getPublicApiUrl(req)}${uploadsPath}`;
  }

  if (url.startsWith('/uploads/')) {
    return `${getPublicApiUrl(req)}${url}`;
  }

  return url;
}

function sanitizeStoredImageUrl(url = '') {
  if (!url) return url;
  if (isInaccessibleImageUrl(url)) {
    const uploadsPath = extractUploadsPath(url);
    return uploadsPath || url;
  }
  return url;
}

function sanitizeProductImages(images = []) {
  if (!Array.isArray(images)) return images;
  return images.map((image) => {
    if (!image || typeof image !== 'object') return image;
    return { ...image, url: sanitizeStoredImageUrl(image.url), ...(image.background ? { background: {
      ...image.background,
      original: { ...image.background.original, url: sanitizeStoredImageUrl(image.background.original?.url) },
      edited: { ...image.background.edited, url: sanitizeStoredImageUrl(image.background.edited?.url) },
    } } : {}) };
  });
}

function buildUploadFileResponse(file, req) {
  return {
    url: `${getPublicApiUrl(req)}/uploads/${file.filename}`,
    publicId: file.filename,
    originalName: file.originalname,
  };
}

function normalizeImageForResponse(image, req) {
  const url = typeof image === 'string' ? image : image?.url;
  const rewritten = rewriteImageUrl(url, req);
  if (!rewritten) {
    return { ...(typeof image === 'object' && image ? image : {}), url: placeholderUrl(req), isPlaceholder: true, primary: Boolean(image?.primary) };
  }
  return typeof image === 'string' ? { url: rewritten } : { ...image, url: rewritten, ...(image.background ? { background: {
    ...image.background,
    original: { ...image.background.original, url: rewriteImageUrl(image.background.original?.url, req) },
    edited: { ...image.background.edited, url: rewriteImageUrl(image.background.edited?.url, req) },
  } } : {}) };
}

function normalizeProductImages(product, req) {
  const data = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  const images = normalizeImageEntries(data.images).map((image) => normalizeImageForResponse(image, req));
  if (images.length) {
    const primaryIndex = images.findIndex((image) => image.primary);
    if (primaryIndex === -1) images[0] = { ...images[0], primary: true };
    data.images = images;
    data.primaryImage = getPrimaryImageUrl(images);
  } else {
    data.images = [{ url: placeholderUrl(req), isPlaceholder: true, primary: true }];
    data.primaryImage = data.images[0].url;
  }
  return data;
}

function normalizeProductPayload(data = {}) {
  const payload = { ...data };
  const images = normalizeImageEntries(payload.images).filter((image) => image.url && !isKnownMissingImage(image.url));
  if (images.length) {
    const primaryIndex = images.findIndex((image) => image.primary);
    if (primaryIndex === -1) images[0].primary = true;
    payload.images = images.map((image) => ({
      url: image.url,
      publicId: image.publicId,
      ...(image.background ? { background: image.background } : {}),
      primary: Boolean(image.primary),
      ...(image.sourceFrame ? { sourceFrame: image.sourceFrame } : {}),
    }));
    payload.primaryImage = getPrimaryImageUrl(payload.images);
  }
  return payload;
}

function isKnownMissingImage(url) {
  return /(^|\/)placeholder\.jpe?g($|\?)/i.test(String(url || ''));
}

module.exports = {
  buildUploadFileResponse,
  getPublicApiUrl,
  getPrimaryImageUrl,
  normalizeImageEntries,
  isLocalRequest,
  normalizeProductImages,
  normalizeProductPayload,
  placeholderUrl,
  sanitizeProductImages,
};
