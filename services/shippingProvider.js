const { ApiError } = require('../utils/apiError');

const PROVIDERS = {
  bluedart: { label: 'Blue Dart', load: () => require('./blueDartProvider') },
  shiprocket: { label: 'Shiprocket', load: () => require('./shiprocketProvider') },
  delhivery: { label: 'Delhivery', load: () => require('./delhiveryProvider') },
  xpressbees: { label: 'Xpressbees', load: () => require('./xpressbeesProvider') },
};

function providerFor(name) {
  if (PROVIDERS[name]) return PROVIDERS[name].load();
  throw new ApiError('SHIPPING_UNAVAILABLE', 'This delivery provider is not connected.', { statusCode: 503 });
}

function getShippingProvider(name) {
  if (PROVIDERS[name]) {
    try { return providerFor(name).readiness(); }
    catch {
      return {
        name, label: PROVIDERS[name].label, mode: 'invalid', configured: false,
        missing: ['MODE / backend configuration'], liveBooking: false,
        trackingLookup: false, cod: false, reverse: false, rateQuotes: ['shiprocket', 'delhivery', 'xpressbees'].includes(name),
        note: `${PROVIDERS[name].label} backend configuration is invalid. Review its environment values and restart the backend.`,
      };
    }
  }
  return {
    name: 'manual', label: 'Manual / self delivery', mode: 'manual', configured: true, missing: [],
    liveBooking: false,
    trackingLookup: false,
    cod: true, reverse: true, rateQuotes: false,
    note: 'No courier API credentials are needed. Deliver with your own team, or book a courier yourself and add its real tracking ID and link. Staff must update delivery progress; there is no automatic courier tracking.',
  };
}

function getShippingProviders(selected = 'manual') {
  return [getShippingProvider('manual'), ...Object.keys(PROVIDERS).map(getShippingProvider)].map(provider => ({ ...provider, selected: provider.name === selected }));
}

function providerLabel(name) {
  return name === 'manual' ? 'Manual / self delivery' : PROVIDERS[name]?.label || 'Courier';
}

function isIntegratedProvider(name) {
  return Boolean(PROVIDERS[name]);
}

function assertLiveBookingDisabled() {
  throw new ApiError(
    'SERVICE_UNAVAILABLE',
    'Live courier booking is not enabled. Enter a real AWB from your courier dashboard.',
  );
}

module.exports = {
  providerFor,
  assertLiveBookingDisabled,
  getShippingProvider,
  getShippingProviders,
  providerLabel,
  isIntegratedProvider,
  PROVIDERS,
};
