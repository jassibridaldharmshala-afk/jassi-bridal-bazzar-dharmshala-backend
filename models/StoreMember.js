const mongoose = require('mongoose');

const STORE_ROLES = [
  'OWNER',
  'MANAGER',
  'CATALOG_MANAGER',
  'ORDER_MANAGER',
  'SUPPORT',
  'MARKETING',
  'WAREHOUSE',
];

const PERMISSIONS_BY_ROLE = {
  OWNER: ['*'],
  MANAGER: [
    'catalog.read', 'catalog.write',
    'orders.read', 'orders.write',
    'returns.read', 'returns.write',
    'returns.review', 'returns.ship', 'returns.qc', 'returns.refund', 'returns.refund.pii', 'returns.fulfil',
    'support.read', 'support.write',
    'marketing.read', 'marketing.write',
    'inventory.read', 'inventory.write', 'inventory.bulk', 'inventory.approve',
    'inventory.receive', 'inventory.export', 'inventory.cost.read',
    'crm.read', 'crm.write',
    'crm.pii.read', 'crm.export',
    'inbox.read', 'inbox.write',
    'settings.read', 'settings.write',
    'design.read', 'design.write', 'design.publish',
    'content.read', 'content.write', 'content.publish',
    'audit.read',
    'instagram.read', 'instagram.write',
    'reviews.read', 'reviews.reply', 'reviews.moderate', 'reviews.export', 'reviews.delete',
    'reports.read', 'reports.export', 'reports.profit.read', 'reports.manage',
  ],
  CATALOG_MANAGER: ['catalog.read', 'catalog.write', 'inventory.read', 'reviews.read', 'reports.read', 'design.read', 'content.read', 'content.write'],
  ORDER_MANAGER: ['orders.read', 'orders.write', 'returns.read', 'returns.write', 'returns.review', 'returns.ship', 'returns.qc', 'returns.refund', 'returns.refund.pii', 'returns.fulfil', 'inventory.read', 'inventory.write', 'reports.read', 'reports.export'],
  SUPPORT: ['support.read', 'support.write', 'inbox.read', 'inbox.write', 'returns.read', 'returns.write', 'returns.review', 'returns.ship', 'orders.read', 'crm.read', 'crm.pii.read', 'reviews.read', 'reviews.reply', 'reviews.moderate'],
  MARKETING: ['marketing.read', 'marketing.write', 'catalog.read', 'crm.read', 'reviews.read', 'reviews.reply', 'reviews.export', 'reports.read', 'reports.export', 'design.read', 'design.write', 'content.read', 'content.write', 'content.publish'],
  WAREHOUSE: ['inventory.read', 'inventory.write', 'inventory.bulk', 'inventory.receive', 'inventory.export', 'orders.read', 'returns.read', 'returns.write', 'returns.qc', 'reports.read'],
};

const storeMemberSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: STORE_ROLES, required: true },
  status: { type: String, enum: ['ACTIVE', 'INVITED', 'REVOKED'], default: 'ACTIVE', index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invitedAt: Date,
  activatedAt: Date,
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  statusReason: { type: String, trim: true, maxlength: 500, default: '' },
}, { timestamps: true });

storeMemberSchema.index({ store: 1, user: 1 }, { unique: true });
storeMemberSchema.index({ user: 1, status: 1 });

function roleAllows(role, permission) {
  const granted = PERMISSIONS_BY_ROLE[role] || [];
  return granted.includes('*') || granted.includes(permission);
}

module.exports = mongoose.model('StoreMember', storeMemberSchema);
module.exports.STORE_ROLES = STORE_ROLES;
module.exports.PERMISSIONS_BY_ROLE = PERMISSIONS_BY_ROLE;
module.exports.roleAllows = roleAllows;
