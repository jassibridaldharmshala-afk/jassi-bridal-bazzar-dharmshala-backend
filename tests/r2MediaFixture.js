const http = require('node:http');
const { S3Client } = require('@aws-sdk/client-s3');

// Isolated in-memory object storage. No provider credentials or network writes.
function r2MediaFixture(test) {
  const objects = new Map(); let listener, url, puts = 0, failAt = 0;
  const nativeSend = S3Client.prototype.send;
  const configure = () => Object.assign(process.env, { R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-key', R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-bucket', R2_PUBLIC_URL: url });
  test.before(async () => {
    listener = http.createServer((req, res) => {
      const object = objects.get(decodeURIComponent(new URL(req.url, 'http://fixture').pathname.slice(1)));
      if (!object) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': object.type, 'content-length': object.bytes.length }); res.end(object.bytes);
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    url = `http://127.0.0.1:${listener.address().port}`;
    S3Client.prototype.send = async function(command) {
      const input = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        puts++; if (puts === failAt) throw new Error('fixture storage unavailable');
        const chunks = []; if (Buffer.isBuffer(input.Body)) chunks.push(input.Body); else for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
        objects.set(input.Key, { bytes: Buffer.concat(chunks), type: input.ContentType, metadata: input.Metadata }); return {};
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        if (!objects.has(input.Key)) { const error = new Error('missing fixture object'); error.name = 'NotFound'; throw error; }
        return {};
      }
      if (command.constructor.name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
      throw new Error('Unexpected fixture storage command: ' + command.constructor.name);
    };
  });
  test.beforeEach(() => { objects.clear(); puts = 0; failAt = 0; configure(); });
  test.after(async () => { S3Client.prototype.send = nativeSend; listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
  return { objects, get url() { return url; }, get puts() { return puts; }, bytes: key => objects.get(key)?.bytes, bytesFromUrl: value => objects.get(decodeURIComponent(new URL(value).pathname.slice(1)))?.bytes,
    configure, disable() { for (const key of Object.keys(process.env)) if (key.startsWith('R2_')) delete process.env[key]; }, failNextPut() { failAt = puts + 1; } };
}
module.exports = { r2MediaFixture };
