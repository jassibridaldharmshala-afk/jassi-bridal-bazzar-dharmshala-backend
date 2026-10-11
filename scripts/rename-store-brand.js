// Preview by default; --apply updates only the default shop's branding.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { usePublicDnsForAtlasSrv } = require('../config/db');

const STORE_NAME = 'Jassi Bridal Bazar Dharmshala';
const LEGACY_NAME = /Jassi General Store|Jassi(?:['’]s)? Bridal Baz{1,2}a{1,2}r(?: Dha[a-z]*shala)?/gi;

function renameCopy(value) {
  if (typeof value === 'string') return value.replace(LEGACY_NAME, match =>
    match === match.toUpperCase() ? STORE_NAME.toUpperCase()
      : match === match.toLowerCase() ? STORE_NAME.toLowerCase() : STORE_NAME);
  if (Array.isArray(value)) return value.map(renameCopy);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameCopy(item)]));
  }
  return value;
}

function at(document, field) {
  return field.split('.').reduce((value, key) => value?.[key], document);
}

async function renameCollection(db, collection, query, fields, apply, force = {}) {
  const result = { collection, matched: 0, updated: 0, conflicts: 0, fields: {} };
  const projection = Object.fromEntries(fields.map(field => [field, 1]));
  for await (const document of db.collection(collection).find(query, { projection })) {
    const updates = {}, guard = { _id: document._id };
    for (const field of fields) {
      const before = at(document, field);
      const after = Object.hasOwn(force, field) ? force[field] : renameCopy(before);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      updates[field] = after;
      guard[field] = before === undefined ? { $exists: false } : before;
      result.fields[field] = (result.fields[field] || 0) + 1;
    }
    if (!Object.keys(updates).length) continue;
    result.matched += 1;
    if (apply) {
      const changed = await db.collection(collection).updateOne(guard, { $set: updates });
      result.updated += changed.modifiedCount;
      if (!changed.matchedCount) result.conflicts += 1;
    }
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  usePublicDnsForAtlasSrv(process.env.MONGO_URI);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 7000 });
  try {
    const db = mongoose.connection.db;
    const store = await db.collection('stores').findOne({ isDefault: true })
      || await db.collection('stores').findOne({ slug: 'jassi-general-store' });
    if (!store) throw new Error('Default store not found');
    const scope = { $or: [{ storeId: store._id }, { storeId: null }] };
    const results = [];
    results.push(await renameCollection(db, 'stores', { _id: store._id }, [
      'name', 'legalName', 'bio', 'storefrontDesign.draftConfig', 'storefrontDesign.publishedConfig',
      'storefrontDesign.scheduledConfig', 'storefrontDesign.scheduledContent',
    ], apply, { name: STORE_NAME }));
    results.push(await renameCollection(db, 'settings', scope, [
      'storeName', 'legalBusinessName', 'tagline', 'seoTitle', 'seoDescription', 'footerText',
      'announcementText', 'invoiceNote', 'returnPolicy', 'privacyPolicy', 'termsConditions',
      'shippingPolicy', 'cancellationPolicy', 'sizeGuide', 'faqs', 'ourStory',
    ], apply, { storeName: STORE_NAME }));
    for (const collection of ['products', 'productdrafts']) {
      results.push(await renameCollection(db, collection, scope, [
        'brand', 'sellerName', 'name', 'shortDescription', 'description', 'metaTitle', 'metaDescription', 'tags',
      ], apply));
    }
    results.push(await renameCollection(db, 'websitethemes', {}, [
      'name', 'draftConfig', 'publishedConfig', 'scheduledConfig', 'scheduledContent',
    ], apply));
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', storeName: STORE_NAME, results }, null, 2));
    if (results.some(result => result.conflicts)) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(() => {
  console.error('Store branding update failed. Check database access and rerun the preview; credentials are not printed.');
  process.exitCode = 1;
});
