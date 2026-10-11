function customerName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return /^(?:Jassi|Samira|Samaira) User \d{4}$/i.test(name) ? '' : name;
}

function customerEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /@samira\.local$/i.test(email) ? '' : email;
}

function orderCustomer(order = {}) {
  const saved = order.customer, address = order.shippingAddress || {};
  return {
    name: customerName(saved?.name) || customerName(address.fullName) || customerName(order.user?.name) || 'Customer',
    email: customerEmail(saved ? saved.email : address.email !== undefined ? address.email : order.user?.email),
    phone: saved?.phone || address.mobile || address.phone || order.user?.phone || '',
  };
}

module.exports = { customerName, customerEmail, orderCustomer };
