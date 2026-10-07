const { log, newRequestId } = require('../utils/logger');

function requestContext(req, res, next) {
  req.requestId = String(req.headers['x-request-id'] || '').trim() || newRequestId();
  res.setHeader('x-request-id', req.requestId);
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const slowThreshold = Math.max(250, Number(process.env.SLOW_REQUEST_MS || 2000));
    if (process.env.LOG_REQUESTS === 'true' || durationMs >= slowThreshold) {
      log(durationMs >= slowThreshold ? 'warn' : 'info', 'HTTP request completed', {
        requestId: req.requestId,
        userId: req.user?._id,
        storeId: req.store?._id,
        method: req.method,
        path: String(req.originalUrl || '').split('?')[0],
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    }
  });
  next();
}

module.exports = { requestContext };
