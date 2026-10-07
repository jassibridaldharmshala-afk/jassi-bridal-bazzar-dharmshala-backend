const crypto = require('node:crypto');
function documents(booking) {
  const b = booking.toObject ? booking.toObject() : booking;
  const rentalPaise = b.adjustedRentalPaise ?? b.quote.rentalPaise;
  const basisPoints = b.quote.tax?.basisPoints || 0;
  const taxPaise = Math.round(rentalPaise * basisPoints / (10000 + basisPoints));
  const issued = !!b.confirmedAt;
  const identifier = `${issued ? 'RINV' : 'RPRO'}-${b.number}`;
  return {
    invoice: { number: identifier, kind: issued ? 'RENTAL_INVOICE' : 'PROFORMA', issuedAt: b.confirmedAt || b.createdAt, seller: b.billingIdentity || {}, customer: b.customer, currency: 'INR', rentalPaise, taxablePaise: rentalPaise - taxPaise, taxPaise, basisPoints, serviceCode: b.quote.tax?.serviceCode || '', depositPaise: b.quote.depositPaise, totalPaise: rentalPaise + b.quote.depositPaise, items: b.quote.items, revised: !!b.acceptedQuote, originalQuote: b.acceptedQuote, policyRevision: b.policyRevision },
    receipts: (b.ledger || []).map(e => ({ number: `${e.kind === 'REFUND' ? 'RRF' : 'RRC'}-${b.number}-${crypto.createHash('sha256').update(e.operationId || e.reference || String(e.at)).digest('hex').slice(0, 10).toUpperCase()}`, kind: e.kind, amountPaise: e.amountPaise, status: e.status, method: e.method, reference: e.reference || e.refundId, issuedAt: e.at })),
    adjustmentPaise: rentalPaise - b.quote.rentalPaise,
    deliveryFeePaise: b.quote.deliveryFeePaise || 0, returnFeePaise: b.quote.returnFeePaise || 0,
    note: 'Security deposit is recorded separately from rental charges. Tax rate/service code are owner-configured; verify your business invoice requirements before publishing them.',
  };
}
module.exports = { documents };
