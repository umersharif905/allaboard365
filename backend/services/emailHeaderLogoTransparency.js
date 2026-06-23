/**
 * Prepare logo bytes for inline email (CID). True RGBA PNGs are sent unchanged.
 * JPEG or opaque PNG (no alpha) get edge flood-fill so near-black matte becomes transparent.
 */
const sharp = require('sharp');

const DEFAULT_RGB_MAX = 14;

function isBackgroundBlack(data, i, rgbMax) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return r <= rgbMax && g <= rgbMax && b <= rgbMax;
}

async function edgeFloodTransparentBackground(inputBuf, opts = {}) {
  const rgbMax = opts.rgbMax ?? DEFAULT_RGB_MAX;
  const { data, info } = await sharp(inputBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  if (ch !== 4) {
    return sharp(inputBuf).png().toBuffer();
  }

  const idx = (x, y) => (y * w + x) * ch;
  const visited = new Uint8Array(w * h);
  const q = [];

  for (let x = 0; x < w; x++) {
    q.push(x, 0, x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    q.push(0, y, w - 1, y);
  }

  let qi = 0;
  while (qi < q.length) {
    const x = q[qi++];
    const y = q[qi++];
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const p = y * w + x;
    if (visited[p]) continue;
    const i = idx(x, y);
    if (!isBackgroundBlack(data, i, rgbMax)) continue;
    visited[p] = 1;
    data[i + 3] = 0;
    q.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * @param {Buffer} fileBuf — contents of sharewell-partners-logo.png (may be JPEG mislabeled)
 * @returns {Promise<Buffer>} PNG suitable for inline image/png attachment
 */
async function prepareInlineEmailHeaderBuffer(fileBuf) {
  const meta = await sharp(fileBuf).metadata();
  if (meta.format === 'png' && meta.hasAlpha) {
    return fileBuf;
  }
  return edgeFloodTransparentBackground(fileBuf);
}

module.exports = {
  edgeFloodTransparentBackground,
  prepareInlineEmailHeaderBuffer,
  DEFAULT_RGB_MAX
};
