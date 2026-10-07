const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { optionalResolveStore } = require('../middleware/storeMiddleware');
const crm = require('../controllers/crmController');

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many OTP requests. Please wait before trying again.' },
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many OTP attempts. Please wait before trying again.' },
});

router.post('/send-otp', otpSendLimiter, auth.sendOtp);
router.post('/verify-otp', otpVerifyLimiter, auth.verifyOtp);
router.post('/resend-otp', otpSendLimiter, auth.resendOtp);
router.post('/profile/send-phone-change-otp', protect, otpSendLimiter, auth.sendProfilePhoneChangeOtp);
router.post('/profile/verify-phone-change-otp', protect, otpVerifyLimiter, auth.verifyProfilePhoneChangeOtp);
router.post('/profile/send-email-change-otp', protect, otpSendLimiter, auth.sendProfileEmailChangeOtp);
router.post('/profile/verify-email-change-otp', protect, otpVerifyLimiter, auth.verifyProfileEmailChangeOtp);
router.post('/refresh', auth.refresh);
router.get('/me', protect, auth.me);
router.post('/logout', protect, auth.logout);
router.post('/switch-mode', protect, auth.switchMode);
router.get('/profile', protect, auth.profile);
router.put('/profile', protect, auth.updateProfile);
router.delete('/profile', protect, auth.deleteProfile);
router.get('/privacy-requests', protect, optionalResolveStore, crm.listOwnPrivacyRequests);
router.post('/privacy-requests', protect, optionalResolveStore, crm.createOwnPrivacyRequest);

module.exports = router;
