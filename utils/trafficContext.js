const { ID } = require('../services/trafficAlgorithms');
// This is only an anonymous attribution hint, never proof of payment or access.
// No analytics DB/service call is allowed in the checkout critical path.
module.exports = function trafficContext(body) {
  const value = body?.traffic;
  if (value?.consent !== true || !ID.test(value.visitorId || '') || !ID.test(value.sessionId || '')) return undefined;
  return { visitorId: value.visitorId, sessionId: value.sessionId };
};
