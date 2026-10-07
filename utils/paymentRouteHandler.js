function wrapPaymentHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const transactionConflict = error?.code === 112
        || error?.codeName === 'WriteConflict'
        || error?.hasErrorLabel?.('TransientTransactionError')
        || /write conflict|temporarily unavailable for transaction/i.test(String(error?.message || ''));
      const status = error.statusCode
        || (transactionConflict ? 409 : error.razorpayAuthError ? 401 : error.razorpayError ? 500 : 400);
      res.status(status).json({
        success: false,
        code: error.errorCode || (transactionConflict ? 'OUT_OF_STOCK' : error.razorpayError ? 'PAYMENT_FAILED' : 'REQUEST_FAILED'),
        message: transactionConflict ? 'Stock changed while checkout was being confirmed. Review your bag and try again.' : error.message || 'Payment request failed',
      });
    }
  };
}

module.exports = {
  wrapPaymentHandler,
};
