async function sendOtp(phone, otp) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Mock SMS OTP for ${phone}: ${otp}`);
  }
  return { success: true, provider: 'mock', devOtp: process.env.NODE_ENV === 'production' ? undefined : otp };
}

module.exports = { sendOtp };
