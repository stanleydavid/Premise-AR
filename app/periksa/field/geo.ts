/** Geodesy and compass helpers for the field view (pure, no DOM). */
export type LatLng = { lat: number; lng: number };

const RE = 6371000;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export function dist(a: LatLng, b: LatLng) {
  const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * RE * Math.asin(Math.sqrt(s));
}

export function bearing(a: LatLng, b: LatLng) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lng - a.lng) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function move(p: LatLng, brgDeg: number, m: number): LatLng {
  const b = brgDeg * D2R;
  return { lat: p.lat + (m * Math.cos(b) / RE) * R2D, lng: p.lng + (m * Math.sin(b) / (RE * Math.cos(p.lat * D2R))) * R2D };
}

export const n180 = (a: number) => ((a % 360) + 540) % 360 - 180;
export const n360 = (a: number) => ((a % 360) + 360) % 360;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const CARD = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
export const cardinal = (h: number) => CARD[Math.round(n360(h) / 45) % 8];

export function relWord(rel: number) {
  const a = Math.abs(rel), side = rel < 0 ? 'kiri' : 'kanan';
  if (a < 22.5) return 'di depan';
  if (a < 67.5) return `depan ${side}`;
  if (a < 112.5) return `sebelah ${side}`;
  if (a < 157.5) return `belakang ${side}`;
  return 'di belakang';
}

/** W3C DeviceOrientation spec: heading of the device's back (camera) from alpha/beta/gamma. */
export function compassHeading(alpha: number, beta: number, gamma: number) {
  const x = beta * D2R, y = gamma * D2R, z = alpha * D2R;
  const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const Vx = -cZ * sY - sZ * sX * cY, Vy = -sZ * sY + cZ * sX * cY;
  let h = Math.atan(Vx / Vy);
  if (Vy < 0) h += Math.PI; else if (Vx < 0) h += 2 * Math.PI;
  return h * R2D;
}
