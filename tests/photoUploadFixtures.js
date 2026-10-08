const crypto = require('node:crypto');
const { createCustomer } = require('./factories');

// Upload tests need an existing tenant; storefront provisioning is a separate
// control-plane workflow. The real seller permission middleware still runs.
async function createUploadSeller(name = 'Photo upload store') {
  const actor = await createCustomer({ activeMode: 'seller', availableModes: ['customer', 'seller'] });
  const store = await require('../models/Store').create({ name, slug: `photo-${crypto.randomUUID()}`, owner: actor.user._id, status: 'PUBLISHED', plan: 'PROFESSIONAL' });
  await require('../models/StoreMember').create({ store: store._id, user: actor.user._id, role: 'OWNER', status: 'ACTIVE' });
  return { ...actor, store };
}
module.exports = { createUploadSeller };
