const mongoose = require('mongoose');

let transactionSupport = null;

/**
 * Multi-document transactions need a replica set or a sharded cluster.
 * Atlas provides one; a plain local mongod does not, so the result is probed
 * once and cached for the process lifetime.
 */
async function supportsTransactions() {
  if (mongoose.connection.readyState !== 1) return false;
  if (transactionSupport !== null) return transactionSupport;

  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    transactionSupport = Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    transactionSupport = false;
  }
  return transactionSupport;
}

/**
 * Runs `work` inside a transaction when the deployment supports one and
 * sequentially otherwise. `work` receives the session (or null) and must pass
 * it to every query so the operations join the transaction.
 *
 * Callers must stay safe without a transaction too: on standalone MongoDB the
 * steps are applied one by one and compensating actions are the caller's job.
 */
async function runInTransaction(work) {
  if (!(await supportsTransactions())) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function resetTransactionSupportCache() {
  transactionSupport = null;
}

module.exports = { resetTransactionSupportCache, runInTransaction, supportsTransactions };
