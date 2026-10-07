const { ApiError } = require('../utils/apiError');
const { pincode } = require('./shippingRules');
const { dateValue, downloadPdf, providerEnv: readEnv, providerError, requestJson, safeText, statusFromText } = require('./courierProviderUtils');

const NAME = 'Xpressbees';
const BASE = 'https://shipment.xpressbees.com/api';
const env = key => readEnv('XPRESSBEES', key);

function configuration() {
  return { mode: 'production', base: BASE, email: env('EMAIL'), password: env('PASSWORD'), warehouse: env('WAREHOUSE_NAME') };
}

function readiness() {
  const config = configuration();
  const missing = [['EMAIL', config.email], ['PASSWORD', config.password], ['WAREHOUSE_NAME', config.warehouse]].filter(([, value]) => !value).map(([key]) => key);
  const enabled = env('LIVE_BOOKING_ENABLED') === 'true';
  return {
    name: 'xpressbees', label: NAME, mode: config.mode, configured: missing.length === 0, missing,
    liveBooking: !missing.length && enabled, trackingLookup: !missing.length,
    cod: env('COD_ENABLED') === 'true', reverse: env('REVERSE_ENABLED') === 'true', rateQuotes: true, cancelPickup: false,
    note: missing.length ? 'Complete the Xpressbees API user and registered warehouse on the backend.' : !enabled ? 'Xpressbees is connected but live booking is disabled. Enable it after account validation.' : 'Xpressbees is ready. AWB, pickup, label and tracking are managed through its backend API.',
  };
}

let tokenCache;
let tokenPending;
async function token() {
  const config = configuration(), key = `${config.email}:${config.password}`;
  if (tokenCache?.key === key && tokenCache.until > Date.now()) return tokenCache.value;
  if (tokenPending?.key === key) return tokenPending.promise;
  const promise = (async () => {
    const body = await requestJson(NAME, `${BASE}/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: config.email, password: config.password }) });
    const value = body.data?.token || body.data || body.token;
    if (typeof value !== 'string' || !value) throw providerError(NAME, 'the API user did not receive an access token.');
    tokenCache = { key, value, until: Date.now() + 50 * 60 * 1000 };
    return value;
  })();
  tokenPending = { key, promise };
  try { return await promise; } finally { if (tokenPending?.promise === promise) tokenPending = null; }
}

async function api(path, { method = 'GET', body } = {}, write = false) {
  return requestJson(NAME, `${BASE}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, write);
}

function serviceRows(body) {
  const rows = body?.data || body?.message || [];
  return Array.isArray(rows) ? rows : [];
}

function chooseService(rows) {
  const forced = env('COURIER_ID');
  const available = rows.filter(Boolean);
  if (forced) return available.find(row => String(row.id || row.courier_id) === forced) || null;
  return [...available].sort((a, b) => Number(a.total_price ?? a.freight_charges ?? Infinity) - Number(b.total_price ?? b.freight_charges ?? Infinity))[0] || null;
}

async function serviceability({ origin, destination, cod = false, reverse = false, parcel, amount = 0 }) {
  if (cod && env('COD_ENABLED') !== 'true') throw new ApiError('SHIPPING_COD_UNAVAILABLE', 'Cash on Delivery is not enabled for this Xpressbees account. Choose online payment.');
  if (reverse && env('REVERSE_ENABLED') !== 'true') throw new ApiError('SHIPPING_REVERSE_UNAVAILABLE', 'Reverse pickup is not enabled for this Xpressbees account.');
  const body = await api('/courier/serviceability', { method: 'POST', body: { origin: pincode(origin.pincode), destination: pincode(destination.pincode), cod: cod ? 'cod' : 'prepaid', order_amount: Math.max(0, Number(amount || 0)), weight: Number(parcel?.chargeableWeightKg || parcel?.weightKg || 0.5), length: Number(parcel?.lengthCm || 1), breadth: Number(parcel?.widthCm || 1), height: Number(parcel?.heightCm || 1), ...(reverse ? { payment_type: 'reverse' } : {}) } });
  const selected = chooseService(serviceRows(body));
  if (!selected || body.status === false) throw new ApiError(cod ? 'SHIPPING_COD_UNAVAILABLE' : 'SHIPPING_NOT_SERVICEABLE', cod ? 'Xpressbees COD is unavailable for this route. Choose online payment.' : 'Xpressbees delivery is unavailable for this route. Choose another address.');
  const rate = Number(selected.total_price ?? selected.rate ?? selected.freight_charges ?? selected.courier_charges);
  return { provider: 'xpressbees', mode: 'production', serviceable: true, checkedAt: new Date(), courierName: safeText(selected.name || selected.courier_name, 100) || NAME, serviceName: safeText(selected.name || selected.courier_name, 100), service: { courierId: String(selected.id || selected.courier_id || '') }, ...(Number.isFinite(rate) && rate >= 0 ? { providerRate: Math.round(rate * 100) / 100 } : {}) };
}

function cleanAddress(value = {}) {
  return { name: safeText(value.fullName, 200), address: safeText([value.houseNo || value.houseNumber, value.area].filter(Boolean).join(', '), 200), address_2: safeText(value.landmark, 200), city: safeText(value.city, 40), state: safeText(value.state, 40), pincode: pincode(value.pincode), phone: String(value.mobile || value.phone || '').replace(/\D/g, '').slice(-10) };
}

function shipmentPayload(booking, order, reverse) {
  const consignee = cleanAddress(booking.destination), pickup = { warehouse_name: configuration().warehouse, ...cleanAddress(booking.pickupAddress) };
  const amount = Math.max(0, Number(order.finalAmount || 0));
  const cod = !reverse && order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid';
  return {
    order_number: booking.providerRef, payment_type: reverse ? 'reverse' : cod ? 'cod' : 'prepaid', order_amount: amount,
    collectable_amount: cod ? amount : 0, shipping_charges: Math.max(0, Number(order.deliveryCharge || 0)), cod_charges: Math.max(0, Number(order.codCharge || 0)), discount: Math.max(0, Number(order.discount || 0)),
    package_weight: Math.ceil(booking.parcel.weightKg * 1000), package_length: booking.parcel.lengthCm, package_breadth: booking.parcel.widthCm, package_height: booking.parcel.heightCm,
    request_auto_pickup: 'yes', consignee, pickup, is_rto_different: 'no', ...(booking.service?.courierId ? { courier_id: booking.service.courierId } : {}),
    order_items: order.orderItems.map((item, index) => ({ name: safeText(item.name || item.productName, 200) || `Product ${index + 1}`, qty: String(Math.max(1, Number(item.quantity || 1))), price: String(Math.max(0, Number(item.price || 0))), sku: safeText(item.sku, 100), hsn: safeText(item.hsn, 20) })),
  };
}

async function book({ booking, order, reverse, slot }) {
  if (!readiness().liveBooking) throw providerError(NAME, readiness().note);
  const body = await api('/shipments2', { method: 'POST', body: shipmentPayload(booking, order, reverse) }, true);
  const data = body?.data || body;
  if (body.status === false || body.response === false) throw providerError(NAME, 'shipment creation was rejected. Verify the address, warehouse and account services.', { statusCode: 400 });
  const awb = safeText(data.awb_number || data.awb || data.tracking_number, 30);
  if (!/^[A-Za-z0-9-]{6,30}$/.test(awb)) throw providerError(NAME, 'shipment creation was not confirmed with an AWB. Reconcile before retrying.', { ambiguous: true });
  let labelPdf;
  if (data.label) { try { labelPdf = await downloadPdf(NAME, data.label); } catch { /* AWB remains valid without a cached label. */ } }
  return { awb, providerOrderId: String(data.order_id || booking.providerRef), providerShipmentId: String(data.shipment_id || data.shipping_id || ''), courierName: safeText(data.courier_name, 100) || NAME, labelPdf, pickup: { token: String(data.pickup_token_number || data.shipment_id || data.shipping_id || awb), date: slot.date, time: slot.time, closeTime: slot.closeTime, automatic: true } };
}

async function pickup({ booking, slot }) {
  return { token: booking.pickup?.token || booking.providerShipmentId || booking.awb, date: slot.date, time: slot.time, closeTime: slot.closeTime, automatic: true };
}

async function cancel({ booking }) {
  const body = await api('/shipments2/cancel', { method: 'POST', body: { awb_number: booking.awb } }, true);
  if (body.status === false || body.response === false) throw providerError(NAME, 'shipment cancellation was not confirmed. Check the carrier dashboard.', { ambiguous: true });
}

function tracking(body, expectedAwb = '') {
  const data = body?.tracking_data || body?.data?.tracking_data || body?.data || {};
  const groups = Array.isArray(data) ? [data] : Object.values(data).filter(Array.isArray);
  const rawEvents = groups.flat();
  const events = rawEvents.map(row => ({ status: statusFromText(row.ship_status || row.status || row.message) || 'UPDATE', note: safeText([row.message || row.status, row.location].filter(Boolean).join(' · '), 500), date: /^\d{10}$/.test(String(row.event_time || '')) ? new Date(Number(row.event_time) * 1000) : dateValue(row.event_time || row.event_date || row.updated_at) })).filter(row => row.date).sort((a, b) => a.date - b.date);
  const latest = events.at(-1);
  const source = rawEvents.at(-1) || data;
  const awb = safeText(source?.awb_number || source?.awb || expectedAwb, 30);
  if (!awb) throw providerError(NAME, 'tracking has no confirmed AWB yet.');
  const current = safeText(source?.ship_status || source?.status || source?.message || latest?.note, 250);
  return { awb, providerStatus: current, status: statusFromText(current) || latest?.status, providerStatusAt: latest?.date || dateValue(source?.event_time), expectedDeliveryAt: dateValue(source?.expected_delivery_date), events };
}

async function track({ booking }) {
  return tracking(await api(`/shipments2/track/${encodeURIComponent(booking.awb)}`), booking.awb);
}

module.exports = { name: 'xpressbees', label: NAME, readiness, serviceability, book, pickup, cancel, track, chooseService, shipmentPayload, tracking };
