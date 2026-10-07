# Delivery setup: self delivery, manual courier and integrations

The application supports Manual / self delivery, Blue Dart, Shiprocket, Delhivery and
Xpressbees behind one server-side provider interface. The active provider is
selected in **Settings → Orders & delivery**. Changing that setting affects new
checkout quotes and new shipment bookings; an existing shipment always keeps
the provider and AWB with which it was created.

Carrier onboarding is required only when connecting a courier integration. The application cannot open a carrier
account, approve COD/reverse pickup, negotiate rates or create production API
credentials. Manual / self delivery needs no courier API credentials and can be
used without activating any integration.

## Deliver without an integration

In **Settings > Orders & delivery**, choose **Manual / self delivery (no
integration)**. Then choose the default manual method and save:

- **Manual courier**: book directly with any courier outside this application.
  Staff add the actual courier name, tracking ID and customer tracking link to
  the order. The application does not book the parcel or manufacture an AWB.
- **Self delivery**: the owner or their own delivery team delivers the parcel.
  No courier AWB is required. The application assigns an internal delivery
  reference, not an external courier tracking number. Customers track progress
  using the order's saved timeline.

Both choices use `shippingProvider: "manual"`; the preference is saved as
`manualDeliveryMode: "COURIER"` or `"SELF"`. Existing stores default to manual
courier. New checkout quotes retain the chosen method. Changing settings is not
a migration: it does not rewrite existing shipment methods, replace AWBs or
cancel integrated bookings. Review the method on each order before dispatch.

### Charges, COD and coverage

Fixed charges, the free-shipping offer, destination/weight rate cards and the
existing Payments & COD settings still apply. There are no live carrier rates
in manual mode. The dispatch address is optional; parcel defaults remain
available and are used by weight-based customer pricing. Existing pickup details
can remain saved for later use with an integrated courier.

Manual mode does not check a courier's serviceability API. The merchant must
confirm they can serve the customer's address before accepting/dispatching the
order. A PIN rate card changes prices; it is not a general delivery-coverage
allowlist. The COD PIN list restricts COD only, not prepaid orders.

### Day-to-day order workflow

1. Open **Admin > Orders** and review payment, address and order confirmation.
   Complete any enabled COD confirmation and packing checks as usual.
2. Record the manual delivery method and details. Courier name and a real
   tracking ID are required before courier dispatch; draft details can be saved
   while awaiting that ID. Self delivery does not need a courier AWB.
3. Optionally add an expected delivery date, a business delivery contact and a
   customer-facing note. These details are visible to the order's customer:
   use only contact details appropriate to share. Keep internal reasons in the
   separate internal/audit note field.
4. For a courier link, use a public **HTTPS** tracking page without embedded
   credentials, not a signed-in staff dashboard. A tracking link is optional.
5. Once packed, update progress in order: **Shipped > Out for Delivery >
   Delivered**, reflecting actual handover and delivery. Courier/method/tracking
   identity is locked after dispatch; link, expected date and contact/customer
   note may still be corrected while the delivery is active.
6. For a failed attempt or delay, add a delivery exception/note with a clear
   customer-facing explanation. Use the permitted in-transit/out-for-delivery
   event when delivery resumes. Returns and replacements keep their separate
   existing workflows. Do not mark an undelivered parcel Delivered to close it.
7. For COD, separately record payment only after actual cash/UPI collection.
   Marking an order Delivered never means that COD has been paid or remitted.

### Refused or undelivered parcels returning to the store

When the customer refuses an already dispatched parcel, or delivery cannot be
completed, record the customer-visible reason and mark the parcel **Returning
to store** (`RTO_IN_TRANSIT`). This is not an order cancellation: the parcel has
already left the store and cannot be treated as available stock.

Only after the store physically receives it, confirm **Returned to store**
(`RETURNED`). The order then requires the existing **RTO inspection** workflow.
Count and inspect the returned items, record their condition and choose the
appropriate disposition there. Do not mark the original order Delivered, reuse
its cancelled delivery attempt or skip inspection to close it.

Neither the returning nor received update automatically restores inventory,
collects COD or issues a refund. Stock disposition and any applicable prepaid
refund are handled through the existing RTO inspection/resolution controls,
with their own permissions and audit trail. If money was not collected on a COD
order, it must not be recorded as Paid just because the parcel returned.

Completed, cancelled and returned/RTO shipments cannot have their manual
delivery metadata silently rewritten. Recording progress does not automatically
refund money, restore inventory or verify delivery using an OTP.

**There is no automatic courier scan sync or live GPS tracking in manual/self
mode.** Staff must keep status up to date. An external tracking link lets the
customer inspect the courier's own page; it does not import events into the
store. Saving details does not call a courier, schedule a pickup or send a
driver request. Customer updates use the application's existing in-app
notifications, not a paid SMS delivery integration.

### Manual-delivery acceptance check

Use a test customer and an order with no real payment or parcel dispatch:

1. Save each manual default and reload Settings; verify the choice persists.
2. Verify fixed/weight/free delivery charges and enabled COD rules at checkout.
3. Save a manual courier's test tracking details and check the customer view.
4. Save a self-delivery order without an AWB; advance its permitted progress
   and verify the customer timeline. Confirm Delivered does not mark COD Paid.
5. Switch the store default; verify an already saved shipment keeps its method.
6. Confirm staff without shipping-management access cannot edit delivery data,
   and one customer cannot access another customer's order or delivery details.
7. Record a dispatched test parcel as returning, then confirm physical receipt.
   Verify ordinary dispatch/delivery actions are blocked, RTO inspection is
   required, and inventory/payment totals are unchanged until that inspection.

Automated configuration tests:

```text
cd backend
node --test --test-concurrency=1 tests/manualDeliverySettings.unit.test.js tests/shippingProviders.unit.test.js
```

From the repository root, UI configuration tests:

```text
npm test -- --watchAll=false --runInBand --runTestsByPath src/components/admin/DeliverySettings.test.jsx
```

Restart/redeploy the updated backend and deploy the updated frontend together.
Previously exported client ZIPs do not update themselves: deploy the changes to
those clients or generate a new package as appropriate. Keep each client's
existing database, settings, credentials and orders; no reset is needed.

### Production database prerequisite

Production delivery updates require MongoDB transactions: use MongoDB Atlas or
a properly configured replica set/sharded deployment. The application refuses
affected delivery writes with `SERVICE_UNAVAILABLE` if the production database
cannot support transactions, so order, shipment and inventory changes are not
acknowledged as successful after only a partial write. Check the database
configuration instead of disabling the production safeguard. Local development
keeps the existing standalone-MongoDB fallback; it is not the production
reliability guarantee.

## Security and activation

The remaining provider-connection instructions apply to integrated couriers,
not to Manual / self delivery.

Add credentials only to `backend/.env` locally or the backend host's secret
environment. Never use `REACT_APP_` variables for courier credentials. The
readiness endpoint returns missing variable names and capability flags, never
their values. Restart the backend after changing its environment.

Production-only providers also require their `*_LIVE_BOOKING_ENABLED=true`
switch. This prevents accidental real AWBs, pickups and charges while an account
is being configured. Delhivery sandbox can be exercised from the admin shipment
screen, but checkout deliberately refuses sandbox providers because they cannot
deliver a customer order.

## Provider environment variables

### Blue Dart

| Variable | Purpose |
| --- | --- |
| `BLUEDART_MODE` | `sandbox` or `production` |
| `BLUEDART_CLIENT_ID`, `BLUEDART_CLIENT_SECRET` | Approved gateway application credentials |
| `BLUEDART_LOGIN_ID`, `BLUEDART_LICENCE_KEY` | Shipping API profile |
| `BLUEDART_JWT_TOKEN` | Optional backend token override |
| `BLUEDART_CUSTOMER_CODE`, `BLUEDART_ORIGIN_AREA` | Registered customer and origin codes |
| `BLUEDART_PRODUCT_CODE`, `BLUEDART_PACK_TYPE`, `BLUEDART_FEATURE` | Account-approved service values |
| `BLUEDART_PICKUP_SUBPRODUCT` | Pickup subproduct, default `E-Tailing`; confirm with Blue Dart |
| `BLUEDART_TRACKING_LICENCE_KEY` | Optional separate tracking licence |
| `BLUEDART_LIVE_BOOKING_ENABLED` | Enable real production booking only after validation |
| `BLUEDART_COD_ENABLED`, `BLUEDART_REVERSE_ENABLED` | Enable only when approved for the account |
| `BLUEDART_REVERSE_FEATURE` | Account-approved reverse service feature |

Blue Dart uses direct PIN serviceability, waybill, label, pickup, cancellation
and tracking APIs. Its public contract does not provide the live rate used by
this integration, so customer pricing must use Fixed or Weight rate-card mode.
Contact and address limits are enforced before booking.

### Shiprocket

| Variable | Purpose |
| --- | --- |
| `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` | Dedicated Shiprocket API user |
| `SHIPROCKET_PICKUP_LOCATION` | Exact pickup-location name registered in Shiprocket |
| `SHIPROCKET_FALLBACK_EMAIL` | Valid merchant email used where the phone-only store has no customer email |
| `SHIPROCKET_LIVE_BOOKING_ENABLED` | Enables real order, AWB and pickup calls |
| `SHIPROCKET_COD_ENABLED`, `SHIPROCKET_REVERSE_ENABLED` | Account capability switches |
| `SHIPROCKET_COURIER_ID` | Optional fixed courier company ID |
| `SHIPROCKET_PREFERRED_COURIER` | Optional case-insensitive courier-name preference |
| `SHIPROCKET_SELECTION_STRATEGY` | `recommended` (default), `cheapest` or `fastest` |

Shiprocket is an aggregator. The application checks its live courier list for
the route and stores the actual courier name alongside the Shiprocket provider.
If no fixed/preferred courier is configured, the selection strategy is applied.

### Delhivery

| Variable | Purpose |
| --- | --- |
| `DELHIVERY_MODE` | `sandbox` or `production` |
| `DELHIVERY_TOKEN` | Delhivery API token |
| `DELHIVERY_CLIENT_NAME` | Case-sensitive client name issued by Delhivery |
| `DELHIVERY_WAREHOUSE_NAME` | Exact registered warehouse/pickup name |
| `DELHIVERY_LIVE_BOOKING_ENABLED` | Required for production booking |
| `DELHIVERY_COD_ENABLED`, `DELHIVERY_REVERSE_ENABLED` | Account capability switches |
| `DELHIVERY_SHIPPING_MODE` | Account-approved mode, default `Surface` |

Sandbox uses `staging-express.delhivery.com`; production uses
`track.delhivery.com`. Serviceability checks prepaid/COD and pickup flags. Rate
lookup failure does not make a serviceable PIN fail unless Settings uses live
carrier pricing, in which case checkout requires a valid rate.

### Xpressbees

| Variable | Purpose |
| --- | --- |
| `XPRESSBEES_EMAIL`, `XPRESSBEES_PASSWORD` | Xpressbees API user |
| `XPRESSBEES_WAREHOUSE_NAME` | Exact registered warehouse name |
| `XPRESSBEES_LIVE_BOOKING_ENABLED` | Enables real shipment creation |
| `XPRESSBEES_COD_ENABLED`, `XPRESSBEES_REVERSE_ENABLED` | Account capability switches |
| `XPRESSBEES_COURIER_ID` | Optional account courier/service ID |

Xpressbees shipment creation requests automatic pickup. A confirmed response is
therefore saved directly as Pickup Scheduled rather than showing a second pickup
button.

## Store settings and checkout

In **Settings → Orders & delivery**:

1. Choose the provider. Its card shows Ready, Disabled or Setup needed.
2. Enter the registered pickup contact/address and package defaults.
3. Choose Fixed charge, Destination/weight rate card, or Selected courier live
   rate. Live rate is available for Shiprocket, Delhivery and Xpressbees.
4. Configure the free-delivery threshold independently.

Checkout validates the destination PIN, payment mode, parcel weight/dimensions
and the selected provider before an order is confirmed. Provider contract cost
is kept on the backend; the storefront receives only the agreed customer charge,
selected service name and serviceability result. Product packed weights override
the store default. One outer parcel is currently booked per order.

## Fulfilment, tracking and returns

The order remains authoritative in the application's database. For integrated couriers, from the order's
Courier delivery panel, confirm the packed dimensions and pickup window, create
the shipment, download the original carrier label and request pickup when the
provider does not already request it automatically. AWB, carrier identifiers,
label availability, pickup confirmation and tracking events are saved with the
shipment.

Integrated-courier tracking is refreshed by the backend worker about every 15 minutes while MongoDB
is connected. Customer and admin refreshes are throttled. Confirmed production
events can move the order through Shipped, Out for Delivery and Delivered. COD
delivery never marks payment Paid; collection and remittance remain separate.

After a return is approved, reverse pickup creates a separate reverse shipment.
It does not replace the forward AWB and never auto-approves inspection, restocks
inventory, exchanges goods or refunds payment.

## Uncertain outcomes and cancellation

Write requests are not blindly retried after a timeout. An uncertain booking is
locked for reconciliation to prevent duplicate AWBs. Use **Check booking outcome**
or confirm with the carrier that no request exists before unlocking a retry.
The same rule applies to an uncertain pickup or cancellation.

Courier cancellation must be confirmed before the existing order cancellation
restores inventory or starts refund logic. A parcel already handed to a courier
must follow the return flow. Labels and cancelled AWBs remain in history.

## Provider boundary

`shippingProvider.providerFor()` selects an adapter implementing `readiness`,
`serviceability`, `book`, `pickup`, `cancel` and `track`; Blue Dart additionally
supports pickup cancellation. `deliveryService` owns persistence, locks,
reconciliation, status mapping and polling. `shippingRules` owns package and
customer-price validation. New providers can be added without changing cart,
payment or order storage.

Automated tests must use pure payload/status fixtures. They must never create a
real shipment, pickup, notification or carrier charge.

Official provider documentation:

- Blue Dart business integrations: https://api.bluedart.com/business-integrations
- Shiprocket API: https://www.postman.com/shiprocketdev/shiprocket-dev-s-public-workspace/documentation/qu05zax/shiprocket-api
- Delhivery B2C APIs: https://one.delhivery.com/developer-portal/documents/b2c/
- Xpressbees custom API: https://xb-files.s3.amazonaws.com/assets/custom_api/apidoc_v1.1.5.pdf
