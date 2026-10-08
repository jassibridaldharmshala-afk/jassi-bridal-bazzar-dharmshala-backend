const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDraftPhotoGroups } = require('../utils/draftPhotoGroups');

test('mixed photo counts form three products and each selected cover comes first', () => {
  const groups = [
    { name: 'Red lehenga', photoIndexes: [0, 3, 7, 9], coverIndex: 7 },
    { name: 'Jewellery set', photoIndexes: [1, 2, 4, 6, 8, 10], coverIndex: 2 },
    { name: '', photoIndexes: [5, 11], coverIndex: 11 },
  ];
  const result = resolveDraftPhotoGroups({ groupMode: 'grouped', photoGroups: JSON.stringify(groups) }, 12);
  assert.deepEqual(result.map((group) => group.photoIndexes.length), [4, 6, 2]);
  assert.deepEqual(result[0], { name: 'Red lehenga', photoIndexes: [7, 0, 3, 9] });
  assert.deepEqual(result[1].photoIndexes, [2, 1, 4, 6, 8, 10]);
  assert.equal(new Set(result.flatMap((group) => group.photoIndexes)).size, 12);
});

test('legacy one-product and one-product-per-photo uploads keep their behavior', () => {
  assert.deepEqual(resolveDraftPhotoGroups({ groupMode: 'single' }, 3), [{ name: '', photoIndexes: [0, 1, 2] }]);
  assert.deepEqual(resolveDraftPhotoGroups({}, 2), [{ name: '', photoIndexes: [0] }, { name: '', photoIndexes: [1] }]);
});

test('invalid groups cannot lose, duplicate, or borrow photos from another product', () => {
  const failures = [
    [{ photoIndexes: [0, 1] }, { photoIndexes: [1, 2] }],
    [{ photoIndexes: [0, 1] }],
    [{ photoIndexes: [0, 1, 3] }],
    [{ photoIndexes: [0, 1, '2'] }],
    [{ photoIndexes: [0, 1], coverIndex: 2 }, { photoIndexes: [2] }],
    [{ photoIndexes: [] }, { photoIndexes: [0, 1, 2] }],
  ];
  for (const photoGroups of failures) assert.throws(() => resolveDraftPhotoGroups({ groupMode: 'grouped', photoGroups }, 3), (error) => error.errorCode === 'VALIDATION_ERROR');
  assert.throws(() => resolveDraftPhotoGroups({ groupMode: 'grouped', photoGroups: '{bad' }, 3), /could not be read/);
  assert.throws(() => resolveDraftPhotoGroups({ groupMode: 'unsupported' }, 3), /valid product photo/);
  assert.throws(() => resolveDraftPhotoGroups({ groupMode: 'single' }, 31), /between 1 and 30/);
});
