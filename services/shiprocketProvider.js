const { ApiError } = require('../utils/apiError');
const { pincode } = require('./shippingRules');
const { dateValue, downloadPdf, providerEnv: readEnv, providerError, requestJson, safeText, statusFromText } = require('./courierProviderUtils');

const NAME = 'Shiprocket';
const BASE = 'https://apiv2.shiprocket.in/v1/external';
const env = key => readEnv('SHIPROCKET', key);

function configuration() {
  return { mode: 'production', base: BASE, email: env('EMAIL'), password: env('PASSWORD'), pickupLocation: env('PICKUP_LOCATION'), fallbackEmail: env('FALLBACK_EMAIL') };
}

function readiness() {
  const config = configuration();
  const missing = [['EMAIL', config.email], ['PASSWORD', config.password], ['PICKUP_LOCATION', config.pickupLocation], ['FALLBACK_EMAIL', config.fallbackEmail]].filter(([, value]) => !value).map(([key]) => key);
  const enabled = env('LIVE_BOOKING_ENABLED') === 'true';
  return {
    name: 'shiprocket', label: NAME, mode: config.mode, configured: missing.length === 0, missing,
    liveBooking: !missing.length && enabled, trackingLookup: !missing.length, cod: env('COD_ENABLED') === 'true',
    reverse: env('REVERSE_ENABLED') === 'true', rateQuotes: true, cancelPickup: false,
    note: missing.length ? 'Complete the Shiprocket API user, pickup location and fallback email on the backend.' : !enabled ? 'Shiprocket is connected but live booking is disabled. Enable it after account testing.' : 'Shiprocket is ready. The available courier is selected from live serviceability results for every shipment.',
  };
}

let tokenCache;
let tokenPending;
async function token() {
  const config = configuration();
  const key = `${config.email}:${config.password}`;
  if (tokenCache?.key === key && tokenCache.until > Date.now()) return tokenCache.value;
  if (tokenPending?.key === key) return tokenPending.promise;
  const promise = (async () => {
    const body = await requestJson(NAME, `${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: config.email, password: config.password }) });
    if (typeof body.token !== 'string' || !body.token) throw providerError(NAME, 'the API user did not receive an access token.');
    tokenCache = { key, value: body.token, until: Date.now() + 9 * 24 * 60 * 60 * 1000 };
    return body.token;
  })();
  tokenPending = { key, promise };
  try { return await promise; } finally { if (tokenPending?.promise === promise) tokenPending = null; }
}

async function api(path, { method = 'GET', body } = {}, write = false) {
  return requestJson(NAME, `${BASE}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, write);
}

function courierRows(body) {
  const data = body?.data?.available_courier_companies || body?.data || [];
  return Array.isArray(data) ? data : [];
}

function chooseCourier(rows) {
  const available = rows.filter(row => row && (row.courier_company_id || row.courier_id || row.id));
  const forcedId = env('COURIER_ID');
  if (forcedId) return available.find(row => String(row.courier_company_id || row.courier_id || row.id) === forcedId) || null;
  const preferred = env('PREFERRED_COURIER').toLowerCase();
  const named = preferred && available.filter(row => safeText(row.courier_name || row.name).toLowerCase().includes(preferred));
  const pool = named?.length ? named : available;
  const strategy = env('SELECTION_STRATEGY') || 'recommended';
  return [...pool].sort((left, right) => {
    if (strategy === 'cheapest') return Number(left.rate ?? Infinity) - Number(right.rate ?? Infinity);
    if (strategy === 'fastest') return Number(left.estimated_delivery_days ?? left.etd ?? Infinity) - Number(right.estimated_delivery_days ?? right.etd ?? Infinity);
    return Number(right.rating ?? right.courier_rating ?? right.recommendation_score ?? 0) - Number(left.rating ?? left.courier_rating ?? left.recommendation_score ?? 0) || Number(left.rate ?? Infinity) - Number(right.rate ?? Infinity);
  })[0] || null;
}

async function serviceability({ origin, destination, cod = false, reverse = false, parcel, amount = 0 }) {
  if (cod && env('COD_ENABLED') !== 'true') throw new ApiError('SHIPPING_COD_UNAVAILABLE', 'Cash on Delivery is not enabled for this Shiprocket account. Choose online payment.');
  if (reverse && env('REVERSE_ENABLED') !== 'true') throw new ApiError('SHIPPING_REVERSE_UNAVAILABLE', 'Return pickup is not enabled for this Shiprocket account.');
  const query = new URLSearchParams({ pickup_postcode: pincode(origin.pincode), delivery_postcode: pincode(destination.pincode), cod: cod ? '1' : '0', weight: String(parcel?.chargeableWeightKg || parcel?.weightKg || 0.5), declared_value: String(Math.max(0, Number(amount || 0))), ...(reverse ? { is_return: '1' } : {}) });
  const body = await api(`/courier/serviceability/?${query}`);
  const selected = chooseCourier(courierRows(body));
  if (!selected) throw new ApiError(cod ? 'SHIPPING_COD_UNAVAILABLE' : 'SHIPPING_NOT_SERVICEABLE', cod ? 'Shiprocket has no COD courier for this PIN code. Choose online payment or another address.' : 'Shiprocket has no serviceable courier for this route. Choose another address.');
  const rate = Number(selected.rate ?? selected.freight_charge);
  return {
    provider: 'shiprocket', mode: 'production', serviceable: true, checkedAt: new Date(),
    courierName: safeText(selected.courier_name || selected.name, 100) || NAME,
    serviceName: safeText(selected.courier_name || selected.name, 100),
    service: { courierId: String(selected.courier_company_id || selected.courier_id || selected.id), courierName: safeText(selected.courier_name || selected.name, 100), estimatedDays: Number(selected.estimated_delivery_days ?? selected.etd) || undefined },
    ...(Number.isFinite(rate) && rate >= 0 ? { providerRate: Math.round(rate * 100) / 100 } : {}),
  };
}

function address(value = {}) {
  return { name: safeText(value.fullName, 100), line1: safeText([value.houseNo || value.houseNumber, value.area].filter(Boolean).join(', '), 190), line2: safeText(value.landmark, 190), city: safeText(value.city, 100), state: safeText(value.state, 100), pin: pincode(value.pincode), phone: String(value.mobile || value.phone || '').replace(/\D/g, '').slice(-10) };
}

function itemRows(order) {
  return order.orderItems.map((item, index) => ({ name: safeText(item.name || item.productName, 200) || `Product ${index + 1}`, sku: safeText(item.sku, 100) || `SKU-${index + 1}`, units: Math.max(1, Number(item.quantity || 1)), selling_price: Math.max(0, Number(item.price || 0)), discount: Math.max(0, Number(item.discount || 0)), tax: Math.max(0, Number(item.tax || 0)), hsn: safeText(item.hsn, 20) }));
}

function orderPayload(booking, order, reverse) {
  const from = address(booking.pickupAddress), to = address(booking.destination), parcel = booking.parcel;
  const items = itemRows(order);
  const subtotal = Math.max(0, items.reduce((sum, row) => sum + row.selling_price * row.units, 0));
  const orderDiscount = reverse ? 0 : Math.max(0, Number(order.couponDiscount || 0) + Number(order.prepaidDiscount || 0));
  const common = { order_id: booking.providerRef, order_date: new Date().toISOString().slice(0, 19).replace('T', ' '), order_items: items, payment_method: reverse ? 'PREPAID' : order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid' ? 'COD' : 'Prepaid', total_discount: orderDiscount, sub_total: subtotal, length: parcel.lengthCm, breadth: parcel.widthCm, height: parcel.heightCm, weight: parcel.weightKg };
  if (reverse) return { ...common, pickup_customer_name: from.name, pickup_address: from.line1, pickup_address_2: from.line2, pickup_city: from.city, pickup_state: from.state, pickup_country: 'India', pickup_pincode: Number(from.pin), pickup_email: configuration().fallbackEmail, pickup_phone: from.phone, shipping_customer_name: to.name, shipping_address: to.line1, shipping_address_2: to.line2, shipping_city: to.city, shipping_state: to.state, shipping_country: 'India', shipping_pincode: Number(to.pin), shipping_email: configuration().fallbackEmail, shipping_phone: to.phone };
  return { ...common, pickup_location: configuration().pickupLocation, billing_customer_name: to.name, billing_address: to.line1, billing_address_2: to.line2, billing_city: to.city, billing_pincode: to.pin, billing_state: to.state, billing_country: 'India', billing_email: configuration().fallbackEmail, billing_phone: to.phone, shipping_is_billing: true, shipping_charges: Number(order.deliveryCharge || 0), giftwrap_charges: 0, transaction_charges: Number(order.platformFee || 0) + Number(order.codCharge || 0) };
}

function nestedData(body) { return body?.response?.data || body?.data || body || {}; }
function extractAwb(body) { const value = nestedData(body).awb_code || nestedData(body).awb || body?.awb_code; return /^[A-Za-z0-9-]{6,30}$/.test(String(value || '')) ? String(value) : ''; }

async function labelFor(shipmentId) {
  try {
    const response = await api('/courier/generate/label', { method: 'POST', body: { shipment_id: [Number(shipmentId)] } }, true);
    const url = response.label_url || response?.response?.label_url || response?.data?.label_url;
    return url ? await downloadPdf(NAME, url) : undefined;
  } catch { return undefined; }
}

async function book({ booking, order, reverse }) {
  if (!readiness().liveBooking) throw providerError(NAME, readiness().note);
  let providerOrderId;
  let providerShipmentId;
  try {
    const created = await api(reverse ? '/orders/create/return' : '/orders/create/adhoc', { method: 'POST', body: orderPayload(booking, order, reverse) }, true);
    providerOrderId = created.order_id || created?.data?.order_id;
    providerShipmentId = created.shipment_id || created?.data?.shipment_id;
    if (!providerOrderId || !providerShipmentId) throw providerError(NAME, 'the order was not confirmed by Shiprocket.', { ambiguous: true });
    const assigned = await api('/courier/assign/awb', { method: 'POST', body: { shipment_id: Number(providerShipmentId), ...(booking.service?.courierId ? { courier_id: Number(booking.service.courierId) } : {}), ...(reverse ? { is_return: 1 } : {}) } }, true);
    let awb = extractAwb(assigned);
    if (!awb) {
      const tracked = await api(`/courier/track/shipment/${encodeURIComponent(providerShipmentId)}`).catch(() => null);
      awb = extractAwb(tracked);
    }
    if (!awb) throw providerError(NAME, 'AWB assignment is still processing. Reconcile this shipment before retrying.', { ambiguous: true });
    return { awb, providerOrderId: String(providerOrderId), providerShipmentId: String(providerShipmentId), courierName: safeText(nestedData(assigned).courier_name || booking.service?.courierName, 100) || NAME, labelPdf: await labelFor(providerShipmentId) };
  } catch (error) {
    if (providerOrderId || providerShipmentId) error.recovery = { providerOrderId: String(providerOrderId || ''), providerShipmentId: String(providerShipmentId || '') };
    throw error;
  }
}

async function pickup({ booking, slot, reverse }) {
  if (reverse) return { token: booking.providerShipmentId || booking.awb, date: slot.date, time: slot.time, closeTime: slot.closeTime, automatic: true };
  if (!booking.providerShipmentId) throw providerError(NAME, 'the Shiprocket shipment reference is missing. Reconcile the booking first.');
  const body = await api('/courier/generate/pickup', { method: 'POST', body: { shipment_id: [Number(booking.providerShipmentId)] } }, true);
  const data = body?.response || body?.data || body;
  const successful = body.pickup_status === 1 || body.status === 1 || body.success === true || /success|scheduled|generated/i.test(String(body.message || data?.message || ''));
  if (!successful) throw providerError(NAME, 'pickup was not confirmed. Check Shiprocket before retrying.', { ambiguous: true });
  return { token: String(data?.pickup_token_number || data?.pickup_id || booking.providerShipmentId), date: slot.date, time: slot.time, closeTime: slot.closeTime };
}

async function cancel({ booking }) {
  if (!booking.providerOrderId) throw providerError(NAME, 'the Shiprocket order reference is missing. Cancel it from the carrier dashboard.');
  await api('/orders/cancel', { method: 'POST', body: { ids: [Number(booking.providerOrderId)] } }, true);
}

function tracking(body, expectedAwb = '') {
  const data = body?.tracking_data || body?.data?.tracking_data || body?.data || body || {};
  const shipment = Array.isArray(data.shipment_track) ? data.shipment_track[0] || {} : data.shipment_track || data;
  const activities = data.shipment_track_activities || data.activities || [];
  const current = safeText(shipment.current_status || data.current_status || data.status, 250);
  const events = (Array.isArray(activities) ? activities : []).map(row => ({ status: statusFromText(row['sr-status-label'] || row.activity || row.status) || 'UPDATE', note: safeText([row.activity, row.location].filter(Boolean).join(' · '), 500), date: dateValue(row.date || row.activity_date || row.updated_at) })).filter(row => row.date);
  const awb = safeText(shipment.awb_code || data.awb_code || expectedAwb, 30);
  if (!awb) throw providerError(NAME, 'tracking has no confirmed AWB yet.');
  return { awb, providerStatus: current, status: statusFromText(current), providerStatusAt: dateValue(shipment.delivered_date || shipment.updated_at || events.at(-1)?.date), expectedDeliveryAt: dateValue(data.etd || shipment.edd), events };
}

async function track({ booking, byReference = false }) {
  const path = byReference && booking.providerOrderId ? `/courier/track?order_id=${encodeURIComponent(booking.providerOrderId)}` : `/courier/track/awb/${encodeURIComponent(booking.awb)}`;
  return tracking(await api(path), booking.awb);
}

module.exports = { name: 'shiprocket', label: NAME, readiness, serviceability, book, pickup, cancel, track, chooseCourier, orderPayload, tracking };
