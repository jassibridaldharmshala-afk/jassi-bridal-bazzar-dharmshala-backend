const { wantsPagination, readPagination, buildPaginatedResponse } = require('./validators');

async function sendList(res, req, {
  model,
  filter = {},
  sort = '-createdAt',
  populate,
  select,
  mapItem,
  defaultLimit = 200,
  maxLimit = 500,
  unboundedWhenMissingPage = true,
}) {
  const paginate = wantsPagination(req.query);
  const { page, limit, skip } = paginate
    ? readPagination(req.query, { defaultLimit, maxLimit })
    : { page: 1, limit: unboundedWhenMissingPage ? maxLimit : defaultLimit, skip: 0 };

  let finder = model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) finder = finder.select(select);
  if (populate) finder = finder.populate(populate);

  if (!paginate) {
    const items = await finder;
    const mapped = mapItem ? items.map(mapItem) : items;
    return res.json(mapped);
  }

  const [items, total] = await Promise.all([
    finder,
    model.countDocuments(filter),
  ]);
  const mapped = mapItem ? items.map(mapItem) : items;
  return res.json(buildPaginatedResponse(mapped, { page, limit, total }));
}

module.exports = { sendList };
