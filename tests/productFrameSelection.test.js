const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { measureFrame, rankFrames, visualDistance, selectProductFrames, run, SIDE } = require('../services/productFrameSelection.service');

function pixels(value) {
  const buffer = Buffer.alloc(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
    const color = value(x, y); const index = (y * SIDE + x) * 3;
    for (let c = 0; c < 3; c++) buffer[index + c] = Array.isArray(color) ? color[c] : color;
  }
  return buffer;
}
const textured = (x, y) => (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 180 : 50;

test('measured focus separates clear edges from smooth/blurred images', () => {
  const clear = measureFrame(pixels(textured));
  const soft = measureFrame(pixels((x) => 80 + x / 3));
  assert.ok(clear.sharpnessScore > soft.sharpnessScore + .4);
  assert.deepEqual(clear.rejectionReasons, []);
  assert.ok(soft.rejectionReasons.includes('Too blurry'));
});
test('black, overexposed and detail-free frames are rejected', () => {
  assert.ok(measureFrame(pixels(() => 0)).rejectionReasons.includes('Too dark'));
  assert.ok(measureFrame(pixels(() => 255)).rejectionReasons.includes('Overexposed'));
  assert.ok(measureFrame(pixels(() => 127)).rejectionReasons.includes('Too little visible detail'));
});
test('near duplicates retain the clearer frame and do not merge different garment colours', () => {
  const a = measureFrame(pixels((x, y) => [textured(x, y), 30, 50]));
  const b = measureFrame(pixels((x, y) => [30, textured(x, y), 50]));
  assert.equal(visualDistance(a.signature, a.signature), 0);
  const result = rankFrames([{...a,id:'soft-copy',qualityScore:.6,timestampSeconds:1}, {...a,id:'clear-copy',qualityScore:.9,timestampSeconds:2}, {...b,id:'other-colour',qualityScore:.8,timestampSeconds:3}]);
  assert.equal(result.statistics.duplicateFrames, 1);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].id, 'clear-copy');
  assert.equal(result.frames[0].recommendedCover, true);
});
test('an entirely unusable video does not receive a fake recommended photo', () => {
  const dark = measureFrame(pixels(() => 0));
  const result = rankFrames([{ ...dark, id:'black', timestampSeconds:0 }]);
  assert.deepEqual(result.frames, []); assert.equal(result.statistics.rejectedFrames, 1);
});
test('cover suggestions favour a well-framed view without promoting a much softer photo', () => {
  const frame={...measureFrame(pixels(textured)),rejectionReasons:[],timestampSeconds:1};
  const result=rankFrames([
    {...frame,id:'close-up',qualityScore:.98,framingScore:.15,signature:new Float32Array(768).fill(20)},
    {...frame,id:'wider',qualityScore:.94,framingScore:.9,signature:new Float32Array(768).fill(80)},
    {...frame,id:'soft-wide',qualityScore:.4,framingScore:1,signature:new Float32Array(768).fill(140)},
  ]);
  assert.equal(result.frames.find(item=>item.recommendedCover).id,'wider');
});

test('real video scan skips blur/darkness, reads the end of long clips, and saves original-aspect photos', {timeout:120000}, async (t) => {
  const root = path.resolve(__dirname, '../../.tmp'); await fs.mkdir(root,{recursive:true});
  const directory = await fs.mkdtemp(path.join(root,'frame-quality-test-'));
  try {
    const video = path.join(directory,'mixed.mp4');
    await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x480:rate=10:duration=12',
      '-vf',"boxblur=8:2:enable='lt(t,3)',drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,6,8.9)'",'-pix_fmt','yuv420p',video]);
    const result = await selectProductFrames(video,directory,{maxFrames:8,recommendedCount:4,semantic:false});
    assert.ok(result.statistics.analyzedFrames >= 30);
    assert.ok(result.statistics.rejectedFrames > 8);
    assert.ok(result.frames.length > 0);
    assert.ok(result.frames.every(frame=>frame.timestampSeconds>=3 && !(frame.timestampSeconds>=6 && frame.timestampSeconds<9)), JSON.stringify(result.frames.map(f=>[f.timestampSeconds,f.qualityScore])));
    assert.ok(result.frames.every(frame=>frame.width===320 && frame.height===480));
    assert.ok(result.frames.some(frame=>frame.recommendedCover));
    for(const frame of result.frames) assert.ok((await fs.stat(frame.path)).size>0);

    const longVideo = path.join(directory,'late-product.mp4');
    await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:size=320x480:rate=5:duration=54',
      '-f','lavfi','-i','testsrc2=size=320x480:rate=5:duration=6','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-pix_fmt','yuv420p',longVideo]);
    const late = await selectProductFrames(longVideo,directory,{maxFrames:4,recommendedCount:3,semantic:false});
    assert.ok(late.frames.length>0,'A product appearing after 48 seconds must still be found');
    assert.ok(late.frames.every(frame=>frame.timestampSeconds>=54));
    assert.ok(late.statistics.rejectedFrames>100);
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(selectProductFrames(video,directory,{signal:cancelled.signal}),/cancelled/i);
  } finally {
    if(path.dirname(path.resolve(directory))===root && path.basename(directory).startsWith('frame-quality-test-')) await fs.rm(directory,{recursive:true,force:true});
  }
});
