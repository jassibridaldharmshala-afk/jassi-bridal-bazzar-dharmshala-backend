const { ApiError } = require('../utils/apiError');
const { pincode } = require('./shippingRules');
const { dateValue, downloadPdf, providerEnv: readEnv, providerError, request, requestJson, safeText, statusFromText } = require('./courierProviderUtils');

const NAME = 'Delhivery';
const HOSTS = { sandbox: 'https://staging-express.delhivery.com', production: 'https://track.delhivery.com' };
const env = key => readEnv('DELHIVERY', key);

function configuration() {
  const mode = env('MODE') || 'sandbox';
  if (!HOSTS[mode]) throw providerError(NAME, 'DELHIVERY_MODE must be sandbox or production.');
  return { mode, base: HOSTS[mode], token: env('TOKEN'), client: env('CLIENT_NAME'), warehouse: env('WAREHOUSE_NAME') };
}

function readiness() {
  const config = configuration();
  const missing = [['TOKEN', config.token], ['CLIENT_NAME', config.client], ['WAREHOUSE_NAME', config.warehouse]].filter(([, value]) => !value).map(([key]) => key);
  const enabled = config.mode === 'sandbox' || env('LIVE_BOOKING_ENABLED') === 'true';
  return {
    name: 'delhivery', label: NAME, mode: config.mode, configured: missing.length === 0, missing,
    liveBooking: !missing.length && enabled, trackingLookup: !missing.length,
    cod: env('COD_ENABLED') === 'true', reverse: env('REVERSE_ENABLED') === 'true', rateQuotes: true, cancelPickup: false,
    note: missing.length ? 'Complete the Delhivery API token, case-sensitive client name and registered warehouse on the backend.' : config.mode === 'sandbox' ? 'Delhivery sandbox is connected. Test shipments never dispatch real parcels.' : !enabled ? 'Delhivery production is connected but live booking is disabled.' : 'Delhivery production booking is ready. Serviceability is checked before every order.',
  };
}

function headers(json = true) {
  const config = configuration();
  return { Authorization: `Token ${config.token}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function json(path, options = {}, write = false) {
  const config = configuration();
  return requestJson(NAME, `${config.base}${path}`, { ...options, headers: { ...headers(options.body !== undefined), ...(options.headers || {}) } }, write);
}

function postalCode(body, expected) {
  const rows = body?.delivery_codes;
  const row = Array.isArray(rows) ? rows.map(value => value?.postal_code || value).find(value => String(value?.pin) === String(expected)) : null;
  return row || null;
}

async function rate(origin, destination, cod, parcel) {
  const query = new URLSearchParams({ md: 'S', ss: 'Delivered', d_pin: destination, o_pin: origin, cgm: String(Math.ceil(Number(parcel?.chargeableWeightKg || parcel?.weightKg || 0.5) * 1000)), pt: cod ? 'COD' : 'Pre-paid' });
  try {
    const body = await json(`/api/kinko/v1/invoice/charges/.json?${query}`);
    const row = Array.isArray(body) ? body[0] : body;
    const amount = Number(row?.total_amount ?? row?.total_charge ?? row?.gross_amount ?? row?.charge);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : undefined;
  } catch { return undefined; }
}

async function serviceability({ origin, destination, cod = false, reverse = false, parcel }) {
  if (cod && env('COD_ENABLED') !== 'true') throw new ApiError('SHIPPING_COD_UNAVAILABLE', 'Cash on Delivery is not enabled for this Delhivery account. Choose online payment.');
  if (reverse && env('REVERSE_ENABLED') !== 'true') throw new ApiError('SHIPPING_REVERSE_UNAVAILABLE', 'Reverse pickup is not enabled for this Delhivery account.');
  const originPin = pincode(origin.pincode), destinationPin = pincode(destination.pincode);
  const [originBody, destinationBody] = await Promise.all([
    json(`/c/api/pin-codes/json/?filter_codes=${originPin}`),
    json(`/c/api/pin-codes/json/?filter_codes=${destinationPin}`),
  ]);
  const from = postalCode(originBody, originPin), to = postalCode(destinationBody, destinationPin);
  const pickup = reverse ? /Y/i.test(String(from?.pickup || from?.repl || '')) : /Y/i.test(String(from?.pickup || ''));
  const delivery = reverse ? /Y/i.test(String(to?.repl || to?.pre_paid || '')) : /Y/i.test(String(cod ? (to?.cash || to?.cod) : to?.pre_paid));
  if (!pickup) throw new ApiError('SHIPPING_NOT_SERVICEABLE', reverse ? 'Delhivery reverse pickup is unavailable at this customer PIN code.' : 'Delhivery pickup is unavailable at the store PIN code.');
  if (!delivery) throw new ApiError(cod ? 'SHIPPING_COD_UNAVAILABLE' : 'SHIPPING_NOT_SERVICEABLE', cod ? 'Delhivery COD is unavailable at this PIN code. Choose online payment.' : 'Delhivery delivery is unavailable at this PIN code. Choose another address.');
  const providerRate = await rate(originPin, destinationPin, cod, parcel);
  return { provider: 'delhivery', mode: configuration().mode, serviceable: true, checkedAt: new Date(), courierName: NAME, serviceName: safeText(to?.center || to?.inc || 'Surface', 100), service: { mode: env('SHIPPING_MODE') || 'Surface' }, ...(providerRate === undefined ? {} : { providerRate }) };
}

function addressText(value = {}) { return safeText([value.houseNo || value.houseNumber, value.area, value.landmark].filter(Boolean).join(', '), 200); }
function itemDescription(order) { return safeText(order.orderItems.map(item => `${item.name || item.productName} x${item.quantity || 1}`).join(', '), 300); }
function phone(value) { return String(value || '').replace(/\D/g, '').slice(-10); }

function shipmentPayload(booking, order, reverse) {
  const config = configuration(), destination = reverse ? booking.pickupAddress : booking.destination, origin = reverse ? booking.destination : booking.pickupAddress, parcel = booking.parcel;
  const amount = Math.max(0, Number(order.finalAmount || 0));
  const quantity = order.orderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return {
    format: 'json',
    data: {
      pickup_location: { name: config.warehouse },
      shipments: [{
        name: safeText(destination.fullName, 100), add: addressText(destination), pin: pincode(destination.pincode), city: safeText(destination.city, 100), state: safeText(destination.state, 100), country: 'India', phone: phone(destination.mobile || destination.phone),
        order: booking.providerRef, payment_mode: reverse ? 'Pickup' : order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid' ? 'COD' : 'Prepaid', cod_amount: reverse || order.paymentMethod !== 'COD' || order.paymentStatus === 'Paid' ? 0 : amount,
        order_date: new Date().toISOString().slice(0, 10), total_amount: amount, products_desc: itemDescription(order), quantity: Math.max(1, quantity), seller_name: safeText(origin.fullName, 100), seller_add: addressText(origin), seller_inv: safeText(order.invoiceNumber, 50),
        return_name: safeText(origin.fullName, 100), return_add: addressText(origin), return_city: safeText(origin.city, 100), return_state: safeText(origin.state, 100), return_country: 'India', return_pin: pincode(origin.pincode), return_phone: phone(origin.mobile || origin.phone),
        shipment_width: parcel.widthCm, shipment_height: parcel.heightCm, shipment_length: parcel.lengthCm, weight: Math.ceil(parcel.weightKg * 1000), shipping_mode: booking.service?.mode || env('SHIPPING_MODE') || 'Surface', waybill: '', client: config.client,
      }],
    },
  };
}

async function labelFor(awb) {
  try {
    const config = configuration();
    const { buffer } = await request(NAME, `${config.base}/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=True`, { headers: headers(false) }, { limit: 8 * 1024 * 1024 });
    if (buffer.subarray(0, 5).toString() === '%PDF-') return buffer;
    const body = JSON.parse(buffer.toString('utf8'));
    const url = body.pdf_download_link || body.packages?.[0]?.pdf_download_link || body.packages?.[0]?.pdf;
    return url ? await downloadPdf(NAME, url) : undefined;
  } catch { return undefined; }
}

async function book({ booking, order, reverse }) {
  if (!readiness().liveBooking) throw providerError(NAME, readiness().note);
  const payload = shipmentPayload(booking, order, reverse);
  const form = new URLSearchParams({ format: 'json', data: JSON.stringify(payload.data) });
  const body = await json('/api/cmu/create.json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, true);
  const row = Array.isArray(body?.packages) ? body.packages[0] : null;
  const awb = safeText(row?.waybill || row?.wbill || body?.waybill, 30);
  const failed = body?.success === false || row?.status === 'Fail' || row?.status === 'Failed';
  if (failed) throw providerError(NAME, 'shipment creation was rejected. Verify the address, warehouse and account services.', { statusCode: 400 });
  if (!/^[A-Za-z0-9-]{6,30}$/.test(awb)) throw providerError(NAME, 'shipment creation was not confirmed with an AWB. Reconcile before retrying.', { ambiguous: true });
  return { awb, providerOrderId: booking.providerRef, courierName: NAME, labelPdf: await labelFor(awb) };
}

async function pickup({ booking, slot, reverse }) {
  if (reverse) return { token: booking.awb, date: slot.date, time: slot.time, closeTime: slot.closeTime, automatic: true };
  const body = await json('/fm/request/new/', { method: 'POST', body: JSON.stringify({ pickup_time: slot.time, pickup_date: slot.date, pickup_location: configuration().warehouse, expected_package_count: 1 }) }, true);
  const token = body.pickup_id || body.pr_number || body.pickup_request_id || body.data?.pickup_id;
  if (!token && body.success !== true) throw providerError(NAME, 'pickup was not confirmed. Check the Delhivery One panel before retrying.', { ambiguous: true });
  return { token: String(token || `${configuration().warehouse}-${slot.date}`), date: slot.date, time: slot.time, closeTime: slot.closeTime };
}

async function cancel({ booking }) {
  await json('/api/p/edit', { method: 'POST', body: JSON.stringify({ waybill: booking.awb, cancellation: 'true' }) }, true);
}

function tracking(body, expectedAwb = '') {
  const row = (Array.isArray(body?.ShipmentData) ? body.ShipmentData : body?.ShipmentData?.Shipment ? [body.ShipmentData.Shipment] : []).map(item => item?.Shipment || item).find(Boolean) || body?.Shipment || {};
  const latest = row.Status || {};
  const scans = Array.isArray(row.Scans) ? row.Scans : row.Scans?.ScanDetail ? [row.Scans.ScanDetail] : [];
  const current = safeText(latest.Status || row.Status || row.CurrentStatus, 250);
  const events = scans.map(value => value?.ScanDetail || value).map(scan => ({ status: statusFromText(scan.Scan || scan.Instructions || scan.Status) || 'UPDATE', note: safeText([scan.Scan || scan.Instructions, scan.ScannedLocation || scan.StatusLocation].filter(Boolean).join(' · '), 500), date: dateValue(scan.ScanDateTime || scan.StatusDateTime || scan.ScanDate) })).filter(event => event.date);
  const awb = safeText(row.AWB || row.Waybill || expectedAwb, 30);
  if (!awb) throw providerError(NAME, 'tracking has no confirmed AWB yet.');
  return { awb, providerStatus: current, status: statusFromText(current), providerStatusAt: dateValue(latest.StatusDateTime || row.StatusDateTime || events.at(-1)?.date), expectedDeliveryAt: dateValue(row.ExpectedDeliveryDate), events };
}

async function track({ booking, byReference = false }) {
  const query = new URLSearchParams(byReference ? { ref_ids: booking.providerRef } : { waybill: booking.awb });
  return tracking(await json(`/api/v1/packages/json/?${query}`), booking.awb);
}

module.exports = { name: 'delhivery', label: NAME, readiness, serviceability, book, pickup, cancel, track, postalCode, shipmentPayload, tracking };
