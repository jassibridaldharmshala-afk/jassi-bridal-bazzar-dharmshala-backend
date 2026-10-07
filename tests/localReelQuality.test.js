const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs/promises'); const path = require('node:path'); const ffmpeg = require('ffmpeg-static');
const { run } = require('../services/productFrameSelection.service');
test('uploaded reels use measured scores, retain photo metadata, and clean temporary media', {timeout:30000}, async(t)=>{
  const previous=process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  const root=path.resolve(__dirname,'../../.tmp');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'local-reel-quality-'));
  t.after(async()=>{if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;if(path.dirname(path.resolve(directory))===root&&path.basename(directory).startsWith('local-reel-quality-'))await fs.rm(directory,{recursive:true,force:true});});
  const video=path.join(directory,'clip.mp4');
  await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x480:rate=10:duration=5','-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,2)'",'-pix_fmt','yuv420p',video]);
  const storage=require('../services/mediaStorage.service');const progress=require('../services/reelImportProgress.service');const uploaded=[];
  t.mock.method(storage,'getStorageProvider',()=> 'r2');
  t.mock.method(storage,'downloadObject',async(source,destination)=>fs.copyFile(video,destination));
  t.mock.method(storage,'uploadGeneratedImage',async(file)=>{uploaded.push({path:file.path,bytes:(await fs.stat(file.path)).size});return{provider:'r2',storageKey:file.originalname,url:'https://example.test/'+file.originalname};});
  const updates=t.mock.method(progress,'updateActiveRunProgress',async()=>true);
  delete require.cache[require.resolve('../services/localReelProcessor.service')];
  const {processReelLocally}=require('../services/localReelProcessor.service');
  const result=await processReelLocally({_id:'0123456789abcdef01234567',sourceVideo:{provider:'r2',storageKey:'fixture',mimeType:'video/mp4'}},{runId:'isolated-test'});
  assert.ok(result.statistics.extractedFrames>=10);assert.ok(result.statistics.rejectedFrames>0);
  assert.ok(result.candidates.length>0);assert.ok(updates.mock.callCount()>0);
  const frames=result.candidates.flatMap(candidate=>candidate.frames);
  assert.ok(frames.every(frame=>frame.timestampSeconds>=2&&frame.selectionVersion==='quality-v1'&&frame.qualityScore>0));
  assert.ok(frames.every(frame=>frame.width===320&&frame.height===480));
  assert.ok(uploaded.every(file=>file.bytes>0));
  for(const file of uploaded)await assert.rejects(fs.stat(file.path),{code:'ENOENT'});
});

test('whole-reel context keeps one product together and carries its sourced price', { timeout: 40000 }, async (t) => {
  const previous = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'isolated-context-fixture';
  const root = path.resolve(__dirname, '../../.tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'local-context-quality-'));
  t.after(async () => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; if (path.dirname(path.resolve(directory)) === root && path.basename(directory).startsWith('local-context-quality-')) await fs.rm(directory, { recursive: true, force: true }); });
  const video = path.join(directory, 'clip.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x480:rate=10:duration=7', '-pix_fmt', 'yuv420p', video]);
  const storage = require('../services/mediaStorage.service'); const progress = require('../services/reelImportProgress.service');
  t.mock.method(storage, 'getStorageProvider', () => 'r2');
  t.mock.method(storage, 'downloadObject', async (source, destination) => fs.copyFile(video, destination));
  t.mock.method(storage, 'uploadGeneratedImage', async (file) => ({ provider: 'r2', storageKey: file.originalname, url: 'https://example.test/' + file.originalname }));
  t.mock.method(progress, 'updateActiveRunProgress', async () => true);
  t.mock.method(require('../models/Category'), 'find', () => ({ select: () => ({ lean: async () => [{ _id: 'sarees', name: 'Sarees' }] }) }));
  t.mock.method(require('../services/masterConfigurationService'), 'readConfiguration', async () => ({ structure: { attributes: [] } }));
  let contextCalls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    const parts = JSON.parse(options.body).contents[0].parts;
    let response;
    if (parts[0].text.startsWith('Review these video frames')) {
      response = { frames: parts.filter((part) => part.text?.startsWith('Frame id: ')).map((part) => ({ id: part.text.slice(10), viewType: 'front', productVisible: true, fullProduct: true, obstructed: false, textOverlay: false })) };
    } else {
      contextCalls++;
      response = { name: 'Wine Saree', category: 'sarees', multipleProducts: false, priceAmbiguous: false, currency: 'INR', price: 1299, fieldSources: { price: { source: 'speech', quote: 'Price is 1299 rupees' } }, sizingMode: 'free-size' };
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }] }) };
  });
  delete require.cache[require.resolve('../services/localReelProcessor.service')];
  const { processReelLocally } = require('../services/localReelProcessor.service');
  const result = await processReelLocally({ _id: '0123456789abcdef01234567', sourceVideo: { provider: 'r2', storageKey: 'fixture', mimeType: 'video/mp4' } }, { runId: 'isolated-test' });
  assert.equal(result.candidates.length, 1); assert.equal(result.statistics.detectedProducts, 1);
  assert.ok(result.candidates[0].frames.length > 3); assert.ok(result.candidates[0].frames.length <= 20);
  assert.equal(result.candidates[0].suggestions.price, 1299); assert.equal(result.candidates[0].suggestions.fieldSources.price.source, 'speech');
  assert.equal(result.candidates[0].suggestions.stock, undefined); assert.equal(contextCalls, 1);
});
