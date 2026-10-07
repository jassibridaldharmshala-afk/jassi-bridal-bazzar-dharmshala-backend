const { decryptSecret } = require('../utils/secretBox');

function failure(message, { retryable = false, uncertain = false } = {}) {
  return Object.assign(new Error(message), { retryable, uncertain });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
}

async function deliver(channel, config, recipient, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const isEmail = channel === 'EMAIL';
    const version = /^v\d+\.0$/.test(process.env.META_GRAPH_VERSION || '') ? process.env.META_GRAPH_VERSION : 'v23.0';
    const url = isEmail ? 'https://api.brevo.com/v3/smtp/email'
      : `https://graph.facebook.com/${version}/${config.whatsapp.phoneNumberId}/messages`;
    const secret = decryptSecret(isEmail ? config.email.apiKey : config.whatsapp.accessToken);
    if (!secret) throw failure('Provider credentials are missing. Review Order alerts settings.');
    const body = isEmail ? {
      sender: { email: config.email.senderEmail, name: config.email.senderName || message.storeName },
      to: [{ email: recipient }],
      subject: message.rental ? `${message.title} — ${message.storeName}` : `${message.test ? '[Test] ' : ''}New order ${message.number} — ${message.storeName}`,
      htmlContent: message.rental ? `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6"><h2>${escapeHtml(message.storeName)}</h2><h3>${escapeHtml(message.title)}</h3><p>${escapeHtml(message.body)}</p><p><a href="${escapeHtml(message.link)}">Open rental securely</a></p></div>` : `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6"><h2>${escapeHtml(message.storeName)}</h2><h3>${message.test ? 'Order alert test' : 'New order received'}</h3><p>Order: <strong>${escapeHtml(message.number)}</strong></p><p>Total: ${escapeHtml(message.amount)}<br>Payment: ${escapeHtml(message.payment)}<br>Items: ${escapeHtml(message.itemCount)}</p><p><a href="${escapeHtml(message.link)}">Open order securely</a></p><p>Sign in to your store admin to review and fulfil this order. No customer address or phone is included in this alert.</p></div>`,
    } : {
      messaging_product: 'whatsapp', to: recipient.replace(/^\+/, ''), type: 'template',
      template: { name: config.whatsapp.templateName, language: { code: config.whatsapp.language }, components: [
        { type: 'body', parameters: [message.storeName, message.number, message.amount, message.payment, message.link]
          .map(text => ({ type: 'text', text: String(text) })) },
      ] },
    };
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(isEmail ? { 'api-key': secret, accept: 'application/json' } : { authorization: `Bearer ${secret}` }) },
        body: JSON.stringify(body),
      });
    } catch { throw failure('Provider response was not received. Check the provider before retrying to avoid a duplicate.', { uncertain: true }); }
    if (!response.ok) {
      // Do not expose provider response bodies, tokens or destinations in logs.
      if (response.status === 429) throw failure('Provider rate limit reached. A retry is scheduled.', { retryable: true });
      if (response.status >= 500) throw failure('Provider returned a server error. Check the provider before retrying.', { uncertain: true });
      throw failure('Provider rejected this alert. Check credentials, verified sender, balance, recipient and approved template.');
    }
    let result;
    try { result = await response.json(); } catch { throw failure('Provider acceptance could not be confirmed. Check the provider before retrying.', { uncertain: true }); }
    const id = isEmail ? result.messageId : result.messages?.[0]?.id;
    if (!id) throw failure('Provider did not return a message ID. Check the provider before retrying.', { uncertain: true });
    return { messageId: String(id).slice(0, 500) };
  } finally { clearTimeout(timer); }
}

module.exports = { deliver, escapeHtml };
