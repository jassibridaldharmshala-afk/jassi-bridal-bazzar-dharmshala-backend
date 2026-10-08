// Commercial rental suggestions only use explicit owner notes. Photo analysis
// cannot establish the prices, quantity, measurements or real availability.
function extract(notes = '') {
  const text = String(notes).slice(0, 7000), value = {}, fieldSources = {};
  const match = labels => text.match(new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:=-]\\s*([^\\n]+)`, 'i'));
  const money = (labels, key) => {
    const m = match(labels);
    if (!m || /from|starting|range|से|से शुरू|[-–]\s*\d/i.test(m[1])) return;
    const raw = m[1].replace(/(?:₹|rs\.?|inr|rupees)/gi, '').replace(/,/g, '').trim();
    if (!/^\d+(?:\.\d{1,2})?(?:\s*(?:per day|\/day|daily))?$/i.test(raw)) return;
    const amount = Math.round(Number(raw.match(/^\d+(?:\.\d{1,2})?/)[0]) * 100);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000 || (key !== 'depositPaise' && !amount)) return;
    value[key] = amount; fieldSources[`rentalPricing.${key}`] = { source: 'caption', quote: m[0].trim() };
  };
  money('daily rent|rental price(?: per day)?|rent per day|किराया|daily kiraya', 'dailyRatePaise');
  money('refundable (?:security )?deposit|security deposit|rental deposit|deposit|जमानत', 'depositPaise');
  const percent = match('rental advance|booking advance|advance percent');
  if (percent && /^\s*\d{1,3}\s*%\s*$/.test(percent[1]) && Number(percent[1].replace('%', '')) >= 1 && Number(percent[1].replace('%', '')) <= 100) {
    value.advanceMode = 'PERCENT'; value.advancePercent = Number(percent[1].replace('%', ''));
    for (const key of ['advanceMode', 'advancePercent']) fieldSources[`rentalPricing.${key}`] = { source: 'caption', quote: percent[0].trim() };
  }
  const included = match('included items|set contents|included pieces|सेट में');
  const instructions = match('fitting instructions|alteration instructions|rental instructions');
  const fitting = {};
  if (included) fitting.includedItems = included[1].trim().slice(0, 1000);
  if (instructions) fitting.instructions = instructions[1].trim().slice(0, 1000);
  for (const [key, m] of [['includedItems', included], ['instructions', instructions]]) if (m) fieldSources[`rentalPricing.fitting.${key}`] = { source: 'caption', quote: m[0].trim() };
  if (Object.keys(fitting).length) value.fitting = fitting;
  return { value, fieldSources };
}
module.exports = { extract };
