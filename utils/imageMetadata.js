// Strip identifying container metadata without touching compressed image samples.
function jpeg(source) {
  const chunks = [source.subarray(0, 2)]; let position = 2, changed = false;
  while (position < source.length) {
    if (source[position] !== 0xff) throw new Error('Invalid JPEG segment.');
    const start = position; while (source[position] === 0xff) position++;
    const marker = source[position++];
    if (marker === 0xda || marker === 0xd9) { chunks.push(source.subarray(start)); break; }
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { chunks.push(source.subarray(start, position)); continue; }
    const length = source.readUInt16BE(position), end = position + length;
    if (length < 2 || end > source.length) throw new Error('Invalid JPEG metadata.');
    const payload = source.subarray(position + 2, end);
    const app = marker >= 0xe0 && marker <= 0xef;
    const preserve = marker === 0xe0 || marker === 0xee && payload.subarray(0, 5).toString() === 'Adobe'
      || marker === 0xe2 && payload.subarray(0, 12).toString() === 'ICC_PROFILE\0';
    if (marker === 0xfe || app && !preserve) changed = true;
    else chunks.push(source.subarray(start, end));
    position = end;
  }
  return changed ? Buffer.concat(chunks) : source;
}
function png(source) {
  const chunks = [source.subarray(0, 8)]; let position = 8, changed = false;
  while (position < source.length) {
    const length = source.readUInt32BE(position), end = position + length + 12;
    if (end > source.length) throw new Error('Invalid PNG chunk.');
    const type = source.toString('ascii', position + 4, position + 8);
    if (['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type)) changed = true;
    else chunks.push(source.subarray(position, end));
    position = end;
  }
  return changed ? Buffer.concat(chunks) : source;
}
function webp(source) {
  const chunks = []; let position = 12, changed = false;
  while (position < source.length) {
    const length = source.readUInt32LE(position + 4), end = position + length + 8 + length % 2;
    if (end > source.length) throw new Error('Invalid WebP chunk.');
    const type = source.toString('ascii', position, position + 4);
    if (['EXIF', 'XMP '].includes(type)) changed = true;
    else {
      let chunk = source.subarray(position, end);
      if (type === 'VP8X' && chunk[8] & 0x0c) { chunk = Buffer.from(chunk); chunk[8] &= ~0x0c; changed = true; }
      chunks.push(chunk);
    }
    position = end;
  }
  if (!changed) return source;
  const body = Buffer.concat(chunks), header = Buffer.from(source.subarray(0, 12));
  header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}
module.exports = { jpeg, png, webp };

