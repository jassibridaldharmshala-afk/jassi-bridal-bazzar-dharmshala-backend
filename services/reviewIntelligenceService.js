const TOPICS = {
  quality: /\b(?:quality|finish|stitch|stitching|durable|damaged|defect|torn|tuti|kharab)\b/i,
  fit: /\b(?:fit|fitting|size|tight|loose|small|large|bada|chota)\b/i,
  fabric: /\b(?:fabric|material|cloth|cotton|silk|georgette|linen|kapda)\b/i,
  colour: /\b(?:colou?r|shade|fade|faded|rang)\b/i,
  value: /\b(?:price|value|cost|expensive|affordable|paisa|mehnga|sasta)\b/i,
  delivery: /\b(?:delivery|parcel|package|packaging|courier|late|delay)\b/i,
};

function analyseReview({ rating, title, comment }) {
  const text = `${title || ''} ${comment || ''}`.trim();
  const riskSignals = [];
  if (/(?:\+?91[\s-]?)?[6-9]\d{9}\b/.test(text) || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) riskSignals.push('PERSONAL_INFORMATION');
  if (/https?:\/\/|www\.|(?:wa\.me|t\.me)\//i.test(text)) riskSignals.push('EXTERNAL_LINK');
  if (/\b(?:fuck|shit|bitch|madarchod|bhenchod)\b/i.test(text)) riskSignals.push('ABUSIVE_LANGUAGE');
  if (/(.)\1{12,}/i.test(text) || /\b(?:buy now|contact me|dm me)\b/i.test(text)) riskSignals.push('POSSIBLE_SPAM');
  const topics = Object.entries(TOPICS).filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  const value = Number(rating || 0);
  const sentiment = value >= 4 ? 'POSITIVE' : value <= 2 ? 'NEGATIVE' : 'NEUTRAL';
  return { sentiment, topics, riskSignals, needsModeration: riskSignals.length > 0 };
}

module.exports = { analyseReview };
