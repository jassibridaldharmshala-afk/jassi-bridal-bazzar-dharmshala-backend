const { ApiError } = require('../../utils/apiError');
const { normalizeSocialUrl, MAX_IMAGES } = require('./socialImport.validation');
const network = require('./socialImport.network');

function decode(value = '') {
  return String(value).replace(/&#(x[\da-f]+|\d+);?/gi, (match, code) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const cleanText = (value, max = 6000) => decode(typeof value === 'string' ? value : '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function parsePublicPage(html, source) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]{0,20000}>/gi) || []) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
    const key = attrs.property || attrs.name;
    if (key && attrs.content) meta[key.toLowerCase()] = attrs.content;
  }
  const photos = []; const videos = []; const seen = new Set(); let caption = ''; let nodes = 0;
  const add = (url, kind, width = 0, height = 0) => {
    if (typeof url !== 'string') return;
    url = decode(url);
    try { network.checkedUrl(url, true); } catch { return; }
    if (/\/rsrc\.php|\/static\/|profile_pic|emoji|favicon/i.test(url) || (width && Number(width) < 200) || (height && Number(height) < 200)) return;
    const key = kind + ':' + new URL(url).origin + new URL(url).pathname;
    if (seen.has(key)) return;
    seen.add(key);
    (kind === 'video' ? videos : photos).push({ url, kind });
  };
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 28 || ++nodes > 40000) return;
    if (Array.isArray(node)) { node.slice(0, 300).forEach((value) => walk(value, depth + 1)); return; }
    if (node.shortcode && node.shortcode !== source.mediaId && source.platform === 'instagram') return;
    if (node.edge_media_to_caption?.edges?.[0]?.node?.text) caption = cleanText(node.edge_media_to_caption.edges[0].node.text);
    if (node.caption?.text && !caption) caption = cleanText(node.caption.text);
    if (node.message?.text && !caption) caption = cleanText(node.message.text);
    if (node.image_versions2?.candidates?.length) {
      const best = [...node.image_versions2.candidates].sort((a, b) => Number(b.width || 0) - Number(a.width || 0))[0];
      add(best.url, 'image', best.width, best.height);
    } else if (node.display_resources?.length) {
      const best = [...node.display_resources].sort((a, b) => Number(b.config_width || 0) - Number(a.config_width || 0))[0];
      add(best.src, 'image', best.config_width, best.config_height);
    } else if (node.display_url) add(node.display_url, 'image');
    if (node.video_url) add(node.video_url, 'video');
    if (node.video_versions?.length) add(node.video_versions[0].url, 'video');
    if (node.__typename === 'Photo' || node.__typename === 'Image') {
      const image = node.image || node.photo_image || node.viewer_image;
      if (image?.uri) add(image.uri, 'image', image.width, image.height);
    }
    if (node.__typename === 'Video') {
      add(node.playable_url_quality_hd || node.playable_url || node.browser_native_hd_url || node.browser_native_sd_url, 'video');
      add(node.preferred_thumbnail?.image?.uri, 'image');
    }
    if (node['@type'] === 'ImageObject') add(node.contentUrl || node.url, 'image');
    if (node['@type'] === 'VideoObject') { add(node.contentUrl, 'video'); add(Array.isArray(node.thumbnailUrl) ? node.thumbnailUrl[0] : node.thumbnailUrl, 'image'); }
    // These keys contain account pictures and suggested posts, not post media.
    for (const [key, value] of Object.entries(node)) if (!/owner|user|profile|recommend|suggest|related|comment|display_resources|image_versions2|video_versions/i.test(key)) walk(value, depth + 1);
  }
  for (const match of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 150)) {
    const body = match[1].trim();
    try {
      if (body.startsWith('{') || body.startsWith('[')) walk(JSON.parse(body));
      else if (/^window\._sharedData\s*=/.test(body)) walk(JSON.parse(body.replace(/^window\._sharedData\s*=\s*/, '').replace(/;\s*$/, '')));
    } catch { /* Non-JSON scripts are never executed. */ }
  }
  const foundAlbum = photos.length > 1;
  if (!photos.length) add(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'], 'image');
  if (!videos.length) add(meta['og:video:secure_url'] || meta['og:video'] || meta['twitter:player:stream'], 'video');
  caption = caption || cleanText(meta['og:description'] || meta.description || meta['twitter:description']);
  const generic = /^(?:instagram|facebook|log in|login|sign up|join instagram|see photos and videos)/i;
  const title = cleanText(meta['og:title'], 200);
  const available = photos.length || videos.length;
  return {
    caption: generic.test(caption) ? '' : caption, title: generic.test(title) ? '' : title,
    images: photos.slice(0, MAX_IMAGES), videos: videos.slice(0, 3), method: 'public-page',
    warnings: available ? [foundAlbum ? 'Review the imported gallery and remove photos that belong to other products.' : 'The platform may expose only a cover photo. Check the original post for additional photos.', ...(photos.length > MAX_IMAGES ? ['Only the first 20 photos were imported.'] : [])] : [],
  };
}

async function graph(path, fields, token, host = 'graph.facebook.com', after) {
  const configured = process.env.META_GRAPH_VERSION || process.env.SOCIAL_IMPORT_GRAPH_VERSION || '';
  const version = /^v\d+\.0$/.test(configured) ? configured : 'v23.0';
  const url = new URL(`https://${host}/${version}/${path}`);
  url.searchParams.set('fields', fields); url.searchParams.set('limit', '100');
  if (after) url.searchParams.set('after', after);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ApiError('SOCIAL_ACCOUNT_ACCESS', 'The connected account could not access this post. Reconnect it or use an accessible public post.', { statusCode: 422 });
  const body = await response.json();
  return body;
}
async function resolveConnected(source, storeId) {
  let token = ''; let accountId = '';
  let workspaceAccount = null;
  if (storeId) {
    const { Connection } = require('../social-workspace/models');
    workspaceAccount = await Connection.findOne({ storeId, provider: source.platform, status: { $in: ['connected', 'degraded'] }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ status: 1, updatedAt: -1 }).select('+token');
    if (workspaceAccount?.token) {
      token = require('../../utils/secretBox').decryptSecret(workspaceAccount.token);
      accountId = workspaceAccount.accountId || workspaceAccount.pageId || 'me';
    }
  }
  if (source.platform === 'instagram') {
    if (storeId && !token) {
      const Connection = require('../../models/InstagramConnection');
      const connection = await Connection.findOne({ storeId, status: 'CONNECTED' }).select('+encryptedAccessToken');
      if (connection?.encryptedAccessToken && (!connection.tokenExpiresAt || connection.tokenExpiresAt > new Date())) {
        token = require('../../utils/secretBox').decryptSecret(connection.encryptedAccessToken); accountId = connection.accountId || 'me';
      }
    } else {
      token = String(process.env.SOCIAL_IMPORT_INSTAGRAM_ACCESS_TOKEN || '').trim();
      accountId = String(process.env.SOCIAL_IMPORT_INSTAGRAM_ACCOUNT_ID || 'me').trim();
    }
    if (!token || !/^(?:me|\d+)$/.test(accountId)) return null;
    let after;
    for (let page = 0; page < 5; page++) {
      const body = await graph(`${accountId}/media`, 'id,caption,permalink,media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}', token, workspaceAccount?.apiHost || 'graph.instagram.com', after);
      const item = (body.data || []).find((value) => {
        try { return normalizeSocialUrl(value.permalink).mediaId === source.mediaId; } catch { return false; }
      });
      if (item) {
        const media = item.children?.data?.length ? item.children.data : [item];
        return { caption: cleanText(item.caption), title: '', method: 'connected-account',
          images: media.map((value) => ({ url: value.media_type === 'VIDEO' ? value.thumbnail_url : value.media_url, kind: 'image' })).filter((value) => value.url).slice(0, MAX_IMAGES),
          videos: media.filter((value) => value.media_type === 'VIDEO' && value.media_url).map((value) => ({ url: value.media_url, kind: 'video' })).slice(0, 3), warnings: [] };
      }
      after = body.paging?.cursors?.after;
      if (!body.paging?.next || !after) break;
    }
    return null;
  }
  // A server-owned Page token is used only in the global admin workspace.
  token = token || (!storeId && String(process.env.SOCIAL_IMPORT_FACEBOOK_PAGE_TOKEN || '').trim());
  if (!token || !/^[\d_]+$/.test(source.mediaId)) return null;
  const fields = source.kind === 'photo' ? 'id,name,images,link' : source.kind === 'video' ? 'id,title,description,source,picture,permalink_url'
    : 'id,message,permalink_url,attachments{media,type,subattachments{media,type}}';
  const item = await graph(source.mediaId, fields, token, workspaceAccount?.apiHost || 'graph.facebook.com');
  const images = []; const videos = [];
  if (item.images?.length) images.push({ url: [...item.images].sort((a, b) => b.width - a.width)[0].source, kind: 'image' });
  if (item.picture) images.push({ url: item.picture, kind: 'image' });
  if (item.source) videos.push({ url: item.source, kind: 'video' });
  for (const attachment of item.attachments?.data || []) for (const child of attachment.subattachments?.data || [attachment]) {
    if (child.media?.image?.src) images.push({ url: child.media.image.src, kind: 'image' });
    if (child.media?.source) videos.push({ url: child.media.source, kind: 'video' });
  }
  return { caption: cleanText(item.message || item.description || item.name), title: cleanText(item.title, 200), images: images.slice(0, MAX_IMAGES), videos: videos.slice(0, 3), method: 'connected-account', warnings: [] };
}
async function resolveSource(source, { storeId, signal } = {}) {
  let accountError;
  try { const connected = await resolveConnected(source, storeId); if (connected?.images.length || connected?.videos.length) return connected; }
  catch (error) { accountError = error; }
  const page = await network.safeRead(source.url, { signal });
  if (!/text\/html|application\/xhtml/.test(page.contentType)) throw new ApiError('SOCIAL_UNAVAILABLE', 'The link did not return a public product post.', { statusCode: 422 });
  const resolved = normalizeSocialUrl(page.url);
  if (resolved.platform !== source.platform) throw new ApiError('SOCIAL_URL_BLOCKED', 'The shared link redirected to another platform.');
  const data = parsePublicPage(page.buffer.toString('utf8'), resolved);
  if (!data.images.length && !data.videos.length) throw accountError || new ApiError('SOCIAL_UNAVAILABLE', 'Photos or video could not be read from this link. The post may be private, expired or login-restricted. Upload its media to continue.', { statusCode: 422 });
  return { ...data, resolvedUrl: resolved.url };
}
function suggestFromCaption(caption = '', title = '') {
  return require('../../services/productImportContext.service').captionSuggestion(cleanText(caption), cleanText(title));
}
module.exports = { parsePublicPage, resolveSource, resolveConnected, suggestFromCaption, cleanText };
