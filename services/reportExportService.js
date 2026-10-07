const { SECTIONS, generateSection } = require('./reportingService');

function cell(value) {
  const text = String(value ?? '');
  return `"${(/^\s*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

function objectRows(title, rows, columns) {
  const output = [[], [title], columns.map(([label]) => label)];
  (rows || []).forEach((row) => output.push(columns.map(([, key]) => row?.[key] ?? '')));
  return output;
}

function reportRows(bundle) {
  const first = Object.values(bundle.sections || {})[0] || {};
  const rows = [
    ['Reports & Insights Center'],
    ['Store', bundle.storeName || 'All managed stores'],
    ['Period', `${first.range?.fromDate || ''} to ${first.range?.toDate || ''}`],
    ['Timezone', first.timezone || 'Asia/Kolkata'],
    ['Filters', JSON.stringify(first.filters || {})],
    ['Currency', first.currency || 'INR'],
    ['Generated at', bundle.generatedAt || ''],
  ];
  const summary = bundle.sections?.summary?.data;
  if (summary) {
    rows.push([], ['Financial reconciliation'], ['Metric', 'Current', 'Previous', 'Change %']);
    const labels = { grossSales: 'Gross MRP', discounts: 'Total discounts', bookedValue: 'Booked order value', paymentCollected: 'Payments collected', refunds: 'Refunds recorded', netCollected: 'Net collected', recognizedRevenue: 'Recognized paid revenue', orders: 'Valid orders', paidOrders: 'Paid orders', units: 'Units ordered', averageOrderValue: 'Average order value', customers: 'Buying customers', estimatedProfit: 'Estimated merchandise profit' };
    Object.entries(labels).forEach(([key, label]) => rows.push([label, summary.metrics?.[key]?.value ?? '', summary.metrics?.[key]?.previous ?? '', summary.metrics?.[key]?.delta ?? '']));
    rows.push(...objectRows('Daily / monthly trend', summary.series, [['Date', 'key'], ['Orders', 'orders'], ['Revenue', 'revenue'], ['Refunds', 'refunds'], ['Net', 'net']]));
  }
  const products = bundle.sections?.products?.data;
  if (products) {
    rows.push(...objectRows('Inventory position', [products.inventory], [['Catalog products', 'products'], ['Active products', 'active'], ['Available units', 'units'], ['Retail value', 'valueAtRetail'], ['Cost value', 'valueAtCost'], ['Low stock', 'lowStock'], ['Out of stock', 'outOfStock'], ['Aged products', 'agedProducts'], ['Aged units', 'agedUnits']]));
    rows.push(...objectRows('Product performance', products.items, [['Product', 'name'], ['SKU', 'sku'], ['Category', 'category'], ['Gross units', 'units'], ['Net units', 'netUnits'], ['Refunded units', 'refundedUnits'], ['Orders', 'orders'], ['Gross item value', 'grossItemRevenue'], ['Allocated discounts', 'allocatedDiscount'], ['Allocated refunds', 'allocatedRefund'], ['Net item value', 'itemRevenue'], ['Estimated profit', 'estimatedProfit'], ['Margin %', 'estimatedMargin'], ['Returned units', 'returnedUnits'], ['Return rate %', 'returnRate']]));
    rows.push(...objectRows('Slow-moving inventory', products.slowMoving, [['Product', 'name'], ['SKU', 'sku'], ['Available units', 'available'], ['Retail price', 'price'], ['Last inventory change', 'lastInventoryChangeAt']]));
    rows.push(...objectRows('Stockout exposure', products.stockoutExposure, [['Product', 'name'], ['SKU', 'sku'], ['Product views while sold out', 'views']]));
  }
  const customers = bundle.sections?.customers?.data;
  if (customers) {
    rows.push(...objectRows('Customer summary', [customers.summary], [['Buying customers', 'buyingCustomers'], ['New customers', 'newCustomers'], ['Returning customers', 'returningCustomers'], ['Repeat rate %', 'repeatRate'], ['Average customer value', 'averageCustomerValue']]));
    rows.push(...objectRows('Top customers', customers.topCustomers, [['Customer', 'name'], ['Type', 'type'], ['Period orders', 'orders'], ['Period units', 'units'], ['Period net spend', 'netSpend'], ['Average order value', 'averageOrderValue'], ['Lifetime orders', 'lifetimeOrders'], ['Lifetime value', 'lifetimeValue'], ['Last order', 'lastOrderAt']]));
    rows.push(...objectRows('Customer locations', customers.locations, [['City', 'city'], ['State', 'state'], ['PIN code', 'pincode'], ['Customers', 'customers'], ['Orders', 'orders'], ['Net revenue', 'revenue']]));
  }
  const marketing = bundle.sections?.marketing?.data;
  if (marketing) {
    rows.push(...objectRows('Storefront funnel', marketing.funnel, [['Step', 'name'], ['Events', 'value'], ['Conversion from prior step %', 'rateFromPrevious']]));
    rows.push(...objectRows('Traffic sources', marketing.sources, [['Source', 'source'], ['Events', 'events'], ['Sessions', 'sessions']]));
    rows.push(...objectRows('Marketing attribution', marketing.attribution, [['Source', 'source'], ['Campaign', 'campaign'], ['Reel', 'reelId'], ['Orders', 'orders'], ['Customers', 'customers'], ['Revenue', 'revenue']]));
    rows.push(...objectRows('Coupon performance', marketing.coupons, [['Coupon', 'code'], ['Orders', 'orders'], ['Customers', 'customers'], ['Discount', 'discount'], ['Revenue', 'revenue'], ['Revenue / discount', 'returnOnDiscount']]));
    rows.push(...objectRows('Banner performance', marketing.banners, [['Banner', 'bannerId'], ['Campaign', 'campaign'], ['Impressions', 'impressions'], ['Clicks', 'clicks'], ['CTR %', 'ctr']]));
  }
  const fulfillment = bundle.sections?.fulfillment?.data;
  const traffic = bundle.sections?.traffic?.data;
  if (traffic) {
    rows.push([], ['Traffic & visitors (estimated browser identities)'], ['Metric', 'Current', 'Previous', 'Change %']);
    Object.entries(traffic.metrics || {}).forEach(([key, value]) => rows.push([key, value.value, value.previous, value.delta ?? '']));
    rows.push(['Active visitors (last 5 minutes)', traffic.activeVisitors], ['Collection state', traffic.health?.state], ['Traffic timezone', traffic.timezone], ['Details available from', traffic.retention?.rawAvailableFrom], ['Conversion definition', traffic.funnel?.note]);
    rows.push(...objectRows('Traffic trend', traffic.series, [['Period', 'key'], ['Visitors', 'visitors'], ['Visits', 'sessions'], ['Page views', 'pageViews']]));
    for (const key of ['sources', 'firstSources', 'campaigns', 'devices', 'browsers', 'operatingSystems']) rows.push(...objectRows(key, traffic[key], [['Label', 'label'], ['Visitors', 'visitors'], ['Visits', 'sessions'], ['Page views', 'pageViews']]));
    rows.push(...objectRows('Verified traffic funnel', traffic.funnel?.steps, [['Step', 'label'], ['Visits', 'value'], ['Rate from previous %', 'rate']]));
    for (const [key, items] of Object.entries(traffic.details || {})) rows.push(...objectRows(key, items, [['Label', 'label'], ['Count', 'value']]));
    rows.push(...objectRows('All-store order cohort (not limited to tracked visitors)', [traffic.commerce], [['Orders placed', 'ordersPlaced'], ['COD placed', 'codPlaced'], ['Online paid', 'onlinePaid'], ['COD collected', 'codCollected'], ['Cancelled', 'cancelled'], ['Refunds', 'refunds']]));
  }
  if (fulfillment) {
    rows.push(...objectRows('Shipping and returns summary', [fulfillment.summary], [['Orders', 'orders'], ['Shipments', 'shipments'], ['Waiting for shipment', 'waitingForShipment'], ['Delayed', 'delayed'], ['Delivered', 'delivered'], ['RTO', 'rto'], ['Exceptions', 'exceptions'], ['Average delivery hours', 'averageDeliveryHours'], ['Shipping collected', 'shippingCollected'], ['Carrier cost', 'carrierCost'], ['COD outstanding orders', 'codOutstandingOrders'], ['COD outstanding amount', 'codOutstandingAmount'], ['Return requests', 'returnRequests'], ['Returns', 'returns'], ['Exchanges', 'exchanges'], ['Refunded', 'refunded'], ['Refunds pending', 'refundPending'], ['Overdue returns', 'overdueReturns'], ['Average resolution hours', 'averageResolutionHours']]));
    rows.push(...objectRows('Courier performance', fulfillment.providers, [['Provider', 'provider'], ['Shipments', 'shipments'], ['Delivered', 'delivered'], ['Delivery rate %', 'deliveryRate'], ['RTO', 'rto'], ['RTO rate %', 'rtoRate'], ['Exceptions', 'exceptions'], ['Carrier charge', 'charge']]));
    rows.push(...objectRows('Shipment statuses', fulfillment.shipmentStatuses, [['Status', 'label'], ['Shipments', 'value']]));
    rows.push(...objectRows('Return statuses', fulfillment.returnStatuses, [['Status', 'label'], ['Requests', 'value']]));
  }
  return rows;
}

function buildReportCsv(bundle) {
  return `\uFEFF${reportRows(bundle).map((row) => row.map(cell).join(',')).join('\r\n')}`;
}

async function generateBundle(context, sections = SECTIONS) {
  const safeSections = [...new Set((sections || SECTIONS).filter((section) => SECTIONS.includes(section)))];
  const entries = await Promise.all(safeSections.map(async (section) => [section, await generateSection(section, context)]));
  return { generatedAt: new Date(), storeName: context.store?.name || 'All managed stores', sections: Object.fromEntries(entries) };
}

module.exports = { buildReportCsv, generateBundle, reportRows };
