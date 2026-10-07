const test = require('node:test');
const assert = require('node:assert/strict');
const { generateGeminiJson } = require('../services/geminiJson.service');

const parts = [{ text: 'Synthetic catalog fixture. No real product data.' }];
const reply = (status, payload = {}) => ({ status, ok: status === 200, json: async () => payload });
const success = (text = '{"name":"Fixture saree"}', extra = {}) => reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] }, ...extra }] });
function setup(t) {
  const original = { key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  process.env.GEMINI_API_KEY = 'fixture-' + t.name; process.env.GEMINI_MODEL = 'fixture-retired';
  t.after(() => {
    for (const [name, value] of [['GEMINI_API_KEY', original.key], ['GEMINI_MODEL', original.model]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test('retired and overloaded models fall back to supported Flash and reuse the working model', async (t) => {
  setup(t); const requested = []; const signals = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const model = url.split('/models/')[1].split(':')[0]; requested.push(model); signals.push(options.signal);
    assert.ok(!url.includes('key=')); assert.equal(options.headers['x-goog-api-key'], process.env.GEMINI_API_KEY);
    assert.deepEqual(JSON.parse(options.body).contents[0].parts, parts);
    if (model === 'fixture-retired') return reply(404);
    if (model === 'gemini-flash-latest') return reply(503);
    return success();
  });
  const result = await generateGeminiJson({ parts });
  assert.equal(result.raw.name, 'Fixture saree'); assert.equal(result.model, 'gemini-flash-lite-latest');
  assert.deepEqual(requested, ['fixture-retired', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
  assert.ok(signals.every(signal => signal === signals[0]), 'All fallbacks share one timeout budget');
  assert.equal(process.env.GEMINI_MODEL, 'fixture-retired');
  await generateGeminiJson({ parts });
  assert.deepEqual(requested.slice(3), ['gemini-flash-lite-latest']);
  process.env.GEMINI_API_KEY = 'changed-fixture-key';
  await generateGeminiJson({ parts });
  assert.deepEqual(requested.slice(4), ['fixture-retired', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
});

test('unavailable models produce a configuration error with bounded attempts', async (t) => {
  setup(t); const request = t.mock.method(global, 'fetch', async () => reply(404));
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_MODEL_UNAVAILABLE' });
  assert.equal(request.mock.callCount(), 3);
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_MODEL_UNAVAILABLE' });
  assert.equal(request.mock.callCount(), 3, 'Recently retired versions are not requested again');
});

test('quota, denied keys and invalid requests do not spend more requests on other models', async (t) => {
  setup(t); const request = t.mock.method(global, 'fetch', async () => reply(429));
  for (const [status, code, message] of [[429, 'AI_QUOTA_EXCEEDED'], [403, 'AI_ACCESS_DENIED'], [400, 'AI_ACCESS_DENIED', 'API key not valid'], [400, 'AI_REQUEST_REJECTED', 'Invalid media']]) {
    request.mock.mockImplementation(async () => reply(status, { error: { message } }));
    const before = request.mock.callCount();
    await assert.rejects(generateGeminiJson({ parts }), { contextCode: code });
    assert.equal(request.mock.callCount(), before + 1);
  }
});

test('structured replies exclude thinking parts and tolerate a JSON code fence', async (t) => {
  setup(t);
  t.mock.method(global, 'fetch', async () => success('', { content: { parts: [{ thought: true, text: 'Not product JSON' }, { text: '```json\n{"name":"Fixture saree"}\n```' }] } }));
  assert.equal((await generateGeminiJson({ parts })).raw.name, 'Fixture saree');
});

test('a leaked key has an actionable safe message and never retries other models', async (t) => {
  setup(t);
  const request = t.mock.method(global, 'fetch', async () => reply(403, { error: { message: 'Your API key was reported as leaked. Please use another API key. ' + process.env.GEMINI_API_KEY } }));
  await assert.rejects(generateGeminiJson({ parts }), error => {
    assert.equal(error.contextCode, 'AI_ACCESS_DENIED');
    assert.match(error.message, /reported as leaked/);
    assert.match(error.message, /replacement key in Google AI Studio/);
    assert.match(error.message, /restart the backend/);
    assert.ok(!error.message.includes(process.env.GEMINI_API_KEY));
    assert.equal(error.retryModel, false);
    return true;
  });
  assert.equal(request.mock.callCount(), 1);
  request.mock.mockImplementation(async () => reply(403, { error: { message: 'Project access denied' } }));
  await assert.rejects(generateGeminiJson({ parts }), error => error.contextCode === 'AI_ACCESS_DENIED' && !error.message.includes('leaked'));
});

test('truncated and invalid answers are never accepted as complete product details', async (t) => {
  setup(t); const request = t.mock.method(global, 'fetch', async () => success('{"name":"Partial"}', { finishReason: 'MAX_TOKENS' }));
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_RESPONSE_INCOMPLETE' });
  assert.equal(request.mock.callCount(), 3);
  request.mock.mockImplementation(async () => success('{broken'));
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_INVALID_RESPONSE' });
});

test('provider blocking does not retry or suggest that clearer photos will fix it', async (t) => {
  setup(t); const request = t.mock.method(global, 'fetch', async () => reply(200, { promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_CONTENT_BLOCKED' });
  assert.equal(request.mock.callCount(), 1);
});

test('connection failures and timeouts have distinct safe messages', async (t) => {
  setup(t); const request = t.mock.method(global, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_CONNECTION_FAILED' });
  request.mock.mockImplementation(async () => { throw Object.assign(new Error('Timeout'), { name: 'TimeoutError' }); });
  await assert.rejects(generateGeminiJson({ parts }), { contextCode: 'AI_TIMEOUT' });
  assert.equal(request.mock.callCount(), 2);
});

test('caller cancellation propagates without falling back', async (t) => {
  setup(t); const controller = new AbortController(); const reason = new Error('Cancelled');
  const request = t.mock.method(global, 'fetch', async () => { controller.abort(reason); throw reason; });
  await assert.rejects(generateGeminiJson({ parts, signal: controller.signal }), error => error === reason);
  assert.equal(request.mock.callCount(), 1);
});
