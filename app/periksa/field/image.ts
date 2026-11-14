/**
 * Evidence photos: grab the camera frame (or a picked file), shrink to ≤ 1600 px, stamp the facts in
 * the image itself, and encode JPEG. The server keeps the same facts as metadata and the SHA-256.
 */
const MAX_SIDE = 1600;

export type Stamp = string[];

function stampAndEncode(source: CanvasImageSource, sw: number, sh: number, stamp: Stamp): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);
  const fs = Math.max(14, Math.round(w / 42)), lh = Math.round(fs * 1.3), band = lh * stamp.length + fs;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h - band, w, band);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  stamp.forEach((t, i) => ctx.fillText(t, fs * 0.8, h - band + fs * 0.5 + i * lh, w - fs * 1.6));
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('ENCODE_FAILED'))), 'image/jpeg', 0.82));
}

export function captureFromVideo(video: HTMLVideoElement, stamp: Stamp) {
  if (!video.videoWidth) return Promise.reject(new Error('CAMERA_NOT_READY'));
  return stampAndEncode(video, video.videoWidth, video.videoHeight, stamp);
}

export async function captureFromFile(file: File, stamp: Stamp) {
  const bitmap = await createImageBitmap(file);
  try { return await stampAndEncode(bitmap, bitmap.width, bitmap.height, stamp); } finally { bitmap.close(); }
}
