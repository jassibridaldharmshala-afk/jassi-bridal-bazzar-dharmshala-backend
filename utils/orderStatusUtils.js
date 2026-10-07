function shouldConfirmPaidOnlineOrder(order) {
  return order.paymentStatus === 'Paid'
    && order.orderStatus === 'Pending'
    && Boolean(order.razorpayPaymentId)
    && order.paymentProvider === 'Razorpay';
}

async function syncPaidOnlineOrderStatus(order) {
  if (!order || !shouldConfirmPaidOnlineOrder(order)) return order;

  order.orderStatus = 'Confirmed';

  const timeline = Array.isArray(order.statusTimeline) ? order.statusTimeline : [];
  const verifiedEntry = [...timeline].reverse().find((entry) => (
    String(entry?.note || '').toLowerCase().includes('payment verified')
  ));

  if (verifiedEntry && verifiedEntry.status === 'Pending') {
    verifiedEntry.status = 'Confirmed';
  } else if (!timeline.some((entry) => entry.status === 'Confirmed')) {
    timeline.push({
      status: 'Confirmed',
      date: new Date(),
      note: 'Payment confirmed and order placed',
    });
  }

  order.statusTimeline = timeline;
  order.revision = Number(order.revision || 0) + 1;
  await order.save();
  return order;
}

module.exports = {
  shouldConfirmPaidOnlineOrder,
  syncPaidOnlineOrderStatus,
};
