const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const User = require('../models/User');
const Store = require('../models/Store');
const StoreMember = require('../models/StoreMember');
const { MASTER_OWNER_PHONE } = require('../config/masterOwner');
const { generateToken } = require('../utils/generateToken');
const { grantSellerMode } = require('../services/storeService');
const { createCustomer } = require('./factories');
const { request } = require('./helpers');

// Represents an already verified owner session, without bypassing route guards.
async function createMasterOwner() {
  let user = await User.findOne({ phone: MASTER_OWNER_PHONE }).select('+masterSessionVersion');
  if (!user) user = await User.create({ name: 'Test Master Owner', phone: MASTER_OWNER_PHONE,
    role: 'admin', activeMode: 'admin', availableModes: ['customer', 'admin'], systemRole: 'MASTER_OWNER',
    isPhoneVerified: true, masterSessionVersion: crypto.randomUUID() });
  user.$locals.masterAuthenticated = true;
  return { user, token: generateToken(user) };
}

async function createProvisionedSeller(name = 'Riya Fashion') {
  const { user, token } = await createCustomer();
  const master = await createMasterOwner();
  const created = await request('/api/stores', { method: 'POST', token: master.token,
    body: { name, whatsappNumber: user.phone, instagramHandle: 'riya.styles' } });
  assert.equal(created.status, 201);
  // Seller assignment is test data: customers cannot self-provision stores.
  await Store.updateOne({ _id: created.data.store.id }, { owner: user._id });
  await StoreMember.create({ store: created.data.store.id, user: user._id, role: 'OWNER', status: 'ACTIVE' });
  await grantSellerMode(user._id);
  return { user, token, store: created.data.store };
}

module.exports = { createMasterOwner, createProvisionedSeller };
