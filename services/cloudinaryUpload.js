const crypto = require('crypto');
const fs = require('fs/promises');

function isCloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

async function uploadImage(file, options = {}) {
  return uploadFile(file, 'image', options);
}

async function uploadFile(file, resourceType = 'image', options = {}) {
  if (!isCloudinaryConfigured()) return null;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const baseFolder = process.env.CLOUDINARY_FOLDER || 'samira-products';
  const suffix = String(options.folder || '').replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+|\/+$/g, '');
  const folder = suffix ? `${baseFolder}/${suffix}` : baseFolder;
  const timestamp = Math.floor(Date.now() / 1000);
  const uploadId = /^[a-f0-9]{64}$/.test(options.uploadId || '') ? `retry-${options.uploadId}` : '';
  if (uploadId && options.recovering) {
    const existing = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/upload/${encodeURIComponent(`${folder}/${uploadId}`)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}` }, signal: AbortSignal.timeout(30000),
    });
    if (existing.ok) {
      const saved = await existing.json();
      if (saved.secure_url && saved.public_id) return { url: saved.secure_url, publicId: saved.public_id, originalName: file.originalname };
      throw new Error('Cloudinary did not return the saved file. Please retry.');
    }
    if (existing.status !== 404) throw new Error('Unable to check the previous Cloudinary upload. Please retry.');
  }
  const parameters = { folder, timestamp, ...(uploadId ? { public_id: uploadId, overwrite: 'false' } : {}) };
  const signature = crypto
    .createHash('sha1')
    .update(`${Object.keys(parameters).sort().map(key => `${key}=${parameters[key]}`).join('&')}${apiSecret}`)
    .digest('hex');

  const buffer = await fs.readFile(file.path);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: file.mimetype }), file.originalname);
  form.append('api_key', apiKey);
  Object.entries(parameters).forEach(([key, value]) => form.append(key, String(value)));
  form.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(resourceType === 'video' ? 10 * 60 * 1000 : 2 * 60 * 1000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Cloudinary upload failed');
  if (!data.secure_url || !data.public_id) throw new Error('Cloudinary did not return an uploaded file. Please retry.');

  return {
    url: data.secure_url,
    publicId: data.public_id,
    originalName: file.originalname,
  };
}

async function uploadVideo(file, options = {}) {
  return uploadFile(file, 'video', options);
}

async function deleteFile(identifier, resourceType = 'image') {
  if (!isCloudinaryConfigured()) return false;
  const publicId = typeof identifier === 'object' ? identifier?.publicId : identifier;
  if (!String(publicId || '').trim()) return false;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
    .digest('hex');
  const form = new FormData();
  form.append('public_id', String(publicId));
  form.append('api_key', process.env.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  const safeResourceType = resourceType === 'video' ? 'video' : 'image';
  const response = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${safeResourceType}/destroy`, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Cloudinary file deletion failed');
  const deleted = ['ok', 'not found'].includes(data.result);
  if (deleted) await require('./uploadRetryService').invalidateStoredUpload('cloudinary', String(publicId));
  return deleted;
}

module.exports = { deleteFile, isCloudinaryConfigured, uploadImage, uploadVideo };
