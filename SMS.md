# OTP provider setup

Each separately deployed client chooses one SMS provider in **Admin Settings > OTP & SMS**, or keeps its existing backend hosting environment (`backend/.env`) configuration. All providers use the same login, resend, profile-phone-change, owner and COD OTP verification code. OTPs are generated and hashed by this backend; SMS providers deliver that exact code. Expiry, attempt limits, resend cooldown and purpose/order scope stay in the application.

## Change providers from Settings

1. Sign in as a verified deployment administrator and open **Settings > OTP & SMS**.
2. Choose Twilio, 2Factor, MSG91 or Fast2SMS and enter this client's credentials. Save a **draft**. Blank fields retain saved values for the same provider only; optional saved fields have an explicit clear control.
3. Consent to a real, potentially chargeable **test SMS** to your own verified account phone. The recipient cannot be changed here. Tests are limited to one per minute and use random codes even in demo mode.
4. Enter the received six-digit code within five minutes and choose **Verify OTP and activate**. Five incorrect attempts invalidate the test. Only the administrator who received it can activate that exact revision.

Until successful verification, the current provider remains active. Sending or accepting an SMS alone never activates the draft. New real OTP requests use the activated provider immediately, without restarting the server. Existing login OTPs, session lifetimes, email verification and demo-mode switches are unchanged. Failure never falls back to Twilio or another paid account automatically.

The same test flow can return to **backend environment configuration**. Discarding a draft only removes that unactivated draft; it never disables the live provider. Credentials are encrypted separately from public store settings, never returned in API responses, placed in browser storage, logged in audits, or included in generated ZIPs. HTTP responses are private/no-store. Do not add request-body logging on these endpoints or outgoing-provider URL logging.

This is **deployment-wide**, including administrator login, customer phone verification and COD OTPs. Shared-backend seller roles cannot change it. Separate exported client backends have independent configuration. Per-store SMS accounts inside one shared login backend are not supported by this screen.

### Encryption and recovery

Use a stable, private `DATA_ENCRYPTION_KEY` on the backend. Existing installations without it use their stable `JWT_SECRET`, matching the application's existing encrypted-token storage. Do not rotate/delete encryption material without retaining the former key in `DATA_ENCRYPTION_PREVIOUS_KEYS`; otherwise saved credentials cannot be decrypted. When adding `DATA_ENCRYPTION_KEY` to an installation that previously used JWT encryption, retain the old JWT secret in that previous-key list during migration.

If a saved provider stops working and no administrator can sign in, the hosting administrator can deliberately set `SMS_CONFIG_SOURCE=environment`, configure a working real `SMS_PROVIDER` and its credentials, then restart the backend. This explicit emergency override ignores saved selection without erasing it and is shown in Settings. Remove the override before testing/activating Settings again. Full replacement credentials can recover an unreadable provider draft; old encrypted values are never exposed.

Keep `OTP_MODE=production` and owner-demo flags disabled for live clients. The screen intentionally cannot turn on demo login or change owner identity, session secrets or OTP security limits. Account balance, provider sender/template approval, handset delivery and any country restrictions still require the client's provider account.

## Bootstrap using backend environment

Set these for real customer delivery:

```dotenv
OTP_MODE=production
ALLOW_HOSTED_OWNER_DEMO=false
LOCAL_OWNER_DEMO=false
```

Configure **one** of the following groups. Each client's account owns its SMS balance and approved templates.

### Twilio (existing installations)

```dotenv
SMS_PROVIDER=twilio
SMS_ACCOUNT_SID=your-account-sid
SMS_AUTH_TOKEN=your-auth-token
SMS_SENDER_ID=your-twilio-sender
```

Existing Twilio names and message content are preserved.

### MSG91

```dotenv
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=your-auth-key
MSG91_TEMPLATE_ID=your-otp-template-id
```

The adapter retains the existing SendOTP v5 integration, supplying the backend-generated code in `otp`. Use a **MSG91 OTP template ID**, not a Widget ID, SMS Flow ID or the telecom DLT template ID. Your account/template must support sending a supplied OTP. Verify that the SMS code matches the entered code during the live acceptance test. Existing `SMS_API_KEY` and `SMS_TEMPLATE_ID` remain supported; the `MSG91_*` values take precedence when present. Map the client's approved sender and DLT template in the provider dashboard.

### 2Factor.in

```dotenv
SMS_PROVIDER=twofactor
TWOFACTOR_API_KEY=your-api-key
TWOFACTOR_TEMPLATE_NAME=your-approved-otp-template-name
```

`2factor` and `2factor.in` are accepted aliases. Template name is optional: leave it blank to use the provider's default OTP template. A custom brand message needs that brand's approved template. This adapter uses **Send OTP (Manual Generation)**, not AUTOGEN or the provider's verify API. The application keeps verifying the same six-digit OTP it generated. 2Factor's documented URL contains the key and code; do not record outbound request URLs in proxy/APM logs.

### Fast2SMS (existing support, India)

```dotenv
SMS_PROVIDER=fast2sms
FAST2SMS_API_KEY=your-api-key
FAST2SMS_SENDER_ID=
```

Uses the existing `otp` route. The sender is optional. Legacy `SMS_API_KEY` and `SMS_SENDER_ID` still work. International numbers are rejected instead of silently sending to an incorrect Indian number.

## Check backend environment configuration

1. Configure the chosen provider on the **backend** service. Keep all other provider fields empty. Real `.env` files and credentials are never exported in client ZIPs.
2. From `backend`, run `npm run check:sms`. It prints the **environment** provider, missing variable names and OTP mode, with no key values or SMS requests. It does not connect to the database or inspect Settings overrides. Use the Settings screen for the active source/provider.
3. Restart/redeploy the backend. Changes to an ignored local `.env` do not update hosted environment variables.
4. Perform a live send/verify/resend with an approved test number. Test customer and admin login, profile phone changes and COD verification where enabled. Confirm the received code works, wrong codes fail and expired codes cannot be used. Provider acceptance is not proof of handset delivery; check its delivery logs too.

For demo use, retain `OTP_MODE=demo`. Existing customer/owner demo opt-ins continue to work. Local development in demo mode uses mock SMS. Explicit `OTP_MODE=production` also enables configured real delivery locally, so local integration tests can use the chosen provider.

Production OTP mode rejects missing, unknown and mock providers. A timeout or rejection does not automatically switch accounts/providers or send a second SMS. Request a new code through the existing resend flow after fixing the provider; automatic retries could send duplicate messages and incur unexpected charges.

This selection is **per backend deployment**, appropriate for exported independent client projects. Stores sharing one backend share its selected provider.

## Extending the provider system

Add an adapter in `services/providers` with `getConfiguration(override)` (including `missing` variable names) and `sendOtp(phone, otp, override)`, then register it and its credential fields in `services/smsProviderRegistry.js`. Explicit credentials must never borrow missing fields from the environment. Owner trust, handover and Settings use that registry. Validate the provider's response body as well as HTTP status, use the shared bounded request helper, and return only safe error codes. Do not pass provider errors, keys, phone numbers or OTPs to logs or the frontend.

## Official references

- [2Factor API documentation: Manual Generation](https://2factor.in/api-docs)
- [MSG91 OTP documentation](https://docs.msg91.com/otp)
- [MSG91 OTP setup and template mapping](https://msg91.com/help/sendotp/step-by-step-process-to-configure-otp)
