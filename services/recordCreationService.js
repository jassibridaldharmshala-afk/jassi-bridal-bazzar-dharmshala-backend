const mongoose = require('mongoose');
const Operation = require('../models/UploadOperation');
const { runUploadRequest } = require('./uploadRetryService');
const { ApiError } = require('../utils/apiError');

// The record ID is allocated before insertion. A crash between save and receipt
// completion can therefore recover the same record, not execute create twice.
async function createRecordOnce(req, { Model, filter = {}, create }) {
  const load = async id => {
    const record = await Model.findOne({ $and: [{ _id: id }, filter] });
    if (!record) throw new ApiError('UPLOAD_RETRY_CONFLICT', 'This record was removed. Start a new save instead of retrying the old one.', { statusCode: 409 });
    return record;
  };
  const saved = await runUploadRequest(req, async context => {
    if (!context.managed) return { recordId: String((await create({}))._id) };
    const id = new mongoose.Types.ObjectId(context.id.slice(0, 24));
    const owned = { _id: context.id, status: 'RUNNING' };
    await Operation.updateOne(owned, { $set: { recordId: String(id) } });
    let record = await Model.findOne({ $and: [{ _id: id }, filter] });
    if (!record) {
      try { record = await create({ _id: id, uploadOperationId: context.id }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        record = await load(id);
      }
    }
    return { recordId: String(record._id) };
  }, { recordOnly: true, replay: async result => { await load(result.recordId); return result; } });
  return load(saved.recordId);
}

async function invalidateRecordCreation(recordId, session) {
  await Operation.updateMany({ recordId: String(recordId) }, { $set: { status: 'REMOVED' } }, { session });
}
module.exports = { createRecordOnce, invalidateRecordCreation };
