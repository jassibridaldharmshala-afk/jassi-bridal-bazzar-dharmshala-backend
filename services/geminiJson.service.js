const crypto = require('node:crypto');

// These aliases follow supported Flash models when a version is retired.
// Keep the administrator's configured model first; never change their .env.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const CACHE_MS = 15 * 60 * 1000;
let modelCache;

function aiError(contextCode, message, retryModel = false) {
  return Object.assign(new Error(message), { contextCode, retryModel });
}

function cacheFor(key, configured) {
  const identity = crypto.createHash('sha256').update(key + '\0' + configured).digest('hex');
  if (modelCache?.identity !== identity || modelCache.expiresAt <= Date.now()) {
    modelCache = { identity, expiresAt: Date.now() + CACHE_MS, unavailable: new Set(), preferred: '' };
  }
  return modelCache;
}

function providerError(status, payload) {
  const detail = String(payload?.error?.message || '');
  if (status === 404 || status === 410 || status === 400 && /model.*(?:not found|not supported|unavailable|retired)/i.test(detail)) {
    return aiError('AI_MODEL_UNAVAILABLE', 'The configured AI model and available fallbacks could not be used. Check the Gemini model available to your project.', true);
  }
  if (status === 429) return aiError('AI_QUOTA_EXCEEDED', 'The Gemini quota is currently exhausted. Wait for it to reset, then try again.');
  if ([400, 401, 403].includes(status) && /reported.{0,20}leaked|leaked.{0,50}key|key.{0,50}leaked/i.test(detail)) {
    // Preserve the shared access-denied code so bulk imports stop immediately.
    // Never forward the provider payload, which may contain sensitive values.
    return aiError('AI_ACCESS_DENIED', 'Google blocked this Gemini API key because it was reported as leaked. Create a replacement key in Google AI Studio, update GEMINI_API_KEY on the backend, then restart the backend. You can still fill details from pasted product notes.');
  }
  if ([401, 403].includes(status) || status === 400 && /API.?key.*(?:not valid|invalid|expired)/i.test(detail)) {
    return aiError('AI_ACCESS_DENIED', 'Gemini rejected the API key or project access. Check the backend key and its permissions.');
  }
  if (status >= 500) return aiError('AI_PROVIDER_UNAVAILABLE', 'Gemini is temporarily busy or unavailable. Please try Smart Fill again shortly.', true);
  return aiError('AI_REQUEST_REJECTED', 'Gemini could not accept the analysis request. Check the selected model and supported media format.');
}

function parseResponse(payload) {
  const candidate = payload?.candidates?.[0];
  if (payload?.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'RECITATION'].includes(candidate?.finishReason)) {
    throw aiError('AI_CONTENT_BLOCKED', 'Gemini declined to analyze this media. You can still enter the product details manually.');
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw aiError('AI_RESPONSE_INCOMPLETE', 'Gemini returned an incomplete answer. Please try Smart Fill again.', true);
  }
  const text = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('').trim();
  if (!text) throw aiError('AI_EMPTY_RESPONSE', 'Gemini returned no product details. Please try Smart Fill again.', true);
  if (text.length > 100000) throw aiError('AI_INVALID_RESPONSE', 'Gemini returned an unreadable answer. Please try Smart Fill again.', true);
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
    return raw;
  } catch { throw aiError('AI_INVALID_RESPONSE', 'Gemini returned an unreadable answer. Please try Smart Fill again.', true); }
}

async function generateGeminiJson({ parts, signal, timeoutMs = 60000, maxOutputTokens = 8192, temperature = 0 }) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw aiError('AI_KEY_MISSING', 'The Gemini API key is missing. Configure it in the backend and restart the backend.');
  const configured = String(process.env.GEMINI_MODEL || '').trim().replace(/^models\//, '').slice(0, 100);
  const cache = cacheFor(key, configured);
  const models = [...new Set([cache.preferred, configured, ...FALLBACK_MODELS].filter(Boolean))].filter(model => !cache.unavailable.has(model));
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let lastError = aiError('AI_MODEL_UNAVAILABLE', 'No supported Gemini model is currently available. Check your project model access, then retry.');
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: requestSignal,
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature, responseMimeType: 'application/json', maxOutputTokens } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(response.status, payload);
      const raw = parseResponse(payload);
      cache.preferred = model;
      return { raw, model };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw aiError('AI_TIMEOUT', 'Gemini took too long to respond. Your product details are unchanged; try Smart Fill again shortly.');
      }
      if (!error.contextCode) throw aiError('AI_CONNECTION_FAILED', 'The backend could not connect to Gemini. Check its internet connection and retry.');
      lastError = error;
      if (error.contextCode === 'AI_MODEL_UNAVAILABLE') cache.unavailable.add(model);
      if (!error.retryModel) throw error;
    }
  }
  throw lastError;
}

module.exports = { generateGeminiJson, aiError };
