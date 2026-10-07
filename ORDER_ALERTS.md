# Owner order alerts and shared themes

Store owners can configure new-order email and WhatsApp alerts in **Settings > Order alerts**. Both channels start disabled. Checkout does not wait for an external provider, and existing customer and in-app notifications remain unchanged.

## Configure email alerts

1. Set a durable, private `DATA_ENCRYPTION_KEY` in the backend environment before saving credentials. Keep a secure backup; changing it without a previous-key migration prevents stored credentials from decrypting.
2. Open Settings > Order alerts as a verified store owner or deployment administrator.
3. Enter the storefront HTTPS origin, such as `https://your-store.com`, for signed-in admin links.
4. Enable email, enter the recipient, a Brevo-verified sender, sender name and this client's Brevo API key.
5. Save, then choose **Send test email**. Check both delivery history and the recipient inbox, including spam.

Email delivery uses the existing project's Brevo ecosystem with separate per-store credentials, not another client's environment key. Sender setup follows the [Brevo transactional email guide](https://developers.brevo.com/docs/send-a-transactional-email).

## Configure WhatsApp alerts

Use this client's Meta WhatsApp Business Platform account, business phone-number ID and messaging access token. Enable the channel, enter the consenting recipient in international format, and enter the approved template name and exact language code. Save, then send a test. Tests are limited to one per minute per store, across channels.

Create a text-only template with **five positional body variables**. Do not add variable headers, media, named parameters or dynamic buttons; this adapter supplies only the body below.

> New order received for {{1}}. Order number: {{2}}. Total: {{3}}. Payment status: {{4}}. Review securely: {{5}}. Please sign in to your store to fulfil the order.

The variables are store name, order number, total including currency, payment or COD verification status, and the authenticated admin order link, in that order. The test uses a synthetic order and creates no checkout/order record. Meta must approve and enable the template; submission does not guarantee approval. See Meta's [template parameter example](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/) and [Cloud API request collection](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text). This implementation uses direct HTTPS, not the archived SDK. `META_GRAPH_VERSION` optionally overrides the project's default Graph API version.

Provider account requirements, balance and charges are managed outside the store. Saving a normal WhatsApp contact number alone does not enable automated messaging.

## Delivery and recovery

- COD alerts are queued when the order is created; the message identifies pending COD verification when applicable. Online orders alert only after payment confirmation.
- Enabling or re-enabling alerts starts with orders created after that enable time. Existing orders are not broadcast, including older unpaid attempts that later become paid.
- A persistent MongoDB queue has one job per store, order and enabled channel. A recovery scan finds missed callbacks after a process restart. Multiple workers claim jobs atomically.
- The worker runs in the backend server, checking every 15 seconds when idle. Hosting must keep that service running for prompt alerts. A sleeping/offline service delays sending; checkout remains independent of delivery.
- **Provider accepted** means submission was accepted, not confirmed inbox/WhatsApp delivery. Delivery/read webhooks are not implemented by this feature.
- Rate limits retry with backoff, up to five attempts. Rejected configuration needs attention. Timeout, interrupted sending or ambiguous acceptance is marked **Check provider**, with no automatic resend. Check the provider before confirming a manual retry, which can duplicate a message.
- Disabling a channel, changing its recipient or cancelling the order skips unsent old jobs. Delivery history is scoped to the store and shows the latest 30 jobs.
- Secrets are encrypted, excluded from public settings and never returned to the browser. Alerts omit customer phone numbers and addresses. Admin links still require authentication and store access.

## Publish a shared theme

Choose a preset in Website Designer, preview, and **Publish** or activate a published theme. Saving a draft alone never changes the live shop. Brand colours, typography and shared controls now inherit document-level tokens across desktop, mobile, admin, loaders and portal dialogs. Status colours and product colour swatches remain semantic/product-specific.

Presets turn on **Use shared theme colours on mobile**, preserving columns, section order, images and content. The optional **Also match mobile card corners** control changes corners without replacing mobile content. You can explicitly switch off shared mobile colours to supply a separate mobile header/background palette. Other tabs refresh after publish through the existing settings event; focus also revalidates published appearance. No checkout, payment or inventory rules are changed by theme selection.

## Client project packages

Newly generated ZIPs contain the shared theme implementation, owner alert settings, provider adapters, worker, queue and this setup guide. Master configuration, portfolio and project-generation screens/routes remain excluded. Databases and saved provider credentials are never copied. Configure each client after deployment and test both enabled channels. Existing ZIPs and deployments need an updated build; they are not updated automatically.
