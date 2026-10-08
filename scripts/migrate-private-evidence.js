// Default is read-only. Apply and public-object deletion require explicit flags.
require('dotenv').config();
const mongoose = require('mongoose');
const { migrate } = require('../services/privateEvidenceMigration');
async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply'), deletePublic = args.includes('--delete-public');
  if (deletePublic && !apply) throw new Error('--delete-public requires --apply');
  const storeId = args.find(arg => arg.startsWith('--store='))?.slice(8);
  if (storeId && !mongoose.isValidObjectId(storeId)) throw new Error('Invalid store ID');
  const limit = Math.min(500, Math.max(1, Number(args.find(arg => arg.startsWith('--limit='))?.slice(8)) || 100));
  if (!process.env.MONGO_URI) throw new Error('Configure the intended MONGO_URI before migration');
  await mongoose.connect(process.env.MONGO_URI);
  try { const result = await migrate({ apply, deletePublic, storeId, limit }); console.log(JSON.stringify(result, null, 2)); if (result.errors.length || result.sharedPublicReferences) process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('Migration could not complete. Check the intended database, storage configuration and flags. No credentials are printed.'); process.exitCode = 1; });

