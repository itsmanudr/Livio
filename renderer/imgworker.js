'use strict';
importScripts('vendor/libheif-bundle.js');
let heif = null; const getHeif = () => (heif || (heif = libheif()));
async function decodeHeic(buf) {
  const dec = new (getHeif().HeifDecoder)(); const imgs = dec.decode(new Uint8Array(buf));
  if (!imgs || !imgs.length) throw new Error('HEIC non valido');
  const img = imgs[0], w = img.get_width(), h = img.get_height(), data = new ImageData(w, h);
  await new Promise((res, rej) => img.display(data, (r) => (r ? res() : rej(new Error('Decodifica HEIC fallita')))));
  try { if (img.free) img.free(); } catch (_) {}
  return createImageBitmap(data);
}
async function render(buf, ext, maxDim, q) {
  const bmp = (ext === 'heic' || ext === 'heif') ? await decodeHeic(buf) : (maxDim && maxDim <= 400 ? await createImageBitmap(new Blob([buf]), { resizeWidth: Math.round(maxDim * 1.5), resizeQuality: 'medium' }) : await createImageBitmap(new Blob([buf])));
  const s = maxDim ? Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) : 1;
  const cw = Math.max(1, Math.round(bmp.width * s)), ch = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(cw, ch), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, cw, ch); bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: q });
}
self.onmessage = async (e) => { const { id, buf, ext, maxDim, quality } = e.data;
  try { self.postMessage({ id, blob: await render(buf, ext, maxDim, quality) }); } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); } };
