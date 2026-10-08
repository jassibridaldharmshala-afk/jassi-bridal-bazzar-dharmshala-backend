// Rental journeys now require an enabled online provider before creating an
// online hold. These tests exercise reservation/return rules without calling it.
require('node:test').mock.method(require('../services/razorpayService'), 'isRazorpayConfigured', () => true);

module.exports.configure = store => require('../models/Settings').updateOne({ storeId: store._id }, { $set: { razorpayEnabled: true } }, { upsert: true });
