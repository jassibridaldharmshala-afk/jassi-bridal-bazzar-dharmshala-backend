const mongoose = require('mongoose');

function storeIdPlugin(schema) {
  schema.add({
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', index: true },
  });
}

module.exports = storeIdPlugin;
