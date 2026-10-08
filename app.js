const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { optionalProtect, protect } = require('./middleware/authMiddleware');
const { adminOnly } = require('./middleware/adminMiddleware');
const { optionalResolveStore, requireAdminCustomerStoreAccess, requireStoreMember } = require('./middleware/storeMiddleware');
const { requestContext } = require('./middleware/requestContext');
const { securityHeaders } = require('./middleware/securityHeaders');
const { corsOptions, getAllowedOrigins } = require('./config/corsOptions');
const { isR2Configured } = require('./services/r2Upload');
const { isCloudinaryConfigured } = require('./services/cloudinaryUpload');
const { redisHealthStatus } = require('./services/redisHealth');
const instagram = require('./controllers/instagramController');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(requestContext);
app.use(securityHeaders);
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Razorpay signs the raw request body, so this route must be registered
// before express.json() replaces it with a parsed object.
app.post(
  '/api/payments/webhook/razorpay',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res, next) => require('./controllers/paymentController').razorpayWebhook(req, res).catch(next),
);

// Meta verifies the exact raw bytes. Keep these routes before JSON parsing.
const socialOAuth = require('./modules/social-workspace/oauth');
const socialInbox = require('./modules/social-workspace/inbox');
app.get('/api/social/webhook', socialInbox.verifyWebhook);
app.post('/api/social/webhook', express.raw({ type: '*/*', limit: '1mb' }), socialOAuth.wrap(socialInbox.webhook));
app.get('/api/social/oauth/start', socialOAuth.wrap(socialOAuth.navigate));
app.get('/api/social/oauth/callback', socialOAuth.wrap(socialOAuth.callback));
app.get('/api/social/oauth/instagram/start', socialOAuth.wrap(socialOAuth.navigateInstagram));
app.get('/api/social/oauth/instagram/callback', socialOAuth.wrap(socialOAuth.callbackInstagram));
app.post(['/api/social/deauthorize', '/api/social/data-deletion'], express.urlencoded({ extended: false, limit: '16kb' }), socialOAuth.wrap(socialOAuth.deauthorize));
app.get('/api/social/deletion-status/:code', socialOAuth.wrap(socialOAuth.deletionStatus));
app.use('/api/analytics', express.json({ limit: '32kb' }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(require('./middleware/auditMiddleware').auditAdminRequests);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/uploads/:filename', sendImagePlaceholder);
app.get('/placeholder.jpg', sendImagePlaceholder);

app.get('/', (req, res) => res.json({ message: "Jassi General Store API is running" }));
app.get('/health', async (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const database = dbStates[mongoose.connection.readyState] || 'unknown';
  const imageStorage = isR2Configured() ? 'r2' : isCloudinaryConfigured() ? 'cloudinary' : 'local';
  const persistentImageStorageConfigured = imageStorage !== 'local';
  const redis = await redisHealthStatus();
  const release = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim().slice(0, 12) || null;
  const databaseRequired = process.env.NODE_ENV === 'production' || process.env.REQUIRE_DATABASE === 'true';
  const mediaStorageRequired = process.env.REQUIRE_MEDIA_STORAGE === 'true';
  const redisRequired = process.env.REQUIRE_REDIS === 'true';
  const tenantIndexesReady = app.locals.tenantIndexesReady !== false;
  const ready = (!databaseRequired || database === 'connected')
    && (!mediaStorageRequired || persistentImageStorageConfigured)
    && (!redisRequired || redis === 'connected')
    && tenantIndexesReady;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    ready,
    release,
    database,
    environment: process.env.NODE_ENV || 'development',
    imageStorage,
    persistentImageStorageConfigured,
    redis,
    checks: {
      database: { required: databaseRequired, ready: database === 'connected' },
      mediaStorage: { required: mediaStorageRequired, ready: persistentImageStorageConfigured },
      redis: { required: redisRequired, ready: redis === 'connected' },
      tenantIndexes: { required: databaseRequired, ready: tenantIndexesReady },
      trafficIndexes: { required: false, ready: app.locals.trafficIndexesReady !== false },
    },
    ...(process.env.NODE_ENV === 'production' ? {} : { allowedOrigins: getAllowedOrigins() }),
  });
});

const apiLimiter = rateLimit({
  windowMs: Math.max(60000, Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)),
  limit: Math.max(100, Number(process.env.API_RATE_LIMIT_MAX || 1200)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: req => process.env.NODE_ENV === 'test' || /^\/analytics\/(collect|config|forget)(\/|$)/.test(req.path),
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
});
app.use('/api', apiLimiter);

app.use('/api', optionalProtect);
app.use('/api/system', require('./routes/clientSystemRoutes'));
app.use('/api', require('./middleware/externalLicenseMiddleware'));
app.use('/api/social', require('./modules/social-workspace/routes'));
app.get('/api/catalog-configuration', optionalResolveStore, require('./controllers/catalogConfigurationController').publicCatalog);
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin/customers', protect, adminOnly, require('./routes/customerAdminRoutes'));
app.use('/api/admin/users', protect, adminOnly, require('./routes/customerAdminRoutes'));
app.use('/api/admin/customer-crm', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/customerCrmRoutes'));
app.use('/api/admin', require('./routes/adminAuthRoutes'));
app.use('/api/admin/smart-fill', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/workflowSmartFillRoutes'));
app.use('/api/admin/products', protect, adminOnly, require('./routes/adminProductRoutes'));
app.use('/api/admin/categories', protect, adminOnly, require('./routes/categoryRoutes'));
app.use('/api/admin/orders', protect, adminOnly, require('./routes/orderRoutes'));
app.use('/api/admin/coupons', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/couponRoutes'));
app.use('/api/admin/banners', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/bannerRoutes'));
app.use('/api/admin/campaigns', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/campaignRoutes'));
app.use('/api/admin/reviews', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/reviewRoutes'));
app.use('/api/admin/returns', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/returnRoutes'));
app.use('/api/admin/settings', protect, adminOnly, optionalResolveStore, require('./routes/settingsRoutes'));
app.use('/api/admin/rentals', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/rentalRoutes').staffRouter());
app.use('/api/admin/business', protect, adminOnly, optionalResolveStore, requireAdminCustomerStoreAccess, require('./routes/businessRoutes'));
app.use('/api/admin/store-content', protect, adminOnly, require('./routes/storeContentRoutes'));
app.use('/api/admin/customization', protect, adminOnly, require('./routes/websiteCustomizationRoutes'));
app.use('/api/admin/uploads', require('./routes/uploadRoutes'));
app.use('/api/admin/upload', require('./routes/uploadRoutes'));
app.use('/api/admin/product-drafts', require('./routes/productDraftRoutes'));
app.use('/api/admin/reel-imports', require('./modules/reel-product-import/reelImport.routes'));
app.use('/api/admin/social-imports', require('./modules/social-product-import/socialImport.routes'));
app.use('/api/admin/variant-groups', protect, adminOnly, optionalResolveStore, require('./routes/variantGroupRoutes'));
app.use('/api/admin/audit-logs', protect, adminOnly, require('./routes/auditAdminRoutes'));
app.use('/api/stores', require('./routes/storeRoutes'));
app.use('/api/seller', protect, requireStoreMember, require('./routes/sellerRoutes'));
app.get('/api/instagram/oauth/callback', instagram.oauthCallback);
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/storefront/home', optionalResolveStore, require('./routes/storefrontHomeRoutes'));
app.use('/api/products', optionalResolveStore, require('./routes/publicProductRoutes'));
app.use('/api/rentals', optionalResolveStore, require('./routes/rentalRoutes').customerRouter());
app.use('/api/variant-groups', optionalResolveStore, require('./routes/variantGroupRoutes'));
app.use('/api/categories', optionalResolveStore, require('./routes/categoryRoutes'));
app.use('/api/cart', optionalResolveStore, require('./routes/cartRoutes'));
app.use('/api/user/addresses', require('./routes/addressRoutes'));
app.use('/api/wishlist', optionalResolveStore, require('./routes/wishlistRoutes'));
app.use('/api/evidence', require('./routes/evidenceRoutes'));
app.use('/api/orders', optionalResolveStore, require('./routes/orderRoutes'));
app.use('/api/payments', optionalResolveStore, require('./routes/paymentRoutes'));

const paymentController = require('./controllers/paymentController');
const { wrapPaymentHandler } = require('./utils/paymentRouteHandler');
app.post('/api/create-order', protect, optionalResolveStore, wrapPaymentHandler(paymentController.createPaymentOrder));
app.post('/api/verify-payment', protect, optionalResolveStore, wrapPaymentHandler(paymentController.verifyPayment));

app.use('/api/coupons', optionalResolveStore, require('./routes/couponRoutes'));
app.use('/api/banners', optionalResolveStore, require('./routes/bannerRoutes'));
app.use('/api/reviews', optionalResolveStore, require('./routes/reviewRoutes'));
app.use('/api/returns', optionalResolveStore, require('./routes/returnRoutes'));
app.use('/api/settings', optionalResolveStore, require('./routes/settingsRoutes'));
app.get('/api/website-config', optionalResolveStore, require('./controllers/websiteCustomizationController').getActiveConfig);
app.use('/api/contact', optionalResolveStore, require('./routes/contactRoutes'));
app.use('/api/newsletter', optionalResolveStore, require('./routes/newsletterRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/admin/contact', protect, adminOnly, require('./routes/contactRoutes'));
app.use('/api/admin/newsletter', protect, adminOnly, require('./routes/newsletterRoutes'));

app.use(require('./routes/seoRoutes'));

app.use(notFound);
app.use(errorHandler);

function sendImagePlaceholder(req, res, next) {
  const filename = String(req.params.filename || 'placeholder.jpg');
  if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(filename)) return next();

  const label = filename.toLowerCase().includes('placeholder') ? 'Jassi General Store' : 'Image unavailable';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#fbf3ee"/>
          <stop offset="100%" stop-color="#f6d2bf"/>
        </linearGradient>
      </defs>
      <rect width="800" height="1000" fill="url(#bg)"/>
      <path d="M250 410c55-120 245-120 300 0" fill="none" stroke="#7b1f3a" stroke-width="34" stroke-linecap="round"/>
      <path d="M300 430c38-75 162-75 200 0" fill="none" stroke="#ff5f86" stroke-width="28" stroke-linecap="round"/>
      <text x="400" y="545" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="800" fill="#17161a">Jassi</text>
      <text x="400" y="600" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="8" fill="#7b1f3a">COLLECTION</text>
      <text x="400" y="690" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#6b7280">${label}</text>
    </svg>
  `;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(svg);
}

module.exports = app;
