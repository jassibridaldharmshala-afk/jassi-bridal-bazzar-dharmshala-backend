const A = require('./rentalAlgorithms');
const { ApiError } = require('../utils/apiError');
function fitting(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('VALIDATION_ERROR', 'Choose fitting details.');
  for (const key of ['adjustable', 'alterationsAvailable']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiError('VALIDATION_ERROR', 'Choose valid fitting options.');
  const value = { adjustable: input.adjustable === true, alterationsAvailable: input.alterationsAvailable === true, instructions: A.text(input.instructions || '', 1000) };
  if (input.type !== undefined) {
    if (!['OTHER', 'LEHENGA', 'BANGLES_RINGS', 'NECKLACE', 'BRIDAL_SET'].includes(input.type)) throw new ApiError('VALIDATION_ERROR', 'Choose a valid fitting template.');
    value.type = input.type;
  }
  if (input.unit !== undefined) {
    if (!['cm', 'in'].includes(input.unit)) throw new ApiError('VALIDATION_ERROR', 'Choose cm or inches for fitting measurements.');
    value.unit = input.unit;
  }
  if (input.measurements !== undefined) {
    if (!input.measurements || typeof input.measurements !== 'object' || Array.isArray(input.measurements)) throw new ApiError('VALIDATION_ERROR', 'Enter valid owner-measured fitting details.');
    value.measurements = {};
    for (const key of ['waistMin', 'waistMax', 'bustMin', 'bustMax', 'length', 'alterationAllowance', 'necklaceLength', 'necklaceWidth']) {
      const raw = input.measurements[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 10000) throw new ApiError('VALIDATION_ERROR', 'Fitting measurements must be valid non-negative values.');
      value.measurements[key] = number;
    }
    for (const key of ['waist', 'bust']) if (value.measurements[key + 'Min'] !== undefined && value.measurements[key + 'Max'] !== undefined && value.measurements[key + 'Min'] > value.measurements[key + 'Max']) throw new ApiError('VALIDATION_ERROR', 'The fitting range minimum must not exceed its maximum.');
  }
  if (input.actualSize !== undefined) value.actualSize = A.text(input.actualSize || '', 100);
  if (input.includedItems !== undefined) value.includedItems = A.text(input.includedItems || '', 1000);
  return value;
}
module.exports = { fitting };
