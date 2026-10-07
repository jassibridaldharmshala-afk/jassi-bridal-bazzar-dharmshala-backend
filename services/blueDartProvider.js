const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { ApiError } = require('../utils/apiError');
const { pincode } = require('./shippingRules');

// Contracts: developer.dhl.com API reference, Blue Dart Waybill, Finder,
// Pickup Registration and Tracking OpenAPI specifications (2023-06).
// Hosts are fixed: neither request bodies nor store settings can redirect credentials.
const HOSTS = { sandbox: 'https://apigateway-sandbox.bluedart.com', production: 'https://apigateway.bluedart.com' };
const env = key => String(process.env[`BLUEDART_${key}`] || '').trim();
function configuration(mode = env('MODE') || 'sandbox') {
  if (!HOSTS[mode]) throw new ApiError('SHIPPING_UNAVAILABLE', 'Blue Dart environment must be sandbox or production.', { statusCode: 503 });
  return { mode, base: `${HOSTS[mode]}/in/transportation`, profile: { Api_type: 'S', LicenceKey: env('LICENCE_KEY'), LoginID: env('LOGIN_ID') }, customerCode: env('CUSTOMER_CODE'), originArea: env('ORIGIN_AREA'), productCode: env('PRODUCT_CODE'), packType: env('PACK_TYPE'), feature: env('FEATURE') };
}
function readiness() {
  const c = configuration();
  const missing = ['LICENCE_KEY', 'LOGIN_ID', 'CUSTOMER_CODE', 'ORIGIN_AREA', 'PRODUCT_CODE'].filter(key => !env(key));
  if (!env('JWT_TOKEN') && !(env('CLIENT_ID') && env('CLIENT_SECRET'))) missing.push('CLIENT_ID / CLIENT_SECRET (or JWT_TOKEN)');
  return { name: 'bluedart', label: 'Blue Dart', mode: c.mode, configured: missing.length === 0, missing,
    liveBooking: !missing.length && (c.mode === 'sandbox' || env('LIVE_BOOKING_ENABLED') === 'true'),
    trackingLookup: !missing.length, cod: env('COD_ENABLED') === 'true', reverse: env('REVERSE_ENABLED') === 'true',
    rateQuotes: false, cancelPickup: true,
    note: missing.length ? 'Complete the Blue Dart backend connection before enabling courier delivery.' : c.mode === 'sandbox' ? 'Sandbox bookings do not dispatch real parcels. Complete account testing before switching to production.' : env('LIVE_BOOKING_ENABLED') !== 'true' ? 'Production booking is disabled. Complete Blue Dart account testing, then enable live booking on the backend.' : 'Blue Dart is configured. Availability and bookings are confirmed by the carrier on each request.' };
}
function providerError(message, { ambiguous = false, statusCode = 503 } = {}) {
  const e = new ApiError('SHIPPING_UNAVAILABLE', message, { statusCode });
  e.ambiguous = ambiguous;
  return e;
}
async function transport(url, options = {}, write = false) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      if (response.status === 401) tokenCache = null;
      throw providerError([401, 403].includes(response.status) ? 'Blue Dart authentication or API access was rejected. Check the backend connection.' : 'Blue Dart could not complete this request. Please try again later.', { ambiguous: write && response.status >= 500 });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw providerError('Blue Dart returned a response that is too large.', { ambiguous: write });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw providerError('Blue Dart could not be reached. Please try again later.', { ambiguous: write });
  }
}
let tokenCache = null;
let tokenPending = null;
async function token(c) {
  if (env('JWT_TOKEN')) return env('JWT_TOKEN');
  const key = `${c.mode}:${env('CLIENT_ID')}:${env('CLIENT_SECRET')}`;
  if (tokenCache?.key === key && tokenCache.until > Date.now()) return tokenCache.value;
  if (tokenPending?.key === key) return tokenPending.promise;
  const promise = (async () => {
    const raw = await transport(`${c.base}/token/v1/login`, { method: 'GET', headers: { ClientID: env('CLIENT_ID'), clientSecret: env('CLIENT_SECRET') } });
    let body;
    try { body = JSON.parse(raw); } catch { throw providerError('Blue Dart authentication returned an unreadable response.'); }
    const value = body.JWTToken;
    if (typeof value !== 'string' || !value || body.IsError === true) throw providerError('Blue Dart did not issue an access token. Verify the account credentials.');
    let expiry = Date.now() + 10 * 60000;
    try { const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url')); if (payload.exp) expiry = Number(payload.exp) * 1000 - 60000; } catch { /* Opaque carrier tokens use a short cache. */ }
    tokenCache = { key, value, until: Math.min(expiry, Date.now() + 10 * 60000) };
    return value;
  })();
  tokenPending = { key, promise };
  try { return await promise; } finally { if (tokenPending?.promise === promise) tokenPending = null; }
}
async function call(c, path, payload, write = false) {
  const raw = await transport(`${c.base}/${path}`, { method: 'POST', headers: { JWTToken: await token(c), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, write);
  try { return JSON.parse(raw); } catch { throw providerError('Blue Dart returned an unreadable response.', { ambiguous: write }); }
}
function result(body, key, write = false) {
  const r = body?.[key];
  if (!r || typeof r.IsError !== 'boolean') throw providerError('Blue Dart did not confirm the request outcome.', { ambiguous: write });
  if (r.IsError) {
    // Only expose constrained error identifiers, never raw provider messages or payloads.
    const codes = (r.Status || []).map(row => String(row.StatusCode || '')).filter(code => /^[a-z\d_-]{1,60}$/i.test(code)).slice(0, 3).join(', ');
    throw providerError(`Blue Dart rejected the request${codes ? ` (${codes})` : ''}. Check shipment details or contact your account manager.`, { statusCode: 400 });
  }
  return r;
}
function service(c, cod = false, reverse = false) {
  if (cod && env('COD_ENABLED') !== 'true') throw new ApiError('SHIPPING_COD_UNAVAILABLE', 'Cash on delivery is unavailable for this delivery account. Choose an online payment method.');
  if (reverse && env('REVERSE_ENABLED') !== 'true') throw new ApiError('SHIPPING_REVERSE_UNAVAILABLE', 'Reverse pickup is not enabled for this Blue Dart account. Arrange the return with your account manager.');
  return { productCode: c.productCode, subProductCode: cod ? 'C' : 'P', packType: c.packType, feature: reverse ? (env('REVERSE_FEATURE') || 'R') : c.feature };
}
async function checkLocation(c, pin, s, kind) {
  const body = await call(c, 'finder/v1/GetServicesforPincodeAndProduct', { pinCode: pincode(pin), ProductCode: s.productCode, SubProductCode: s.subProductCode, PackType: s.packType, Feature: s.feature, profile: c.profile });
  const r = body?.GetServicesforPincodeAndProductResult;
  if (!r || typeof r.IsError !== 'boolean' || String(r.PinCode) !== String(pin)) throw providerError('Blue Dart serviceability could not be verified. Please try again.');
  if (r.IsError && !/invalidpincode|not.?serviceable|no.?service/i.test(r.ErrorMessage || '')) throw providerError('Blue Dart could not verify this location. Please try again.');
  const flag = String(r[kind === 'pickup' ? 'PickupService' : 'DeliveryService'] || '').trim();
  if (!r.IsError && !/^(yes|no)$/i.test(flag)) throw providerError('Blue Dart serviceability could not be verified. Please try again.');
  const available = !r.IsError && /^yes$/i.test(flag);
  return { available, areaCode: String(r[kind === 'pickup' ? 'PickupAreaCode' : 'DeliveryAreaCode'] || ''), serviceName: String(r.ServiceName || '') };
}
async function serviceability({ origin, destination, cod = false, reverse = false, mode }) {
  const c = configuration(mode);
  const s = service(c, cod, reverse);
  const [pickup, delivery] = await Promise.all([checkLocation(c, origin.pincode, s, 'pickup'), checkLocation(c, destination.pincode, s, 'delivery')]);
  if (!pickup.available) throw new ApiError('SHIPPING_NOT_SERVICEABLE', reverse ? 'Blue Dart reverse pickup is unavailable at this customer PIN code.' : 'Pickup is currently unavailable at the store location. Please contact the store.');
  if (!delivery.available) throw new ApiError(cod ? 'SHIPPING_COD_UNAVAILABLE' : 'SHIPPING_NOT_SERVICEABLE', cod ? 'Blue Dart COD is unavailable at this PIN code. Try an online payment method.' : 'Blue Dart delivery is currently unavailable at this PIN code. Please choose another address.');
  return { provider: 'bluedart', mode: c.mode, serviceable: true, checkedAt: new Date(), service: s, pickupArea: pickup.areaCode, serviceName: delivery.serviceName };
}
function addressLines(address) {
  const text = [address.houseNo || address.houseNumber, address.area, address.landmark, address.city, address.state].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 90) throw new ApiError('SHIPPING_VALIDATION', 'Blue Dart needs a complete address of at most 90 characters across three lines. Shorten the address before booking.');
  return [text.slice(0, 30), text.slice(30, 60), text.slice(60, 90)];
}
function waybillPayload(c, booking, order, slot, reverse) {
  const origin = booking.pickupAddress, destination = booking.destination;
  const from = addressLines(origin), to = addressLines(destination);
  if (String(destination.fullName || '').length > 30 || String(origin.fullName || '').length > 30) throw new ApiError('SHIPPING_VALIDATION', 'Blue Dart pickup and recipient names must be 30 characters or fewer.');
  const p = booking.parcel, s = booking.service;
  const cod = !reverse && order.paymentMethod === 'COD' && order.paymentStatus !== 'Paid';
  return { Request: {
    Consignee: { ConsigneeName: destination.fullName, ConsigneeMobile: destination.mobile || destination.phone, ConsigneePincode: pincode(destination.pincode), ConsigneeAddress1: to[0], ConsigneeAddress2: to[1], ConsigneeAddress3: to[2], ConsigneeAddressType: 'R' },
    Shipper: { CustomerName: origin.fullName, CustomerMobile: origin.mobile, CustomerCode: c.customerCode, CustomerPincode: pincode(origin.pincode), CustomerAddress1: from[0], CustomerAddress2: from[1], CustomerAddress3: from[2], OriginArea: booking.pickup.areaCode || c.originArea, IsToPayCustomer: false, Sender: origin.fullName.slice(0, 20) },
    Services: { ProductCode: s.productCode, SubProductCode: cod ? 'C' : 'P', ProductType: 1, PackType: s.packType || '', PieceCount: '1', ActualWeight: String(p.weightKg), Dimensions: [{ Length: p.lengthCm, Breadth: p.widthCm, Height: p.heightCm, Count: 1 }], DeclaredValue: Number(order.finalAmount), CollactableAmount: cod ? Number(order.finalAmount) : 0, CreditReferenceNo: booking.providerRef, PickupDate: `/Date(${slot.at.getTime()})/`, PickupTime: slot.time.replace(':', ''), PDFOutputNotRequired: false, RegisterPickup: false, IsReversePickup: !!reverse, ...(reverse ? { ForwardAWBNo: order.shipment?.awb || '', ForwardLogisticCompName: order.shipment?.courierName || '' } : {}) },
  }, Profile: c.profile };
}
async function book({ booking, order, slot, reverse }) {
  const c = configuration(booking.environment);
  if (!readiness().liveBooking || (c.mode === 'production' && env('LIVE_BOOKING_ENABLED') !== 'true')) throw providerError('Live Blue Dart booking is disabled. Complete the backend account setup first.');
  const payload = waybillPayload(c, booking, order, slot, reverse);
  const r = result(await call(c, 'waybill/v1/GenerateWayBill', payload, true), 'GenerateWayBillResult', true);
  if (!/^\d{8,15}$/.test(String(r.AWBNo || ''))) throw providerError('Blue Dart accepted the request without a readable AWB. Reconcile the booking before retrying.', { ambiguous: true });
  const pdf = Array.isArray(r.AWBPrintContent) ? Buffer.from(r.AWBPrintContent) : typeof r.AWBPrintContent === 'string' ? Buffer.from(r.AWBPrintContent, 'base64') : null;
  return { awb: String(r.AWBNo), labelPdf: pdf?.subarray(0, 5).toString() === '%PDF-' ? pdf : undefined, providerCharge: Number.isFinite(r.TransactionAmount) ? r.TransactionAmount : undefined };
}
async function pickup({ booking, slot, reverse }) {
  const c = configuration(booking.environment), p = booking.pickupAddress, lines = addressLines(p);
  const r = result(await call(c, 'pickup/v1/RegisterPickup', { request: { AWBNo: [booking.awb], AreaCode: booking.pickup.areaCode || c.originArea, CustomerCode: c.customerCode, CustomerName: p.fullName, ContactPersonName: p.fullName, CustomerPincode: p.pincode, CustomerAddress1: lines[0], CustomerAddress2: lines[1], CustomerAddress3: lines[2], CustomerTelephoneNumber: p.mobile, MobileTelNo: p.mobile, NumberofPieces: 1, DoxNDox: '2', ProductCode: booking.service.productCode, PackType: booking.service.packType || '', SubProducts: [env('PICKUP_SUBPRODUCT') || 'E-Tailing'], ShipmentPickupDate: `/Date(${slot.at.getTime()})/`, ShipmentPickupTime: slot.time, OfficeCloseTime: slot.closeTime, WeightofShipment: booking.parcel.weightKg, VolumeWeight: booking.parcel.volumetricWeightKg, IsReversePickup: !!reverse, IsForcePickup: false, isToPayShipper: false, ReferenceNo: booking.providerRef }, profile: c.profile }, true), 'RegisterPickupResult', true);
  if (!r.TokenNumber) throw providerError('Blue Dart did not return a pickup confirmation. Reconcile the pickup before retrying.', { ambiguous: true });
  return { token: String(r.TokenNumber), date: slot.date, time: slot.time, closeTime: slot.closeTime };
}
async function cancel({ booking }) {
  const c = configuration(booking.environment);
  result(await call(c, 'waybill/v1/CancelWaybill', { Request: { AWBNo: booking.awb }, Profile: c.profile }, true), 'CancelWaybillResult', true);
}
async function cancelPickup({ booking }) {
  const c = configuration(booking.environment);
  const date = new Date(`${booking.pickup.date}T00:00:00+05:30`);
  if (!Number.isFinite(date.getTime()) || !/^\d{1,8}$/.test(booking.pickup.token || '')) throw new ApiError('SHIPPING_VALIDATION', 'The pickup token or date must be confirmed with Blue Dart before cancellation.');
  result(await call(c, 'cancel-pickup/v1/CancelPickup', { request: { TokenNumber: Number(booking.pickup.token), PickupRegistrationDate: `/Date(${date.getTime()})/`, Remarks: 'Order cancelled by merchant' }, profile: c.profile }, true), 'CancelPickupResult', true);
}
function carrierDate(date, time = '00:00') {
  const m = String(date || '').match(/^(\d{1,2})[- ]([A-Za-z]+)[- ](\d{4})$/);
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[2].slice(0, 3).toLowerCase());
  const t = String(time).replace(/^(\d{2})(\d{2})$/, '$1:$2');
  if (month < 0 || !/^\d{2}:\d{2}$/.test(t)) return null;
  const d = new Date(`${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T${t}:00+05:30`);
  return Number.isFinite(d.getTime()) ? d : null;
}
function statusOf(text, code, type) {
  const s = String(text || '').trim().toUpperCase();
  if (/RETURNED TO (ORIGIN|SHIPPER)|RTO DELIVERED/.test(s)) return 'RETURNED';
  if (/RETURN TO ORIGIN|RETURNING TO (ORIGIN|SHIPPER)|RTO/.test(s)) return 'RTO_IN_TRANSIT';
  if (/CANCELLED|CANCELED/.test(s)) return 'CANCELLED';
  if (/NOT DELIVERED|UNDELIVERED|ATTEMPT|REFUSED|INCORRECT|DELAY|HELD|DAMAGED|LOST|PROBLEM/.test(s)) return 'EXCEPTION';
  if (code === '000' || type === 'DL' || /^SHIPMENT DELIVERED$/.test(s)) return 'DELIVERED';
  if (code === '002' || /OUT FOR DELIVERY/.test(s)) return 'OUT_FOR_DELIVERY';
  if (code === '015' || /SHIPMENT PICKED UP/.test(s)) return 'PICKED_UP';
  if (/PICKUP.*REGISTERED|PICKUP.*SCHEDULED|OUT TO P\/U/.test(s)) return 'PICKUP_SCHEDULED';
  if (/ARRIVED|CONNECTED|DEPARTED|IN TRANSIT|DISPATCHED/.test(s)) return 'IN_TRANSIT';
  return null; // Unknown scans are displayed, never guessed as delivered.
}
function parseTracking(xml, expected, reference = false) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw providerError('Blue Dart tracking returned unreadable data.');
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(xml);
  const rows = [].concat(data?.ShipmentData?.Shipment || []);
  const row = rows.find(r => String(r[reference ? '@_RefNo' : '@_WaybillNo']) === expected);
  if (!row || !/^\d{8,15}$/.test(String(row['@_WaybillNo'] || ''))) throw providerError('Blue Dart has no confirmed tracking record yet. Please check again after pickup.');
  const events = [].concat(row.Scans?.ScanDetail || []).map(scan => ({ status: statusOf(scan.Scan, scan.ScanCode, scan.ScanType) || 'UPDATE', note: [scan.Scan, scan.ScannedLocation].filter(Boolean).join(' · ').slice(0, 500), date: carrierDate(scan.ScanDate, scan.ScanTime) })).filter(e => e.date).sort((a, b) => a.date - b.date);
  return { awb: String(row['@_WaybillNo']), providerStatus: String(row.Status || '').slice(0, 250), status: statusOf(row.Status, '', row.StatusType), providerStatusAt: carrierDate(row.StatusDate, row.StatusTime), expectedDeliveryAt: carrierDate(row.ExpectedDeliveryDate), events };
}
async function track({ booking, byReference = false }) {
  const c = configuration(booking.environment);
  const identifier = byReference ? booking.providerRef : booking.awb;
  const query = new URLSearchParams({ handler: 'tnt', action: 'custawbquery', loginid: c.profile.LoginID, lickey: env('TRACKING_LICENCE_KEY') || c.profile.LicenceKey, awb: byReference ? 'Ref' : 'awb', numbers: identifier, format: 'xml', verno: '1', scan: '1' });
  const xml = await transport(`${c.base}/tracking/v1/shipment?${query}`, { headers: { JWTToken: await token(c) } });
  return parseTracking(xml, identifier, byReference);
}
module.exports = { name: 'bluedart', label: 'Blue Dart', readiness, configuration, serviceability, book, pickup, cancel, cancelPickup, track, parseTracking, statusOf, carrierDate, waybillPayload, addressLines };
