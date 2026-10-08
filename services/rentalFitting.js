const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
function fitting(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('VALIDATION_ERROR', 'Choose fitting details.');
  for (const key of ['adjustable', 'alterationsAvailable']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Choose valid fitting options.');
  return { adjustable: input.adjustable === true, alterationsAvailable: input.alterationsAvailable === true, instructions: A.text(input.instructions || '', 1000) };
}
module.exports = { fitting };
