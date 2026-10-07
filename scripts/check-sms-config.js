const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { getOtpMode } = require('../config/env');
const { getSmsProviderStatus } = require('../services/smsService');

const status = getSmsProviderStatus();
const demo = getOtpMode() === 'demo';
console.log(JSON.stringify({
  ...status,
  otpMode: getOtpMode(),
  liveCustomerOtpReady: !demo && status.configured,
  note: 'Configuration check only. Credentials and delivery have not been tested; no SMS was sent.',
}, null, 2));
if (!demo && !status.configured) process.exitCode = 1;
