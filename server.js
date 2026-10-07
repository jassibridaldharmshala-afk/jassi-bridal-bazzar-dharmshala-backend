const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

const app = require('./app');
const connectDB = require('./config/db');
const { isR2Configured } = require('./services/r2Upload');
const { isCloudinaryConfigured } = require('./services/cloudinaryUpload');
const { assertProductionSecrets, getOtpMode, isProduction } = require('./config/env');
const { isLocalOwnerDemoEnabled } = require('./config/localOwnerDemo');
const mongoose = require('mongoose');
const { resumePendingReelImports } = require('./queues/reelImport.queue');
const { startReelImportWatchdog } = require('./services/reelImportProgress.service');

async function startServer() {
  const cleanupTasks = [];
  let server;
  let shuttingDown = false;
  const shutdown = async (signal, error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (error) console.error(`${signal}: ${error.message}`);
    else console.log(`${signal} received. Stopping the API safely.`);
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out.');
      process.exit(1);
    }, 10000);
    forceExit.unref();
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      for (const cleanup of cleanupTasks.reverse()) await cleanup();
      await require('./queues/reelImport.queue').closeReelImportQueue().catch(() => null);
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      clearTimeout(forceExit);
      process.exit(error ? 1 : 0);
    } catch (shutdownError) {
      console.error(`Shutdown failed: ${shutdownError.message}`);
      process.exit(1);
    }
  };
  try {
    assertProductionSecrets();
  } catch (error) {
    console.error(`Startup aborted: ${error.message}`);
    process.exit(1);
  }

  if (isProduction() && getOtpMode() === 'demo') {
    console.warn(`OTP_MODE=demo is active in production. A fixed demo OTP is accepted${process.env.ALLOW_HOSTED_OWNER_DEMO === 'true' ? ' for every login, including the owner' : ' for customer logins'}. Set OTP_MODE=production once a real SMS provider is connected.`);
  }

  await connectDB();

  const PORT = process.env.PORT || process.env.SERVER_PORT || 5000;
  const persistentImageStorageConfigured = isR2Configured() || isCloudinaryConfigured();
  const localOwnerDemoRequested = isLocalOwnerDemoEnabled();
  const localOwnerDemo = localOwnerDemoRequested && !isProduction();
  if (localOwnerDemoRequested && !localOwnerDemo) {
    console.warn('LOCAL_OWNER_DEMO is ignored in production. Hosted owner demo access is controlled separately by ALLOW_HOSTED_OWNER_DEMO.');
  }
  app.locals.localOwnerDemo = localOwnerDemo;
  app.locals.tenantIndexesReady = mongoose.connection.readyState !== 1;
  server = app.listen(PORT, localOwnerDemo ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`Backend API running on port ${PORT}`);
    if (localOwnerDemo) console.log('Local owner demo login enabled. API accepts connections from this computer only.');
  });
  if (server) {
    server.keepAliveTimeout = Math.max(5000, Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 65000));
    server.headersTimeout = Math.max(server.keepAliveTimeout + 1000, Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 66000));
    server.requestTimeout = Math.max(60000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 5 * 60 * 1000));
  }
  const onProcessEvent = typeof process.once === 'function' ? process.once.bind(process) : process.on.bind(process);
  onProcessEvent('SIGTERM', () => shutdown('SIGTERM'));
  onProcessEvent('SIGINT', () => shutdown('SIGINT'));
  onProcessEvent('uncaughtException', (error) => shutdown('Uncaught exception', error));
  onProcessEvent('unhandledRejection', (error) => shutdown('Unhandled rejection', error instanceof Error ? error : new Error(String(error))));

  if (mongoose.connection.readyState === 1) {
    try {
      await require('./services/storeService').ensureTenantIndexes();
      app.locals.tenantIndexesReady = true;
    } catch (error) {
      app.locals.tenantIndexesReady = false;
      console.error(`Tenant index migration failed: ${error.message}`);
    }
    cleanupTasks.push(require('./services/deliveryService').startDeliveryWorker());
    cleanupTasks.push(require('./services/refundReconciliationService').startRefundReconciliationWorker());
    cleanupTasks.push(require('./services/reportScheduleService').startReportScheduleWorker());
    // Analytics is optional infrastructure: an index failure must not stop
    // payment/order workers. Collection fails closed until dedup indexes exist.
    app.locals.trafficIndexesReady = false;
    const startTraffic = async () => {
      try {
        await require('./services/trafficWorker').ensureIndexes();
        app.locals.trafficIndexesReady = true;
        cleanupTasks.push(require('./services/trafficWorker').startWorker());
        cleanupTasks.push(require('./services/trafficDigestService').startWorker());
      } catch (error) { console.error(`Traffic analytics initialization unavailable: ${error.message}`); }
    };
    await startTraffic();
    if (!app.locals.trafficIndexesReady) {
      const retryTraffic = setInterval(async () => { await startTraffic(); if (app.locals.trafficIndexesReady) clearInterval(retryTraffic); }, 60000);
      retryTraffic.unref(); cleanupTasks.push(() => clearInterval(retryTraffic));
    }
    cleanupTasks.push(require('./services/orderAlertService').startWorker());
    cleanupTasks.push(require('./services/rentalWorker').startWorker());
    cleanupTasks.push(require('./services/storeContentService').startContentReleaseWorker());
    cleanupTasks.push(require('./services/subscriptionLifecycleService').startSubscriptionLifecycleWorker());
    const paymentController = require('./controllers/paymentController');
    const expirePendingPayments = () => paymentController.expirePendingPaymentOrders().catch((error) => console.error(`Pending payment cleanup unavailable: ${error.message}`));
    await expirePendingPayments();
    const paymentCleanup = setInterval(expirePendingPayments, Math.max(30000, Number(process.env.PAYMENT_CLEANUP_INTERVAL_MS || 60000)));
    paymentCleanup.unref();
    cleanupTasks.push(() => clearInterval(paymentCleanup));
    const retryCartCleanup = () => require('./services/checkoutSafetyService').retryPendingCartCleanup().catch((error) => console.error(`Checkout cart cleanup unavailable: ${error.message}`));
    await retryCartCleanup();
    const cartCleanup = setInterval(retryCartCleanup, Math.max(30000, Number(process.env.CART_CLEANUP_INTERVAL_MS || 60000)));
    cartCleanup.unref();
    cleanupTasks.push(() => clearInterval(cartCleanup));
    const socialPublishing = require('./modules/social-workspace/publishing');
    socialPublishing.startWorker();
    cleanupTasks.push(() => socialPublishing.stopWorker());
    const socialWebhooks = require('./modules/social-workspace/webhookWorker');
    socialWebhooks.startWorker();
    cleanupTasks.push(() => socialWebhooks.stopWorker());
    const socialOperations = require('./modules/social-workspace/operations');
    socialOperations.startWorker();
    cleanupTasks.push(() => socialOperations.stopWorker());
    const socialImports = require('./modules/social-product-import/socialImport.service');
    await socialImports.recoverImports().catch(() => console.error('Social import recovery unavailable'));
    const socialRecovery = setInterval(() => socialImports.recoverImports().catch(() => {}), 120000);
    socialRecovery.unref();
    cleanupTasks.push(() => clearInterval(socialRecovery));
    const recovery = await resumePendingReelImports().catch((error) => {
      console.error(`Reel import recovery failed: ${error.message}`);
      return { resumed: 0 };
    });
    if (recovery.resumed) console.log(`Resumed ${recovery.resumed} pending reel import job(s).`);
    cleanupTasks.push(startReelImportWatchdog());
    cleanupTasks.push(require('./services/reelMediaCleanup.service').startReelMediaCleanupWorker());
  }

  if (isProduction() && !persistentImageStorageConfigured) {
    console.warn('Persistent image storage is not configured. Product uploads will be rejected until Cloudinary or R2 is connected.');
  }
}

startServer();
