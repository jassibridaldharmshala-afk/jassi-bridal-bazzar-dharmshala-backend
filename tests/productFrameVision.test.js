const test = require('node:test'); const assert = require('node:assert/strict');
const { normalizeReview, reviewFrameViews } = require('../services/productFrameVision.service');
test('view classification accepts only complete reviews for known frame IDs and boolean visibility', () => {
  const row={id:'known',viewType:'front',productVisible:true,fullProduct:true,obstructed:false,textOverlay:false};
  assert.equal(normalizeReview({frames:[row]},[{id:'known'}])[0].viewType,'front');
  assert.equal(normalizeReview({frames:[{...row,viewType:'made up view'}]},[{id:'known'}])[0].viewType,'unknown');
  for(const frames of [[{...row,id:'invented'}],[{...row,productVisible:'false'}],[]]) assert.throws(()=>normalizeReview({frames},[{id:'known'}]),/Incomplete/);
});
test('frame quality selection does not require AI credentials', async (t) => {
  const previous=process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  t.after(()=>{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;});
  assert.equal((await reviewFrameViews([{id:'a',path:'not-needed'}])).status,'unavailable');
});

test('optional view review sends actual photo bytes and falls back when the provider fails', async (t) => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fixture-only-key';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const bytes = Buffer.from('isolated photo fixture');
  t.mock.method(require('node:fs/promises'), 'readFile', async () => bytes);
  const frame = { id: 'photo', path: 'fixture.jpg' };
  const review = { id: 'photo', viewType: 'side', productVisible: true, fullProduct: true, obstructed: false, textOverlay: false };
  const request = t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.ok(!url.includes('fixture-only-key'));
    assert.equal(options.headers['x-goog-api-key'], 'fixture-only-key');
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[2].inlineData.data, bytes.toString('base64'));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ frames: [review] }) }] } }] }) };
  });
  assert.deepEqual(await reviewFrameViews([frame]), { status: 'completed', frames: [review] });
  request.mock.mockImplementation(async () => { throw new Error('Provider unavailable'); });
  assert.deepEqual(await reviewFrameViews([frame]), { status: 'failed', frames: [] });
});
