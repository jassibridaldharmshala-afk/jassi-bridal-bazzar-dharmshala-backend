function normalizePhone(phone = '') {
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  const indianLocal = normalizeIndianMobile(phone);
  if (/^[6-9]\d{9}$/.test(indianLocal)) return indianLocal;
  if (raw.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return '';
}

// A local number can itself start with 91. Strip the country code only
// when all twelve digits are present, never from a ten-digit subscriber.
function normalizeIndianMobile(phone = '') {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

function requireValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    const error = new Error('Enter a valid mobile number with country code');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

module.exports = { normalizePhone, normalizeIndianMobile, requireValidPhone };
