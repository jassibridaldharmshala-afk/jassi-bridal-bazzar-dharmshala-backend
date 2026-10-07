// Preview-only deterministic assistants. No provider calls or database writes.
const WORKFLOWS = {
  category: 'catalog.write', banner: 'marketing.write', campaign: 'marketing.write',
  website: 'design.write', coupon: 'marketing.write', shipment: 'orders.write',
  purchase: 'inventory.write', support: 'orders.read', returns: 'returns.read',
  store: 'settings.write', catalog: 'catalog.write',
};
const CONTENT_FIELDS = ['shortDescription', 'description', 'tags', 'metaTitle', 'metaDescription', 'metaKeywords'];
const text = (value, max = 500) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
const slug = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const unique = values => [...new Set(values.map(value => text(value, 80)).filter(Boolean))].slice(0, 15);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function labelled(notes, labels, max = 500) {
  const matches = [...notes.matchAll(new RegExp(`(?:^|\\n)\\s*(?:${labels.map(escape).join('|')})\\s*[:=]\\s*([^\\n]+)`, 'gi'))];
  const values = [...new Set(matches.map(match => text(match[1], 16000)))];
  if (values.length > 1) return { value: '', ambiguous: true, quote: text(matches.map(match => match[0]).join('\n'), 500) };
  return matches.length ? { value: values[0].length > max ? '' : values[0], overflow: values[0].length > max, quote: text(matches[0][0], 500) } : null;
}
function matchCategory(name, categories) {
  const words = value => new Set(text(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const input = words(name);
  const ranked = categories.map(category => {
    const tokens = words(category.name);
    const hits = [...tokens].filter(token => input.has(token)).length;
    return { category, score: tokens.size ? hits / tokens.size : 0, hits };
  }).filter(row => row.hits > 0 && row.score >= .75).sort((a, b) => b.score - a.score || b.hits - a.hits);
  return ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].category : null;
}
function get(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }

function suggest({ workflow, notes = '', current = {}, trusted = {} }) {
  const suggestions = [], warnings = [];
  const add = (path, label, value, source = 'rule', quote = '', attention = false) => {
    if (value === undefined || value === '' || value === null || Array.isArray(value) && !value.length) return;
    if (JSON.stringify(get(current, path)) === JSON.stringify(value)) return;
    suggestions.push({ path, label, value, source, quote: text(quote, 500), confidence: source === 'rule' ? 'draft' : 'source', attention });
  };
  const from = (path, label, aliases, max = 500, validate = () => true, attention = false) => {
    const found = labelled(notes, aliases, max);
    if (found?.overflow) warnings.push(`${label} exceeds its field limit. Check the source and enter it manually; values are not silently shortened.`);
    else if (found?.ambiguous) warnings.push(`${label} has conflicting source values. Enter it manually.`);
    else if (found && validate(found.value)) add(path, label, found.value, 'notes', found.quote, attention);
    else if (found) warnings.push(`${label} could not be validated. Enter it manually.`);
  };
  const brand = text(trusted.brand || 'Your store', 100);
  if (workflow === 'category') {
    from('name', 'Category name', ['category', 'name'], 80);
    const name = text(labelled(notes, ['category', 'name'], 80)?.value || current.name, 80);
    if (name) {
      add('slug', 'URL slug', slug(name), 'rule', name);
      add('description', 'Category description', `Explore ${name} at ${brand}. Browse the collection and check each product for its available options.`, 'rule', name);
      add('metaTitle', 'SEO title', `${name} | ${brand}`.slice(0, 60), 'rule', name);
      add('metaDescription', 'SEO description', `Browse ${name} at ${brand}. View product details, available options and current prices.`.slice(0, 160), 'rule', name);
    }
    const category = matchCategory(notes, trusted.categories || []);
    if (category) warnings.push(`Matching existing category: ${category.name}. Check for duplication before creating another category.`);
  } else if (['banner', 'campaign'].includes(workflow)) {
    const prefix = workflow === 'campaign' ? 'creative.' : '';
    const heading = labelled(notes, ['title', 'heading', 'theme'], 120);
    const title = heading?.ambiguous || heading?.overflow ? '' : text(heading?.value || current.title || current.creative?.title || labelled(notes, ['campaign'], 120)?.value || notes.split('\n')[0], 120);
    if (heading?.ambiguous) warnings.push('Creative heading has conflicting source values. Enter it manually.');
    if (heading?.overflow) warnings.push('Creative heading exceeds 120 characters. Shorten it manually.');
    if (title) add(prefix + 'title', 'Creative heading', title, 'notes', title);
    const subtitleLabels = workflow === 'campaign' ? ['subtitle', 'subheading', 'description', 'brief'] : ['subtitle', 'subheading'];
    from(prefix + 'subtitle', 'Subtitle', subtitleLabels, 300);
    if (title && !labelled(notes, subtitleLabels)) add(prefix + 'subtitle', 'Subtitle', `Discover the ${title} edit at ${brand}.`, 'rule', title);
    from(prefix + 'buttonText', 'Button text', ['cta', 'button', 'button text'], 60);
    if (!labelled(notes, ['cta', 'button', 'button text'])) add(prefix + 'buttonText', 'Button text', 'Explore collection');
    const safeLink = value => /^\/(?!\/)[^\s\\]*$/.test(value);
    from(prefix + 'link', 'Destination link', ['link', 'destination'], 500, safeLink);
    const sourceLink = labelled(notes, ['link', 'destination'], 500);
    if (sourceLink && !sourceLink.ambiguous && !sourceLink.overflow && safeLink(sourceLink.value)) add(prefix + 'destinationType', 'Use the explicit custom destination', 'CUSTOM', 'notes', 'Explicit destination link in source', true);
    for (const row of suggestions) if ([prefix + 'link', prefix + 'destinationType'].includes(row.path)) row.group = 'creative-destination';
    if (sourceLink) warnings.push('A custom destination and its link must be reviewed together; existing product/category destinations remain protected.');
    // Without inspecting artwork, no alt-text/image-content claim is invented.
    from(prefix + 'altText', 'Artwork alt text', ['alt', 'alt text', 'artwork description'], 180);
    if (workflow === 'campaign') {
      from('name', 'Campaign name', ['campaign', 'name'], 120);
    }
    warnings.push('Offer amounts, eligibility, artwork, schedule and publication are not inferred. Confirm them in the existing editor.');
  } else if (workflow === 'coupon') {
    const amount = '(\\d[\\d,.]*)';
    const parseAmount = value => /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(value) ? Number(value.replace(/,/g, '')) : NaN;
    const numeric = (path, label, pattern, max = 1000000) => {
      const matches = [...notes.matchAll(new RegExp(pattern, 'gi'))];
      const values = [...new Set(matches.map(match => parseAmount(match[1] ?? match[2])))];
      if (values.length === 1 && values[0] >= 0 && values[0] <= max) add(path, label, String(values[0]), 'notes', matches[0][0], true);
      else if (values.length) warnings.push(`${label} is ambiguous or out of range; enter it manually.`);
      return values.length === 1 && values[0] >= 0 && values[0] <= max;
    };
    const percent = [...notes.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    const rates = [...new Set(percent.map(match => Number(match[1])))];
    let hasDiscount = rates.length === 1 && rates[0] > 0 && rates[0] <= 100;
    if (rates.length === 1 && rates[0] > 0 && rates[0] <= 100) {
      add('type', 'Discount type', 'Percentage', 'notes', percent[0][0], true);
      add('discountValue', 'Discount percentage', String(rates[0]), 'notes', percent[0][0], true);
    } else if (rates.length) warnings.push('Discount percentage is ambiguous or outside 1–100. Enter it manually.');
    from('code', 'Coupon code', ['code', 'coupon code'], 40, value => /^[a-zA-Z0-9_-]+$/.test(value), true);
    const code = suggestions.find(row => row.path === 'code'); if (code) code.value = code.value.toUpperCase();
    from('title', 'Coupon title', ['title', 'offer name'], 120);
    numeric('minOrderAmount', 'Minimum order amount', `(?:minimum(?: order)?|min(?:imum)? spend|above|over|on orders? (?:above|over))\\s*[:=]?\\s*(?:₹|rs\\.?|inr)?\\s*${amount}|(?:₹|rs\\.?|inr)\\s*${amount}\\s+(?:par|per|and above)\\b`);
    numeric('maxDiscountAmount', 'Maximum discount', `(?:max(?:imum)?(?: discount)?|up to|upto|cap)\\s*[:=]?\\s*(?:₹|rs\\.?|inr)?\\s*${amount}`);
    if (!rates.length) {
      const fixed = numeric('discountValue', 'Fixed discount', `(?:flat|discount\\s*[:=])\\s*(?:₹|rs\\.?|inr)?\\s*${amount}`);
      hasDiscount = fixed;
      if (fixed) add('type', 'Discount type', 'Flat', 'notes', 'Explicit fixed discount', true);
    }
    if (/\b(?:new customers?|first order|first purchase)\b/i.test(notes) && !/\b(?:existing|all customers|not|except|exclude|excluding)\b/i.test(notes)) {
      add('customerSegment', 'Customer segment', 'NEW', 'notes', 'New customers / first order', true);
      add('firstOrderOnly', 'First order only', true, 'notes', 'New customers / first order', true);
    }
    if (/\bfree (?:shipping|delivery)\b/i.test(notes) && !rates.length && !suggestions.some(row => row.path === 'discountValue')) add('benefitType', 'Benefit type', 'FREE_SHIPPING', 'notes', 'Free delivery', true);
    if (hasDiscount) add('benefitType', 'Benefit type', 'DISCOUNT', 'notes', 'Explicit discount in source', true);
    for (const row of suggestions) {
      if (['type', 'discountValue', 'benefitType'].includes(row.path)) row.group = 'coupon-discount';
      if (['customerSegment', 'firstOrderOnly'].includes(row.path)) row.group = 'coupon-audience';
    }
    warnings.push('Confirm every financial rule. Dates, usage limits, coupon availability and publication remain manual.');
  } else if (workflow === 'shipment') {
    const couriers = ['Blue Dart', 'Delhivery', 'DTDC', 'Ecom Express', 'Xpressbees', 'Shiprocket', 'India Post', 'DHL', 'FedEx'];
    const matches = couriers.filter(name => new RegExp(escape(name).replace(/ /g, '\\s*'), 'i').test(notes));
    from('courierName', 'Courier name', ['courier', 'carrier'], 100);
    if (matches.length === 1 && !labelled(notes, ['courier', 'carrier'])) add('courierName', 'Courier name', matches[0], 'notes', matches[0]);
    else if (matches.length > 1) warnings.push('Multiple couriers are mentioned. Choose the correct courier manually.');
    const tracking = [...notes.matchAll(/\b(?:awb|tracking(?:\s*(?:id|number|no))?|waybill|consignment(?:\s*(?:id|no|number))?)\s*[:=#-]?\s*([a-z0-9][a-z0-9-]{5,39})\b(?![a-z0-9-])/gi)];
    const ids = [...new Set(tracking.map(match => match[1]))];
    if (ids.length === 1) add('trackingNumber', 'Tracking number', ids[0], 'notes', tracking[0][0], true);
    else if (ids.length) warnings.push('Multiple tracking numbers were found. Enter the correct one manually.');
    from('trackingUrl', 'Tracking URL', ['tracking url', 'tracking link'], 500, value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }, true);
    const courier = suggestions.find(row => row.path === 'courierName')?.value || current.courierName;
    const portals = { 'Blue Dart': 'https://www.bluedart.com/track-trace', Delhivery: 'https://www.delhivery.com/tracking', DTDC: 'https://www.dtdc.com/track-your-shipment/' };
    if (!labelled(notes, ['tracking url', 'tracking link']) && portals[courier] && ids.length === 1 && current.fulfillmentMode !== 'SELF') {
      add('trackingUrl', 'Official courier tracking portal', portals[courier], 'rule', 'Official carrier tracking page; the customer may need to enter the AWB.', true);
    }
    from('expectedDeliveryAt', 'Confirmed delivery date', ['delivery date', 'expected delivery'], 10, validDate, true);
    from('customerNote', 'Customer delivery message', ['customer note', 'customer message'], 300);
    warnings.push('Tracking links and dates need an explicit source. Saving details does not mark an order shipped, delivered or paid.');
    if (current.fulfillmentMode === 'SELF') {
      for (let index = suggestions.length - 1; index >= 0; index -= 1) if (['courierName', 'trackingNumber', 'trackingUrl'].includes(suggestions[index].path)) suggestions.splice(index, 1);
      warnings.push('Self delivery is selected. Courier and AWB fields remain untouched.');
    }
    for (const row of suggestions) if (['courierName', 'trackingNumber', 'trackingUrl'].includes(row.path)) row.group = 'courier-tracking';
  } else if (workflow === 'purchase') {
    from('supplier.name', 'Supplier name', ['supplier', 'supplier name'], 160);
    from('supplier.phone', 'Supplier phone', ['supplier phone', 'phone'], 30, value => /^\+?[\d\s()-]{7,30}$/.test(value));
    from('supplier.email', 'Supplier email', ['supplier email', 'email'], 160, value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value));
    from('expectedAt', 'Confirmed arrival date', ['expected arrival', 'arrival date'], 10, validDate, true);
    const lines = [];
    for (const line of notes.split('\n')) {
      const match = line.trim().match(/^(?:sku\s*[:=]\s*)?([a-z0-9_.-]{2,80})\s*[,|;\t]\s*(\d+)\s*[,|;\t]\s*(\d+(?:\.\d{1,2})?)$/i);
      if (!match) continue;
      const choices = (trusted.purchaseOptions || []).filter(option => String(option.sku).toLowerCase() === match[1].toLowerCase());
      if (choices.length !== 1) { warnings.push(`SKU ${match[1]} is unknown or ambiguous. No purchase line added.`); continue; }
      const quantity = Number(match[2]), cost = Number(match[3]);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100000 || cost > 10000000) { warnings.push(`SKU ${match[1]} has invalid quantities/cost.`); continue; }
      if (lines.some(row => row.selection === choices[0].key)) { warnings.push(`Duplicate SKU ${match[1]} was not merged. Check its source.`); continue; }
      lines.push({ selection: choices[0].key, quantity, unitCost: cost });
    }
    if (lines.length) add('items', 'Purchase lines matched by SKU', lines.slice(0, 50), 'notes', 'SKU, quantity, unit cost lines', true);
    if (!lines.length) warnings.push('Use one invoice line per row: SKU, quantity, unit cost. Unknown/duplicate SKU matches are never guessed.');
    warnings.push('This fills a purchase draft only. Physical receiving and sellable-stock updates remain separate confirmed actions.');
  } else if (['support', 'returns'].includes(workflow)) {
    const order = trusted.order, item = trusted.returnCase;
    const number = order ? text(order.invoiceNumber || String(order._id).slice(-8).toUpperCase(), 40) : '';
    if (order) {
      let reply = `Your order ${number} is currently ${order.orderStatus}. Payment status: ${order.paymentStatus}.`;
      const tracking = text(order.shipment?.trackingNumber || order.shipment?.awb, 60);
      if (tracking) reply += ` Tracking reference: ${tracking}.`;
      if (item) reply += ` Your ${item.type} case ${text(item.caseNumber || String(item._id).slice(-8), 40)} is ${item.status}.`;
      add(workflow === 'returns' ? 'customerReply' : 'reply', 'Customer reply draft', reply + ' Please let us know if you need help.', 'database', 'Current scoped order / return status');
      const summary = `Order ${number}: ${order.orderStatus}; payment ${order.paymentStatus}${item ? `; ${item.type} ${item.status}, quantity ${item.quantity}` : ''}.`;
      add(workflow === 'returns' ? 'internalNote' : 'summary', 'Private case summary', summary, 'database', 'Current scoped order / return record');
    } else warnings.push('Select a valid store order/case to draft a factual status reply.');
    warnings.push('No message is sent. Refund approval, amount, arrival time and delivery promises are not invented.');
  } else if (workflow === 'store') {
    for (const [path, label, aliases, max] of [
      ['storeName', 'Store name', ['store name', 'brand', 'brand name'], 100],
      ['tagline', 'Tagline', ['tagline'], 180], ['legalBusinessName', 'Legal business name', ['legal business name', 'legal name'], 160],
      ['contactEmail', 'Support email', ['support email', 'contact email', 'email'], 160],
      ['contactPhone', 'Support phone', ['support phone', 'contact phone', 'phone'], 30],
      ['address', 'Store address', ['address', 'store address'], 1000], ['billingAddress', 'Billing address', ['billing address'], 1000],
      ['gstin', 'GSTIN (verify registration)', ['gstin', 'gst number'], 15], ['invoicePrefix', 'Invoice prefix', ['invoice prefix'], 16],
    ]) from(path, label, aliases, max, value => path === 'contactEmail' ? /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
      : path === 'gstin' ? /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value.toUpperCase())
        : path === 'invoicePrefix' ? /^[A-Za-z0-9_-]+$/.test(value) : true, ['gstin', 'legalBusinessName', 'billingAddress', 'invoicePrefix'].includes(path));
    const gst = suggestions.find(row => row.path === 'gstin'); if (gst) gst.value = gst.value.toUpperCase();
    if (suggestions.some(row => ['storeName', 'tagline'].includes(row.path))) add('brandIdentityEnabled', 'Use this identity across themes', true, 'rule', 'Apply the reviewed brand identity');
    if (suggestions.some(row => ['contactEmail', 'contactPhone', 'address'].includes(row.path))) add('contactDetailsEnabled', 'Use reviewed contact details', true, 'rule', 'Apply the reviewed support contact');
    warnings.push('Verify business details against your actual records. Tax rates, bank details, API keys and legal policies are never generated.');
  } else if (workflow === 'website') {
    const looks = [
      { words: /jewell|gold|luxur|premium/i, primary: '#57351c', secondary: '#f5ead7', accent: '#aa7a2e', background: '#fffaf2', text: '#241b14', font: 'Playfair Display' },
      { words: /modern|minimal|monochrome/i, primary: '#202936', secondary: '#eef1f5', accent: '#556c86', background: '#fafbfc', text: '#18202c', font: 'Inter' },
      { words: /nature|green|organic|earth/i, primary: '#265342', secondary: '#e9f1e9', accent: '#937b35', background: '#fafbf5', text: '#1c2c25', font: 'Playfair Display' },
      { words: /fashion|ethnic|rose|pink/i, primary: '#6d1f34', secondary: '#fff0f4', accent: '#b8914a', background: '#fffaf2', text: '#17161a', font: 'Playfair Display' },
    ];
    const look = looks.find(value => value.words.test(notes));
    if (look) {
      for (const field of ['primary', 'secondary', 'accent', 'background', 'text']) add('colors.' + field, `Theme ${field}`, look[field], 'rule', 'Matched brand-brief palette');
      add('colors.surface', 'Card/dialog surface', '#ffffff'); add('colors.mutedText', 'Secondary text', '#60636b');
      add('buttons.background', 'Button background', look.primary); add('buttons.textColor', 'Button text', '#ffffff');
      add('header.background', 'Header background', look.background); add('header.textColor', 'Header text', look.text);
      add('footer.background', 'Footer background', look.background); add('footer.textColor', 'Footer text', look.text);
      add('typography.headingFont', 'Heading font', look.font); add('typography.bodyFont', 'Body font', 'Inter');
      add('mobile.inheritThemeColors', 'Shared mobile palette', true); add('theme.enhancedStyles', 'Enhanced theme styling', true);
    } else warnings.push('Mention a style such as jewellery/luxury, modern/minimal, nature/green or fashion/ethnic to propose a coordinated palette.');
    const sections = Array.isArray(current.homepage?.sections) ? current.homepage.sections : [];
    for (const [id, titleAliases, bodyAliases] of [['hero', ['hero heading', 'headline'], ['hero description', 'hero subtitle']], ['newsletter', ['newsletter heading'], ['newsletter description']]]) {
      const index = sections.findIndex(section => section.id === id);
      if (index >= 0) { from(`homepage.sections.${index}.heading`, `${id} heading`, titleAliases, 140); from(`homepage.sections.${index}.description`, `${id} description`, bodyAliases, 1200); }
    }
    if (/\babout(?: us)?\s*[:=]/i.test(notes)) from('footer.description', 'About the brand', ['about', 'about us'], 1200);
    warnings.push('Suggestions change the draft only. Identity, product selection, mobile layout and publication are preserved.');
  } else if (workflow === 'catalog') {
    const product = trusted.product || current;
    const name = text(product.name, 180), category = text(product.category?.name || trusted.categoryName, 100);
    if (name) {
      const facts = unique([product.fabric, ...(Array.isArray(product.colors) ? product.colors : []), product.occasion]);
      const copy = `${name}${category ? ` from our ${category} collection` : ''}.${facts.length ? ` Details: ${facts.join(', ')}.` : ''} Check the product options before ordering.`;
      add('shortDescription', 'Short description', copy.slice(0, 500), 'database', 'Saved product name/category/specifications');
      add('description', 'Product description', copy, 'database', 'Saved product name/category/specifications');
      add('tags', 'Product tags', unique([category, product.fabric, product.occasion, ...(Array.isArray(product.colors) ? product.colors : [])]), 'database', 'Saved category/specifications');
      add('metaTitle', 'SEO title', `${name} | ${brand}`.slice(0, 60), 'database', 'Saved product name/store name');
      add('metaDescription', 'SEO description', copy.slice(0, 160), 'database', 'Saved product details');
      add('metaKeywords', 'SEO keywords', unique([name, category, product.fabric, product.occasion]).join(', '), 'database', 'Saved product details');
    }
    const matched = !product.category ? matchCategory(name, trusted.categories || []) : null;
    if (matched) warnings.push(`Suggested category: ${matched.name}. Set it in the product editor so sizing and inventory validation remain intact.`);
    warnings.push('Only listing content is proposed. Price, stock, options, claims, category structure and publication are protected.');
  }
  return { workflow, mode: 'algorithm', suggestions, warnings: [...new Set(warnings)], algorithmVersion: 1 };
}
module.exports = { WORKFLOWS, CONTENT_FIELDS, suggest, labelled, text, get, matchCategory };
