import jsQR from 'jsqr';
import decodeJPEG from 'jpeg-js/lib/decoder.js';
import { inflate } from 'pako';

function pngPixels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width, height, depth, color, interlace, palette, transparency;
  const chunks = [];
  while (pos + 12 <= bytes.length) {
    const length = view.getUint32(pos), type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (length > bytes.length - pos - 12) throw new Error('Invalid PNG image');
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color];
  if (!width || !height || width * height > 4000000 || !channels || interlace || ![1, 2, 4, 8].includes(depth) || (color !== 0 && color !== 3 && depth !== 8)) throw new Error('Unsupported PNG image');
  const packed = new Uint8Array(chunks.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const chunk of chunks) { packed.set(chunk, at); at += chunk.length; }
  const raw = inflate(packed), stride = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, Math.ceil(channels * depth / 8));
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG image data');
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? rows[y * stride + x - bpp] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const corner = y && x >= bpp ? rows[(y - 1) * stride + x - bpp] : 0;
      const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner) : 0;
      rows[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = y * stride + Math.floor(x * channels * depth / 8), dest = (y * width + x) * 4;
    const sample = depth === 8 ? rows[source] : (rows[source] >> (8 - depth - (x * depth % 8))) & ((1 << depth) - 1);
    if (color === 0 || color === 4) rgba[dest] = rgba[dest + 1] = rgba[dest + 2] = Math.round(sample * 255 / ((1 << depth) - 1));
    else if (color === 3) {
      if (!palette || sample * 3 + 2 >= palette.length) throw new Error('Invalid PNG palette');
      rgba[dest] = palette[sample * 3]; rgba[dest + 1] = palette[sample * 3 + 1]; rgba[dest + 2] = palette[sample * 3 + 2];
    } else { rgba[dest] = rows[source]; rgba[dest + 1] = rows[source + 1]; rgba[dest + 2] = rows[source + 2]; }
    rgba[dest + 3] = color === 4 ? rows[source + 1] : color === 6 ? rows[source + 3] : color === 3 && transparency && sample < transparency.length ? transparency[sample] : 255;
  }
  return { data: rgba, width, height };
}

export async function decodeQR(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let image;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) image = pngPixels(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) image = decodeJPEG(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4 });
  else throw new Error('Unsupported QR image format');
  const qr = jsQR(image.data, image.width, image.height);
  if (!qr?.data) throw new Error('Could not read the login QR code');
  return qr.data;
}
