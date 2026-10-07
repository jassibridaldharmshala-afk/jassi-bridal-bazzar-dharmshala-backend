const { ApiError } = require('../../utils/apiError');
const MAX_IMAGES = 20;
const fail = (message) => new ApiError('VALIDATION_ERROR', message);
const SOCIAL_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch']);

function normalizeSocialUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw fail('Paste a valid Instagram or Facebook post link.');
  let url;
  try { url = new URL(input.trim()); } catch { throw fail('Paste the complete Instagram or Facebook link, starting with https://.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !SOCIAL_HOSTS.has(url.hostname.toLowerCase())) throw fail('Only Instagram and Facebook post, photo and reel links are supported.');
  const host = url.hostname.toLowerCase();
  const instagram = host.includes('instagram');
  const path = url.pathname.replace(/\/+$/, '');
  let canonical; let mediaId = ''; let kind = 'post';
  if (instagram) {
    const match = path.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/);
    if (!match) throw fail('Use an Instagram post or reel link, not a profile or story link.');
    mediaId = match[2]; kind = ['reel', 'reels', 'tv'].includes(match[1]) ? 'video' : 'post';
    canonical = `https://www.instagram.com/${kind === 'video' ? 'reel' : 'p'}/${mediaId}/`;
  } else if (host === 'fb.watch') {
    if (!/^\/[A-Za-z0-9_-]+$/.test(path)) throw fail('Use a complete Facebook video share link.');
    canonical = 'https://fb.watch' + path + '/'; kind = 'video';
  } else {
    const photo = url.searchParams.get('fbid');
    const video = url.searchParams.get('v');
    const story = url.searchParams.get('story_fbid');
    const page = url.searchParams.get('id');
    if (/^\/photo(?:\.php)?$/.test(path) && /^\d+$/.test(photo || '')) {
      canonical = 'https://www.facebook.com/photo/?fbid=' + photo; mediaId = photo; kind = 'photo';
    } else if (path === '/watch' && /^\d+$/.test(video || '')) {
      canonical = 'https://www.facebook.com/watch/?v=' + video; mediaId = video; kind = 'video';
    } else if (/^\/(permalink|story)\.php$/.test(path) && /^[A-Za-z0-9]+$/.test(story || '') && /^\d+$/.test(page || '')) {
      canonical = `https://www.facebook.com/permalink.php?story_fbid=${story}&id=${page}`;
      mediaId = `${page}_${story}`;
    } else if (/^\/(?:reel\/\d+|share\/(?:p|r|v)\/[A-Za-z0-9]+|[^/]+\/(?:posts|videos)\/[A-Za-z0-9]+|[^/]+\/photos\/(?:[^/]+\/)?\d+)$/.test(path)) {
      canonical = 'https://www.facebook.com' + path + '/';
      mediaId = /^\d+$/.test(path.split('/').pop()) ? path.split('/').pop() : '';
      kind = /\/reel\/|\/videos\/|\/share\/[rv]\//.test(path) ? 'video' : /\/photos\//.test(path) ? 'photo' : 'post';
    } else throw fail('Use a Facebook photo, post, video or reel link, not a profile, group or login page.');
  }
  return { url: canonical, platform: instagram ? 'instagram' : 'facebook', mediaId, kind };
}

function validateDraftReview(body, job) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Product details are required.');
  const ids = Array.isArray(body.imageIds) ? [...new Set(body.imageIds)] : [];
  const images = ids.map((id) => job.images.find((image) => image.id === id));
  if (!images.length || images.length > MAX_IMAGES || images.some((image) => !image)) throw fail('Select between 1 and 20 imported product photos.');
  const text = (key, max) => typeof body[key] === 'string' ? body[key].trim().slice(0, max) : '';
  const list = (key) => (Array.isArray(body[key]) ? body[key] : text(key, 1000).split(',')).filter((value) => typeof value === 'string').map((value) => value.trim().slice(0, 80)).filter(Boolean).slice(0, 30);
  const number = (key, integer = false) => {
    const raw = body[key];
    if (raw === '' || raw === undefined || raw === null) return undefined;
    const value = Number(raw);
    if (!['string', 'number'].includes(typeof raw) || (typeof raw === 'string' && !raw.trim()) || !Number.isFinite(value) || value < 0 || value > 10000000 || integer && !Number.isInteger(value)) throw fail(`Enter a valid ${key === 'stock' ? 'whole-number stock quantity' : key}.`);
    return value;
  };
  const name = text('name', 160);
  if (name.length < 3) throw fail('Enter a product name with at least 3 characters.');
  const category = text('category', 24);
  if (category && !/^[a-f\d]{24}$/i.test(category)) throw fail('Choose a valid category.');
  const price = number('price'); const originalPrice = number('originalPrice'); const stock = number('stock', true);
  if (price !== undefined && originalPrice !== undefined && originalPrice < price) throw fail('MRP cannot be lower than the selling price.');
  const primaryId = images.some((image) => image.id === body.primaryImageId) ? body.primaryImageId : ids[0];
  const measurements = [...new Set(Object.values(require('../../services/productSizingService').SIZE_CHART_PROFILES).flat())];
  const sizeChart = { unit: body.sizeChart?.unit === 'cm' ? 'cm' : 'in', columns: measurements,
    rows: (Array.isArray(body.sizeChart?.rows) ? body.sizeChart.rows : []).slice(0, 30).map((row) => ({ size: typeof row.size === 'string' ? row.size.trim().slice(0, 30) : '',
      ...Object.fromEntries(measurements.filter((key) => Number.isFinite(Number(row[key])) && Number(row[key]) > 0 && Number(row[key]) < 500).map((key) => [key, Number(row[key])])) })) };
  const attributeValues = {};
  if (body.attributeValues && typeof body.attributeValues === 'object' && !Array.isArray(body.attributeValues)) {
    for (const [key, value] of Object.entries(body.attributeValues).slice(0, 50)) if (/^[a-z][a-z0-9_]*$/i.test(key) && ['string', 'number'].includes(typeof value)) attributeValues[key] = String(value).trim().slice(0, 500);
  }
  return {
    name, category: category || undefined, price, sellingPrice: price, originalPrice, stock,
    description: text('description', 6000), shortDescription: text('shortDescription', 240),
    subCategory: text('subCategory', 100), fabric: text('fabric', 120), occasion: text('occasion', 100),
    colors: list('colors'), tags: list('tags'), sizes: list('sizes'), highlights: list('highlights'),
    sizingMode: ['auto', 'sized', 'free-size'].includes(body.sizingMode) ? body.sizingMode : 'auto',
    sizeChart, sizeChartProfile: ['auto', 'free-size', ...Object.keys(require('../../services/productSizingService').SIZE_CHART_PROFILES)].includes(body.sizeChartProfile) ? body.sizeChartProfile : 'auto', attributeValues,
    images: images.map((image) => ({ url: image.url, publicId: image.publicId, primary: image.id === primaryId,
      ...(image.kind === 'frame' ? { sourceFrame: { timestampSeconds: image.timestamp, qualityScore: image.qualityScore, width: image.width, height: image.height,
        selectionVersion: image.selectionVersion, viewType: ['front', 'back', 'side', 'detail', 'unknown'].includes(body.viewTypes?.[image.id]) ? body.viewTypes[image.id] : image.viewType || 'unknown' } } : {}) })),
    image: images.find((image) => image.id === primaryId).url,
  };
}
module.exports = { normalizeSocialUrl, validateDraftReview, SOCIAL_HOSTS, MAX_IMAGES };
