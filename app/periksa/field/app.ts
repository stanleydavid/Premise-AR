/**
 * Field view controller (framework-free: a 60 fps camera overlay is easier to keep smooth outside React).
 * Ported from the prototype; data now comes from /api/v1 and every record goes through the offline outbox.
 */
import { bearing, cardinal, clamp, compassHeading, CARD, D2R, dist, move, n180, n360, R2D, relWord, type LatLng } from './geo';
import { captureFromFile, captureFromVideo } from './image';
import {
  allRecords, allSent, cacheGet, cachePut, errorMessage, newKey, outboxState, putRecord, retryRecord, syncNow,
  type OutboxRecord, type PhotoDraft, type SyncState,
} from './outbox';

// ------------------------------------------------------------------------------------------ types
export type FieldOptions = {
  userId: string; displayName: string; roleLabel: string;
  canInspect: boolean; canReadAll: boolean;
  training: { enabled: boolean; lat: number; lng: number };
};
type StatusDisplay = { key: 'ok' | 'warn' | 'bad'; code: string; label: string; days: number | null };
type Premise = {
  id: string; trade_name: string; registered_name: string | null; address: string | null; floor: number;
  lat: number; lng: number; distance_m: number; location_source: string;
  licence: null | { id: string; licence_no: string; type_code: string; status: string; valid_until: string; conditions: string[];
    outstanding_compound_sen: number; display: StatusDisplay };
  last_inspection: null | { observed_at: string; outcome: string };
};
type Rule = { id: string; type_code: string | null; text: string; kind: 'visual' | 'manual'; is_example: boolean };
type RuleSet = { types: Array<{ code: string; name: string }>; rules: Rule[] };
type Nearby = { premises: Premise[]; center: LatLng; radius: number; fetched_at: string };
type Answer = 'patuh' | 'tidak_patuh' | 'tb';
type Draft = { results: Record<string, Answer>; notes: string; photos: PhotoDraft[] };
type Projected = { p: Premise; d: number; rel: number; elev: number; x: number; y: number };
type LabelEl = HTMLButtonElement & { _w: number; _h: number; _d?: string };

const FETCH_RADIUS = 300, REFETCH_MOVE_M = 100, REFETCH_AGE_MS = 5 * 60_000;
const EYE = 1.5, FLOOR_H = 3.6;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const TZ = 'Asia/Kuala_Lumpur';
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('ms-MY', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t: string | number) => new Date(t).toLocaleString('ms-MY', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const rm = (sen: number) => `RM ${(sen / 100).toLocaleString('ms-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const OUTCOME_LABEL: Record<string, string> = { patuh: 'Patuh', tidak_patuh: 'Tidak patuh', belum_lengkap: 'Belum lengkap' };
const LS = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(`semak.${k}`); return v == null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(`semak.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

export function startFieldApp(root: HTMLElement, opts: FieldOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const stage = $('#stage'), video = $<HTMLVideoElement>('#cam'), sim = $<HTMLCanvasElement>('#sim'), layer = $('#labels');
  const radar = $<HTMLCanvasElement>('#radar'), sheet = $('#sheet'), sheetBody = $('#sheetBody'), scrim = $('#scrim');
  const disposers: Array<() => void> = [];
  const on = <K extends keyof WindowEventMap>(t: Window | Document | HTMLElement, type: K | string, fn: (e: never) => void, o?: AddEventListenerOptions | boolean) => {
    t.addEventListener(type, fn as EventListener, o); disposers.push(() => t.removeEventListener(type, fn as EventListener, o));
  };

  const S = {
    mode: null as null | 'field' | 'training',
    camera: false, cameraErr: null as null | 'denied' | 'failed',
    pos: null as LatLng | null, acc: null as number | null, geoState: 'idle' as 'idle' | 'waiting' | 'ok' | 'denied' | 'unsupported',
    geoWatch: null as number | null, geoWaitFrom: 0,
    heading: 0, hx: 1, hy: 0, pitch: 0, hasCompass: false, manualHeading: false, compassAcc: null as number | null,
    nearby: null as Nearby | null, nearbyOffline: false, fetching: false, fetchError: null as string | null,
    rules: null as RuleSet | null,
    radius: LS.get('radius', 40), fovH: LS.get('fov', 60),
    types: null as Set<string> | null, onlyProblem: false, frozen: false,
    draft: null as Draft | null, dirty: false, selectedId: null as string | null,
    sync: { pending: 0, failed: 0, otherUser: 0, needsLogin: false, syncing: false, lastError: null } as SyncState,
    lastIn: 0,
  };
  const labels = new Map<string, LabelEl>();
  let toastTimer = 0;
  const toast = (msg: string, ms = 3200) => {
    const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
  };

  // ------------------------------------------------------------------------------ data
  const premises = () => S.nearby?.premises ?? [];
  const typeOf = (p: Premise) => p.licence?.type_code ?? null;
  const statusOf = (p: Premise): StatusDisplay => p.licence?.display ?? { key: 'bad', code: 'TIADA_LESEN', label: 'TIADA LESEN', days: null };
  const isProblem = (p: Premise) => statusOf(p).key !== 'ok' || (p.licence?.outstanding_compound_sen ?? 0) > 0;
  const typeName = (code: string | null) => S.rules?.types.find((t) => t.code === code)?.name ?? code ?? 'Tiada lesen';
  const rulesFor = (code: string | null) => (S.rules?.rules ?? []).filter((r) => r.type_code === null || r.type_code === code);

  async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { credentials: 'same-origin', ...init, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { S.sync.needsLogin = true; throw new Error('UNAUTHENTICATED'); }
    if (!res.ok) throw new Error(String(body.error ?? `HTTP_${res.status}`));
    return body.data as T;
  }

  async function loadRules() {
    try { S.rules = await api<RuleSet>('/api/v1/rules'); await cachePut('rules', S.rules).catch(() => undefined); }
    catch { S.rules = (await cacheGet<RuleSet>('rules').catch(() => undefined)) ?? S.rules; }
    if (!S.types && S.rules) S.types = new Set([...S.rules.types.map((t) => t.code), '']);
  }

  async function maybeFetchNearby(force = false) {
    if (!S.pos || S.fetching) return;
    const n = S.nearby;
    const stale = !n || S.nearbyOffline || dist(n.center, S.pos) > REFETCH_MOVE_M || Date.now() - Date.parse(n.fetched_at) > REFETCH_AGE_MS;
    if (!force && !stale) return;
    S.fetching = true;
    try {
      const data = await api<Nearby>(`/api/v1/premises/nearby?lat=${S.pos.lat.toFixed(6)}&lng=${S.pos.lng.toFixed(6)}&radius=${FETCH_RADIUS}`);
      S.nearby = data; S.nearbyOffline = false; S.fetchError = null;
      resetLabels();
      await cachePut('nearby', data).catch(() => undefined);
    } catch (error) {
      S.fetchError = (error as Error).message;
      if (!S.nearby) {
        const cached = await cacheGet<Nearby>('nearby').catch(() => undefined);
        if (cached && dist(cached.center, S.pos) < 2000) { S.nearby = cached; S.nearbyOffline = true; resetLabels(); }
      } else S.nearbyOffline = true;
    } finally {
      S.fetching = false;
    }
  }
  function resetLabels() { labels.forEach((el) => el.remove()); labels.clear(); }

  async function refreshSync(run = false) {
    S.sync = run ? await syncNow(opts.userId, (s) => { S.sync = s; renderSyncChip(); }) : { ...S.sync, ...(await outboxState(opts.userId)) };
    renderSyncChip();
  }

  // ------------------------------------------------------------------------------ start
  const lockStart = () => { $<HTMLButtonElement>('#goField').disabled = true; const g = root.querySelector<HTMLButtonElement>('#goSim'); if (g) g.disabled = true; };
  on($('#goField'), 'click', () => { lockStart(); $('#goField').textContent = 'Meminta kebenaran…'; void startField(); });
  const goSim = root.querySelector<HTMLElement>('#goSim');
  if (goSim) on(goSim, 'click', () => { lockStart(); startTraining(); });

  async function startField() {
    // iOS: the orientation permission must be asked inside the tap, before anything else is awaited.
    let oriGranted = true;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    try { if (DOE && typeof DOE.requestPermission === 'function') oriGranted = (await DOE.requestPermission()) === 'granted'; } catch { oriGranted = false; }
    $('#start').hidden = true;
    S.mode = 'field';
    void requestWakeLock();
    await openCamera();
    if (oriGranted) {
      const absEvt = 'ondeviceorientationabsolute' in window;
      on(window, absEvt ? 'deviceorientationabsolute' : 'deviceorientation', onOrientation as (e: never) => void, true);
    }
    window.setTimeout(() => {
      if (!S.hasCompass && S.mode === 'field') {
        S.manualHeading = true; $('#turn').hidden = false; $('#turn .fw').hidden = true; $('#turn .bk').hidden = true;
        toast('Kompas tidak tersedia. Seret skrin atau guna ◀ ▶ untuk pusing. Ketik chip LAPANGAN untuk butiran.', 5000);
      }
    }, 3000);
    startGps();
    startLoop();
  }

  function startTraining() {
    $('#start').hidden = true;
    S.mode = 'training'; S.camera = false; S.manualHeading = true;
    $('#turn').hidden = false;
    S.pos = { lat: opts.training.lat, lng: opts.training.lng }; S.acc = null; S.geoState = 'ok';
    setHeading(90, true);
    void maybeFetchNearby(true);
    startLoop();
    toast('Mod latihan: seret atau guna ◀ ▶ ▲ ▼. Semakan dalam mod ini tidak disimpan.', 5000);
  }

  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream; video.hidden = false; await video.play(); S.camera = true; S.cameraErr = null;
    } catch (e) {
      S.camera = false; video.hidden = true;
      S.cameraErr = (e as Error).name === 'NotAllowedError' ? 'denied' : 'failed';
      toast('Kamera tidak dapat dibuka. Paparan tanpa kamera digunakan.');
    }
  }
  function startGps() {
    if (!('geolocation' in navigator)) { S.geoState = 'unsupported'; return; }
    S.geoState = 'waiting'; S.geoWaitFrom = Date.now();
    if (S.geoWatch != null) navigator.geolocation.clearWatch(S.geoWatch);
    S.geoWatch = navigator.geolocation.watchPosition((p) => {
      if (S.mode !== 'field') return;
      S.geoState = 'ok'; S.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; S.acc = p.coords.accuracy;
      void maybeFetchNearby();
    }, (err) => {
      if (S.mode !== 'field') return;
      if (err.code === 1) S.geoState = 'denied'; else if (!S.pos) S.geoState = 'waiting';
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  disposers.push(() => { if (S.geoWatch != null) navigator.geolocation.clearWatch(S.geoWatch); (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop()); });

  function onOrientation(e: DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }) {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) { h = e.webkitCompassHeading; S.compassAcc = e.webkitCompassAccuracy ?? null; }
    else if (e.alpha != null && e.beta != null && e.gamma != null && (e.absolute || e.type === 'deviceorientationabsolute')) h = compassHeading(e.alpha, e.beta, e.gamma);
    if (h == null || S.manualHeading) return;
    if (!S.hasCompass) { S.hasCompass = true; setHeading(h, true); } else setHeading(h, false);
    if (e.beta != null) S.pitch = S.pitch * 0.8 + clamp(e.beta - 90, -60, 60) * 0.2;
  }
  function setHeading(h: number, hard: boolean) {
    const c = Math.cos(h * D2R), s = Math.sin(h * D2R);
    if (hard) { S.hx = c; S.hy = s; } else { S.hx = S.hx * 0.82 + c * 0.18; S.hy = S.hy * 0.82 + s * 0.18; }
    S.heading = n360(Math.atan2(S.hy, S.hx) * R2D);
  }
  let wakeLock: WakeLockSentinel | null = null;
  async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; } }
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode) { void requestWakeLock(); void refreshSync(true); } });
  disposers.push(() => { void wakeLock?.release().catch(() => undefined); });

  // ------------------------------------------------------------------------------ manual turning
  const turn = (d: number) => setHeading(S.heading + d, true);
  const walk = (m: number) => { if (S.mode === 'training' && S.pos) { S.pos = move(S.pos, S.heading, m); void maybeFetchNearby(); } };
  on($('#turn'), 'click', (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (a === 'tl') turn(-10); if (a === 'tr') turn(10); if (a === 'fw') walk(3); if (a === 'bk') walk(-3);
  });
  let drag: { x: number; h: number } | null = null;
  on(stage, 'pointerdown', (e: PointerEvent) => {
    if (!S.manualHeading || (e.target as HTMLElement).closest('button, #radar, nav')) return;
    drag = { x: e.clientX, h: S.heading }; stage.setPointerCapture(e.pointerId);
  });
  on(stage, 'pointermove', (e: PointerEvent) => {
    if (!drag) return;
    const f = (stage.clientWidth / 2) / Math.tan(S.fovH / 2 * D2R);
    setHeading(drag.h - Math.atan((e.clientX - drag.x) / f) * R2D, true);
  });
  on(stage, 'pointerup', () => { drag = null; });
  on(stage, 'pointercancel', () => { drag = null; });
  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !sheet.hidden) { closeSheet(); return; }
    if (!sheet.hidden || !S.manualHeading || (e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') turn(-5); else if (e.key === 'ArrowRight') turn(5);
    else if (e.key === 'ArrowUp') walk(2); else if (e.key === 'ArrowDown') walk(-2); else return;
    e.preventDefault();
  });

  // ------------------------------------------------------------------------------ render loop
  let looping = false, raf = 0, lastHud = 0;
  const startLoop = () => { if (!looping) { looping = true; raf = requestAnimationFrame(frame); } };
  disposers.push(() => cancelAnimationFrame(raf));
  function resizeCanvas(c: HTMLCanvasElement, w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return ctx;
  }
  const visibleSet = () => premises().filter((p) => (!S.types || S.types.has(typeOf(p) ?? '')) && (!S.onlyProblem || isProblem(p)));
  function project(p: Premise, W: number, H: number, f: number): Projected {
    const d = Math.max(1, dist(S.pos!, p));
    const rel = n180(bearing(S.pos!, p) - S.heading);
    const elev = Math.atan((p.floor * FLOOR_H + 3 - EYE) / d) * R2D;
    return { p, d, rel, elev, x: W / 2 + f * Math.tan(rel * D2R), y: H / 2 - f * Math.tan((elev - S.pitch) * D2R) };
  }
  function frame(ts: number) {
    raf = requestAnimationFrame(frame);
    if (S.frozen) { if (ts - lastHud > 250) { lastHud = ts; updateHud(S.lastIn); } return; }
    const W = stage.clientWidth, H = stage.clientHeight;
    const f = (W / 2) / Math.tan(S.fovH / 2 * D2R);
    const items = S.pos ? visibleSet().map((p) => project(p, W, H, f)) : [];
    const inR = items.filter((o) => o.d <= S.radius);
    if (!S.camera) drawSim(W, H, f, items); else if (sim.width) sim.width = 0;

    const placed: Array<{ x: number; y: number; w: number; h: number }> = []; const shown = new Set<string>(); let crowded = 0;
    inR.filter((o) => Math.abs(o.rel) < S.fovH / 2 + 6).sort((a, b) => a.d - b.d).forEach((o) => {
      if (placed.length >= 10) { crowded++; return; }
      const el = labelFor(o.p);
      const s = clamp(1.1 - o.d / 120, 0.66, 1.05);
      const w = el._w * s, h = el._h * s;
      const x = clamp(o.x - w / 2, 4, W - w - 4);
      let y = clamp(o.y, 80 + h, H - 90) - h - 8;
      for (let k = 0; k < 10; k++) {
        const hit = placed.find((r) => x < r.x + r.w + 4 && x + w + 4 > r.x && y < r.y + r.h + 4 && y + h + 4 > r.y);
        if (!hit) break;
        y = hit.y - h - 6;
      }
      if (y < 64) { crowded++; return; }
      placed.push({ x, y, w, h });
      const dTxt = `${Math.round(o.d)} m`;
      if (el._d !== dTxt) { el._d = dTxt; el.querySelector('.ds')!.textContent = dTxt; }
      el.style.transform = `translate(${(x - (el._w - w) / 2).toFixed(1)}px, ${(y - (el._h - h)).toFixed(1)}px) scale(${s.toFixed(3)})`;
      el.style.zIndex = String(1000 - Math.round(o.d));
      el.hidden = false; shown.add(o.p.id);
    });
    labels.forEach((el, id) => { if (!shown.has(id)) el.hidden = true; });
    const cr = $('#crowd') as HTMLButtonElement & { _n?: number }; cr.hidden = !crowded;
    if (crowded && cr._n !== crowded) { cr._n = crowded; cr.textContent = `+${crowded} premis lagi terlalu rapat · Senarai`; }

    const left = inR.filter((o) => o.rel < -S.fovH / 2 - 6).sort((a, b) => a.d - b.d);
    const right = inR.filter((o) => o.rel > S.fovH / 2 + 6).sort((a, b) => a.d - b.d);
    edge($('#edgeL'), left, '◀ '); edge($('#edgeR'), right, '', ' ▶');
    drawRadar(items);
    S.lastIn = inR.length;
    if (ts - lastHud > 250) { lastHud = ts; updateHud(inR.length); }
  }
  function edge(el: HTMLElement, arr: Projected[], pre: string, post = '') {
    el.hidden = !arr.length;
    if (arr.length) el.innerHTML = `<b>${pre}${arr.length} premis${post}</b>${esc(arr[0].p.trade_name)} · ${Math.round(arr[0].d)} m`;
  }
  function labelFor(p: Premise): LabelEl {
    const existing = labels.get(p.id);
    if (existing) return existing;
    const st = statusOf(p);
    const el = document.createElement('button') as LabelEl;
    el.type = 'button'; el.className = 'lbl'; el.dataset.st = st.key;
    el.innerHTML = `<span class="nm">${esc(p.trade_name)}</span><span class="mt"><span class="st">${esc(st.label)}</span>`
      + `<span>${esc(typeOf(p) ?? '—')}</span><span>Tkt ${p.floor ? esc(p.floor) : 'G'} · <span class="ds"></span></span>`
      + ((p.licence?.outstanding_compound_sen ?? 0) > 0 ? '<span class="cp">Kompaun</span>' : '') + '</span>';
    el.setAttribute('aria-label', `${p.trade_name}, ${st.label}, ${typeName(typeOf(p))}`);
    el.addEventListener('click', () => openPremise(p.id));
    el.hidden = false; layer.appendChild(el);
    el._w = el.offsetWidth || 176; el._h = el.offsetHeight || 54;
    el.hidden = true; labels.set(p.id, el);
    return el;
  }

  function updateHud(nIn: number) {
    const dot = $('#hGpsDot'), txt = $('#hGpsTxt');
    if (S.mode === 'training') { txt.textContent = 'Lokasi latihan'; dot.className = 'dot warn'; }
    else if (!S.pos) { txt.textContent = 'Mencari GPS…'; dot.className = 'dot'; }
    else { txt.textContent = `GPS ±${Math.round(S.acc ?? 0)} m`; dot.className = `dot ${(S.acc ?? 99) <= 15 ? 'ok' : (S.acc ?? 99) <= 30 ? 'warn' : 'bad'}`; }
    $('#hHead').textContent = `${String(Math.round(S.heading)).padStart(3, '0')}° ${cardinal(S.heading)}`;
    $('#hRadius').textContent = `${nIn} dalam ${S.radius} m`;
    let msg = '', act: null | { id: string; text: string } = null;
    if (S.frozen) msg = 'Paparan dibekukan. Ketik label untuk semak, atau ketik Bekukan untuk sambung.';
    else if (S.sync.needsLogin) { msg = `Sesi tamat. ${S.sync.pending} rekod menunggu untuk dihantar.`; act = { id: 'login', text: 'Log masuk semula' }; }
    else if (S.nearbyOffline && S.nearby) msg = `Tiada talian. Data premis dari ${fmtTime(S.nearby.fetched_at)}; semakan disimpan dalam telefon dan dihantar kemudian.`;
    else if (S.acc != null && S.acc > 25) msg = `Ketepatan GPS rendah (±${Math.round(S.acc)} m). Label mungkin tersasar beberapa kedai. Sahkan nama pada papan tanda.`;
    else if (S.compassAcc != null && S.compassAcc > 25) msg = 'Kompas kurang tepat. Gerakkan telefon dalam bentuk angka 8 untuk kalibrasi.';
    else if (S.pos && S.nearby && !nIn) {
      msg = `Tiada premis dalam ${S.radius} m.`;
      act = S.radius < 150 ? { id: 'grow', text: `Besarkan radius ke ${Math.min(150, S.radius * 2)} m` } : { id: 'list', text: 'Buka senarai' };
    } else if (S.pos && !S.nearby && S.fetchError) { msg = 'Data premis tidak dapat dimuatkan.'; act = { id: 'refetch', text: 'Cuba lagi' }; }
    const b = $('#banner'), bt = $('#bannerTxt'), ba = $<HTMLButtonElement>('#bannerAct');
    b.style.top = `${Math.round($('#hud').getBoundingClientRect().bottom + 8)}px`;
    b.hidden = !msg; if (bt.textContent !== msg) bt.textContent = msg;
    ba.hidden = !act; if (act && ba.dataset.act !== act.id + act.text) { ba.dataset.act = act.id + act.text; ba.textContent = act.text; ba.dataset.id = act.id; }
    const issues = deviceIssues().length, m = $('#hMode');
    const mt = (S.mode === 'training' ? 'LATIHAN' : 'LAPANGAN') + (issues ? ` · ${issues} isu` : '');
    if (m.textContent !== mt) { m.textContent = mt; m.classList.toggle('warnchip', !!issues); m.setAttribute('aria-label', `${mt}. Status peranti`); }
    renderState();
  }
  function deviceIssues() {
    if (S.mode !== 'field') return [];
    const out: string[] = [];
    if (!S.camera) out.push('camera'); if (S.geoState !== 'ok') out.push('gps'); if (!S.hasCompass) out.push('compass');
    return out;
  }
  function renderSyncChip() {
    const c = $('#hSync'), s = S.sync;
    const n = s.pending + s.failed;
    c.className = `chip sync-chip ${s.failed ? 'failed' : n ? 'pending' : 'ok'}`;
    c.innerHTML = `<span class="dot" aria-hidden="true"></span>${s.syncing ? 'Menghantar…' : n ? `${n} belum dihantar` : 'Semua dihantar'}`;
    $('#bLog').textContent = n ? `Log (${n})` : 'Log';
  }
  function renderState() {
    const el = $('#state') as HTMLElement & { dataset: DOMStringMap };
    let key = '', html = '';
    if (S.mode === 'field' && (S.geoState === 'denied' || S.geoState === 'unsupported')) {
      key = 'denied';
      html = `<h2>Lokasi tidak dibenarkan</h2><p>Aplikasi perlukan lokasi untuk mencari premis berdekatan.</p>
        <p><strong>iPhone:</strong> Tetapan → Privasi → Perkhidmatan Lokasi → Safari → Semasa Digunakan.<br>
        <strong>Android:</strong> ketik ikon kunci di bar alamat → Kebenaran → Lokasi → Benarkan.</p>
        <div class="btns"><button class="btn primary" type="button" data-state="reload">Muat semula selepas dibenarkan</button></div>`;
    } else if (S.mode === 'field' && !S.pos) {
      const secs = Math.round((Date.now() - (S.geoWaitFrom || Date.now())) / 1000);
      key = `wait${secs >= 15 ? 'long' : ''}`;
      html = `<h2><span class="spin" aria-hidden="true"></span>Mencari isyarat GPS…</h2>
        <p>Biasanya 5–20 saat. Berdiri di kawasan terbuka, jauh dari bumbung dan bangunan tinggi.</p><p class="secs" aria-hidden="true">${secs} s</p>`
        + (secs >= 15 ? '<p>Masih tiada isyarat. Pastikan Lokasi telefon dihidupkan.</p>' : '');
      if (el.dataset.key === key) { const sc = el.querySelector('.secs'); if (sc) sc.textContent = `${secs} s`; return; }
    } else if (S.pos && !S.nearby && S.fetching) {
      key = 'loading'; html = '<h2><span class="spin" aria-hidden="true"></span>Memuatkan premis berdekatan…</h2>';
    }
    if (!key) { el.hidden = true; el.dataset.key = ''; return; }
    if (el.dataset.key !== key) { el.dataset.key = key; el.innerHTML = html; }
    el.hidden = false;
  }
  on($('#state'), 'click', (e: MouseEvent) => { if ((e.target as HTMLElement).closest('[data-state]')?.getAttribute('data-state') === 'reload') location.reload(); });
  on($('#bannerAct'), 'click', (e: MouseEvent) => {
    const id = (e.target as HTMLElement).dataset.id;
    if (id === 'grow') { S.radius = Math.min(150, S.radius * 2); LS.set('radius', S.radius); }
    else if (id === 'login') window.location.assign(new URL('/login?returnTo=%2Fperiksa', window.location.origin));   // full navigation: sign-in goes through DBKK ID
    else if (id === 'refetch') void maybeFetchNearby(true);
    else openList();
  });
  on($('#hFreeze'), 'click', (e: MouseEvent) => {
    S.frozen = !S.frozen; const b = e.currentTarget as HTMLElement;
    b.setAttribute('aria-pressed', String(S.frozen)); b.textContent = S.frozen ? 'Dibekukan' : 'Bekukan';
  });

  function drawSim(W: number, H: number, f: number, items: Projected[]) {
    const ctx = resizeCanvas(sim, W, H);
    const hy = H / 2 + f * Math.tan(S.pitch * D2R);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const hz = clamp(hy / H, 0.001, 0.998);
    g.addColorStop(0, '#16302d'); g.addColorStop(hz, '#2a4a46'); g.addColorStop(hz + 0.001, '#1a1f1e'); g.addColorStop(1, '#0c0f0f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
    const yAt = (hgt: number, d: number) => H / 2 - f * Math.tan((Math.atan((hgt - EYE) / d) * R2D - S.pitch) * D2R);
    [...items].filter((o) => Math.abs(o.rel) < 80).sort((a, b) => b.d - a.d).forEach((o) => {
      const half = Math.atan(3 / o.d) * R2D;
      const xl = W / 2 + f * Math.tan(clamp(o.rel - half, -85, 85) * D2R), xr = W / 2 + f * Math.tan(clamp(o.rel + half, -85, 85) * D2R);
      const top = yAt((o.p.floor + 1) * FLOOR_H, o.d), bot = yAt(o.p.floor * FLOOR_H, o.d);
      const shade = clamp(1 - o.d / 140, 0.25, 0.9);
      ctx.fillStyle = `rgba(${o.p.floor ? '96,118,114' : '128,150,145'},${shade})`; ctx.fillRect(xl, top, xr - xl, bot - top);
      ctx.strokeStyle = `rgba(10,20,19,${shade})`; ctx.strokeRect(xl, top, xr - xl, bot - top);
      if (!o.p.floor) {
        const sb = yAt(3.3, o.d), st = yAt(2.7, o.d);
        ctx.fillStyle = `rgba(236,232,214,${shade})`; ctx.fillRect(xl + 1, sb, xr - xl - 2, st - sb);
        if (xr - xl > 60) {
          ctx.fillStyle = '#1b2422'; ctx.font = `600 ${clamp((st - sb) * 0.6, 7, 13)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(o.p.trade_name.toUpperCase(), (xl + xr) / 2, (sb + st) / 2, xr - xl - 6);
        }
      }
    });
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let a = 0; a < 360; a += 15) {
      const rel = n180(a - S.heading); if (Math.abs(rel) > S.fovH / 2 + 5) continue;
      const x = W / 2 + f * Math.tan(rel * D2R);
      ctx.fillRect(x - 0.5, hy - (a % 45 ? 4 : 8), 1, a % 45 ? 4 : 8);
      if (a % 45 === 0) ctx.fillText(CARD[a / 45], x, hy + 4);
    }
  }
  function drawRadar(items: Projected[]) {
    const sz = radar.clientWidth; if (!sz) return;
    const ctx = resizeCanvas(radar, sz, sz), c = sz / 2, r = c - 6;
    ctx.clearRect(0, 0, sz, sz);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(c, c);
    ctx.arc(c, c, r, (-90 - S.fovH / 2) * D2R, (-90 + S.fovH / 2) * D2R); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(c, c, r / 2, 0, Math.PI * 2); ctx.stroke();
    const css = getComputedStyle(root);
    const col: Record<string, string> = { ok: css.getPropertyValue('--ar-ok'), warn: css.getPropertyValue('--ar-warn'), bad: css.getPropertyValue('--ar-bad') };
    items.forEach((o) => {
      if (o.d > S.radius) return;
      const k = o.d / S.radius * r;
      ctx.fillStyle = col[statusOf(o.p).key]; ctx.beginPath();
      ctx.arc(c + Math.sin(o.rel * D2R) * k, c - Math.cos(o.rel * D2R) * k, 3.2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(c, c, 3.5, 0, Math.PI * 2); ctx.fill();
    const nrel = n180(0 - S.heading) * D2R;
    ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('U', c + Math.sin(nrel) * (r - 1), c - Math.cos(nrel) * (r - 1));
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '600 9px system-ui'; ctx.fillText(`${S.radius} m`, c, sz - 9);
  }

  // ------------------------------------------------------------------------------ sheets
  let sheetOpener: Element | null = null, closeArmed = false, sheetHist = false;
  function openSheet(html: string, label: string) {
    $('#toast').hidden = true;
    if (sheet.hidden) sheetOpener = document.activeElement;
    S.dirty = false; closeArmed = false;
    sheetBody.innerHTML = html; sheet.setAttribute('aria-label', label); sheet.hidden = false; scrim.hidden = false; sheet.scrollTop = 0;
    stage.inert = true;
    if (!sheetHist) { try { history.pushState({ sheet: 1 }, ''); sheetHist = true; } catch { sheetHist = false; } }
    sheetBody.querySelector<HTMLElement>('[data-close]')?.focus({ preventScroll: true });
  }
  on(window, 'popstate', () => {
    if (!sheetHist || sheet.hidden) return;
    sheetHist = false;
    if (S.dirty && !closeArmed) {
      closeArmed = true; toast('Semakan belum disimpan. Tekan Kembali sekali lagi untuk buang.', 4000);
      try { history.pushState({ sheet: 1 }, ''); sheetHist = true; } catch { /* ignore */ }
      return;
    }
    hideSheet();
  });
  function closeSheet(force = false) {
    if (sheet.hidden) return;
    if (S.dirty && !force && !closeArmed) { closeArmed = true; toast('Semakan belum disimpan. Tutup sekali lagi untuk buang.', 4000); return; }
    hideSheet();
    if (sheetHist) { sheetHist = false; try { history.back(); } catch { /* ignore */ } }
  }
  function hideSheet() {
    sheet.hidden = true; scrim.hidden = true; stage.inert = false; S.selectedId = null; S.draft = null; S.dirty = false;
    if (sheetOpener instanceof HTMLElement && sheetOpener.isConnected && !sheetOpener.hidden) sheetOpener.focus({ preventScroll: true });
    sheetOpener = null;
  }
  on(scrim, 'click', () => closeSheet());
  on(sheetBody, 'click', (e: MouseEvent) => { if ((e.target as HTMLElement).closest('[data-close]')) closeSheet(); });
  on(sheetBody, 'input', () => { S.dirty = true; closeArmed = false; });
  on(sheet, 'keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, summary, a[href], [tabindex="0"]')].filter((x) => x.offsetParent);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  on($('#bList'), 'click', openList); on($('#crowd'), 'click', openList); on(radar, 'click', openList);
  on(radar, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); } });
  on($('#bFilter'), 'click', openFilters); on($('#hRadius'), 'click', openFilters);
  on($('#bUnlisted'), 'click', openUnlisted); on($('#bLog'), 'click', openLog); on($('#hSync'), 'click', openLog);
  on($('#hMode'), 'click', openDevice);
  const head = (title: string) => `<div class="shead"><h2>${title}</h2><button class="x" type="button" data-close>Tutup</button></div>`;

  function openList() {
    if (!S.pos || !S.nearby) { toast(S.pos ? 'Data premis belum dimuatkan.' : 'Belum ada kedudukan GPS.'); return; }
    const rows = visibleSet().map((p) => ({ p, d: dist(S.pos!, p), rel: n180(bearing(S.pos!, p) - S.heading) })).sort((a, b) => a.d - b.d);
    let divided = false;
    const li = rows.map((o) => {
      const st = statusOf(o.p), out = o.d > S.radius;
      let pre = '';
      if (out && !divided) { divided = true; pre = `<li class="divider">Di luar radius ${S.radius} m</li>`; }
      return `${pre}<li><button type="button" data-id="${o.p.id}" class="${out ? 'out' : ''}"><span class="ldot ${st.key}"></span>`
        + `<span class="t">${esc(o.p.trade_name)}<span class="s">${esc(typeOf(o.p) ?? '—')} · ${esc(o.p.address ?? '')} · ${esc(st.label)}${(o.p.licence?.outstanding_compound_sen ?? 0) > 0 ? ' · kompaun' : ''}</span></span>`
        + `<span class="d">${Math.round(o.d)} m<span class="s">${relWord(o.rel)}</span></span></button></li>`;
    }).join('');
    openSheet(`<div class="sh">${head('Premis berdekatan')}<p class="note">Disusun ikut jarak dari kedudukan GPS anda. Guna senarai ini jika label kamera tidak stabil.</p>`
      + (li ? `<ul class="list">${li}</ul>` : '<div class="empty">Tiada premis sepadan dengan tapisan.</div>') + '</div>', 'Premis berdekatan');
    sheetBody.querySelectorAll<HTMLButtonElement>('.list button[data-id]').forEach((b) => b.addEventListener('click', () => openPremise(b.dataset.id!)));
  }

  const stampFor = (title: string) => [
    title, `${new Date().toLocaleString('ms-MY', { timeZone: TZ })} · ${opts.displayName}`,
    S.pos ? `${S.pos.lat.toFixed(6)}, ${S.pos.lng.toFixed(6)} ±${S.acc != null ? Math.round(S.acc) : '?'} m · arah ${Math.round(S.heading)}° ${cardinal(S.heading)}` : 'Tiada GPS',
  ];
  const photoMeta = () => ({
    taken_at: new Date().toISOString(),
    ...(S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : {}), ...(S.acc != null ? { accuracy_m: Math.round(S.acc * 10) / 10 } : {}),
    heading: Math.round(S.heading * 10) / 10 % 360,
  });
  /** Camera frame when the camera runs, else the phone's photo picker (file input with capture). */
  async function takePhoto(title: string): Promise<Blob | null> {
    if (S.camera && video.videoWidth) return captureFromVideo(video, stampFor(title));
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
    const file = await new Promise<File | null>((resolve) => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click(); });
    return file ? captureFromFile(file, stampFor(title)) : null;
  }
  function addThumb(container: Element, blob: Blob, alt: string) {
    const img = new Image(); img.src = URL.createObjectURL(blob); img.alt = alt; img.width = 160; img.height = 120;
    container.appendChild(img);
  }

  function openPremise(id: string) {
    const p = premises().find((x) => x.id === id); if (!p) return;
    const st = statusOf(p);
    const d = S.pos ? Math.round(dist(S.pos, p)) : null, rel = S.pos ? n180(bearing(S.pos, p) - S.heading) : 0;
    S.selectedId = id; S.draft = { results: {}, notes: '', photos: [] };
    const lic = p.licence;
    const rules = rulesFor(typeOf(p));
    const issues: string[] = [];
    if (!lic) issues.push('Tiada lesen dalam rekod');
    else if (lic.status === 'suspended') issues.push('Lesen digantung');
    else if (lic.status === 'revoked') issues.push('Lesen dibatalkan');
    else if (st.days != null && st.days < 0) issues.push(`Lesen tamat ${-st.days} hari lalu (${fmtDate(lic.valid_until)})`);
    else if (st.key === 'warn' && st.days != null) issues.push(`Lesen tamat dalam ${st.days} hari (${fmtDate(lic.valid_until)})`);
    if ((lic?.outstanding_compound_sen ?? 0) > 0) issues.push(`Kompaun tertunggak ${rm(lic!.outstanding_compound_sen)}`);
    if (p.last_inspection?.outcome === 'tidak_patuh') issues.push(`Semakan lepas tidak patuh (${fmtTime(p.last_inspection.observed_at)})`);
    const vKey = st.key === 'bad' || (lic?.outstanding_compound_sen ?? 0) > 0 ? 'bad' : issues.length ? 'warn' : 'ok';
    const verdict = issues.length
      ? `<div class="verdict ${vKey}"><strong>${issues.length} perkara perlu tindakan</strong><ul>${issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
      : `<div class="verdict ok"><strong>Lesen sah</strong><span>Sah sehingga ${fmtDate(lic!.valid_until)}. Tiada kompaun tertunggak.</span></div>`;
    const training = S.mode === 'training';
    openSheet(`<div class="sh">
      <div class="shead"><div class="row"><span class="tag">${esc(typeOf(p) ?? 'TIADA LESEN')}</span><span class="pill ${st.key}">${esc(st.label)}</span></div>
        <button class="x" type="button" data-close>Tutup</button></div>
      <header class="ph"><h2>${esc(p.trade_name)}</h2>${p.registered_name ? `<p class="sub">${esc(p.registered_name)}</p>` : ''}
        <p class="sub">${esc(p.address ?? '')}${d != null ? ` · ${d} m ${relWord(rel)}` : ''}</p></header>
      ${verdict}
      <dl class="facts">
        <div><dt>No. lesen</dt><dd class="mono">${esc(lic?.licence_no ?? '—')}</dd></div>
        <div><dt>Jenis lesen</dt><dd>${esc(typeName(typeOf(p)))}</dd></div>
        <div><dt>Tarikh tamat</dt><dd class="${st.key === 'ok' ? '' : st.key}">${lic ? fmtDate(lic.valid_until) : '—'}</dd></div>
        <div><dt>Kompaun tertunggak</dt><dd class="${(lic?.outstanding_compound_sen ?? 0) ? 'bad' : ''}">${(lic?.outstanding_compound_sen ?? 0) ? rm(lic!.outstanding_compound_sen) : 'Tiada'}</dd></div>
        <div><dt>Semakan terakhir</dt><dd>${p.last_inspection ? `${fmtTime(p.last_inspection.observed_at)} · ${OUTCOME_LABEL[p.last_inspection.outcome] ?? ''}` : 'Belum pernah'}</dd></div>
        <div><dt>Tingkat</dt><dd>${p.floor ? `Tingkat ${p.floor}` : 'Tingkat bawah'}</dd></div>
      </dl>
      ${lic?.conditions.length ? `<section><h3>Syarat lesen</h3><ul class="plain">${lic.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>` : ''}
      ${opts.canInspect ? `<section><h3>Senarai semak pematuhan</h3>
        <p class="note">VISUAL boleh disemak dari luar premis; MANUAL perlu pemeriksaan atau dokumen. Ketik <strong>Gambar</strong> pada perkara untuk bukti khusus.</p>
        ${training ? '<p class="warnbox">Mod latihan: semakan ini tidak akan disimpan atau dihantar.</p>' : ''}
        <ol class="chk">${rules.map((r) => `<li data-rule="${esc(r.id)}"><div class="rt">${esc(r.text)}<span class="kind ${r.kind}">${r.kind === 'visual' ? 'VISUAL' : 'MANUAL'}</span>${r.is_example ? '<span class="kind ex">CONTOH</span>' : ''}</div>
          <div class="seg" role="group" aria-label="${esc(r.text)}">
            <button type="button" data-v="patuh" aria-pressed="false">Patuh</button><button type="button" data-v="tidak_patuh" aria-pressed="false">Tidak patuh</button><button type="button" data-v="tb" aria-pressed="false" title="Tidak berkenaan">T/B</button>
          </div>
          <div class="row"><button class="seg-photo" type="button" data-photo-rule="${esc(r.id)}">Gambar</button><div class="rule-thumbs" data-thumbs="${esc(r.id)}"></div></div></li>`).join('')}</ol>
        <button class="btn sm" type="button" id="allOk" style="margin-top:10px">Tandakan baki sebagai Patuh</button>
      </section>
      <section><h3>Bukti umum</h3><div class="thumbs" id="thumbs"></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" type="button" id="snap">Ambil gambar</button><span class="fine">Gambar dicop masa, GPS, arah dan nama pegawai.</span></div>
        <label class="f" style="margin-top:12px">Catatan pegawai<textarea id="notes" maxlength="2000" placeholder="Contoh: cermin hadapan ditutup pelekat hitam sepenuhnya"></textarea></label>
      </section>
      <div class="actions"><button class="btn primary" type="button" id="save">${training ? 'Tamat latihan' : 'Simpan semakan'}</button><span class="outcome" id="outcome"></span></div>
      <p class="fine">Notis dan kompaun dikeluarkan dalam sistem pelesenan.</p>` : ''}
      <details class="pin"><summary>Label pada kedai yang salah?</summary>
        <p>Jika anda berdiri betul-betul di hadapan premis ini, cadangkan kedudukan GPS anda sebagai lokasi premis. Penyelia akan menyemak cadangan ini.</p>
        <button class="btn sm" type="button" id="repin">Cadang lokasi baharu</button></details>
    </div>`, p.trade_name);

    const repin = sheetBody.querySelector<HTMLButtonElement>('#repin')!;
    repin.addEventListener('click', async () => {
      if (training) { toast('Tidak tersedia dalam mod latihan.'); return; }
      if (!S.pos || S.acc == null || S.acc > 20) { toast('Ketepatan GPS perlu ±20 m atau lebih baik untuk mencadang lokasi.'); return; }
      if (repin.dataset.armed !== '1') { repin.dataset.armed = '1'; repin.textContent = 'Ketik sekali lagi untuk hantar'; return; }
      repin.disabled = true; repin.textContent = 'Menghantar…';
      try {
        await api(`/api/v1/premises/${p.id}/pin-corrections`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lat: S.pos.lat, lng: S.pos.lng, accuracy_m: Math.round(S.acc) }) });
        repin.textContent = 'Cadangan dihantar kepada penyelia';
      } catch {
        repin.disabled = false; repin.dataset.armed = ''; repin.textContent = 'Cadang lokasi baharu';
        toast('Cadangan lokasi perlu talian internet. Cuba lagi apabila ada isyarat.');
      }
    });
    if (!opts.canInspect) return;

    const chk = sheetBody.querySelector('.chk')!;
    const updateOutcome = () => {
      const r = S.draft!.results, n = Object.keys(r).length, bad = Object.values(r).filter((v) => v === 'tidak_patuh').length;
      const el = sheetBody.querySelector<HTMLElement>('#outcome')!;
      if (bad) { el.textContent = `${bad} tidak patuh`; el.style.color = 'var(--bad)'; }
      else if (n === rules.length) { el.textContent = 'Semua patuh'; el.style.color = 'var(--ok)'; }
      else { el.textContent = `${n}/${rules.length} disemak`; el.style.color = 'var(--muted)'; }
    };
    const mark = (li: Element, v: Answer | undefined) => {
      li.querySelectorAll('button[data-v]').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.v === v)));
      li.classList.toggle('no', v === 'tidak_patuh');
    };
    chk.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const photoBtn = target.closest<HTMLButtonElement>('button[data-photo-rule]');
      if (photoBtn) {
        const ruleId = photoBtn.dataset.photoRule!;
        photoBtn.disabled = true;
        try {
          const blob = await takePhoto(`${p.trade_name} · ${ruleId}`);
          if (blob && S.draft) {
            S.draft.photos.push({ localId: newKey('ph'), blob, ruleId, meta: photoMeta() });
            const n = S.draft.photos.filter((x) => x.ruleId === ruleId).length;
            addThumb(chk.querySelector(`[data-thumbs="${CSS.escape(ruleId)}"]`)!, blob, `Gambar bukti ${n}`);
            S.dirty = true; closeArmed = false; toast('Gambar ditambah pada perkara ini.', 1500);
          }
        } catch { toast('Gambar tidak dapat diambil. Cuba lagi.'); } finally { photoBtn.disabled = false; }
        return;
      }
      const b = target.closest<HTMLButtonElement>('button[data-v]'); if (!b || !S.draft) return;
      const li = b.closest('li')!, rid = (li as HTMLElement).dataset.rule!;
      const now = S.draft.results[rid] === b.dataset.v ? undefined : (b.dataset.v as Answer);
      if (now) S.draft.results[rid] = now; else delete S.draft.results[rid];
      mark(li, now); S.dirty = true; closeArmed = false; updateOutcome();
    });
    sheetBody.querySelector('#allOk')!.addEventListener('click', () => {
      if (!S.draft) return;
      let n = 0;
      chk.querySelectorAll<HTMLElement>('li[data-rule]').forEach((li) => {
        if (S.draft!.results[li.dataset.rule!]) return;
        S.draft!.results[li.dataset.rule!] = 'patuh'; n++; mark(li, 'patuh');
      });
      if (n) { S.dirty = true; closeArmed = false; }
      updateOutcome(); toast(n ? `${n} perkara ditandakan Patuh.` : 'Semua perkara sudah ditandakan.', 2000);
    });
    sheetBody.querySelector<HTMLTextAreaElement>('#notes')!.addEventListener('input', (e) => { if (S.draft) S.draft.notes = (e.target as HTMLTextAreaElement).value; });
    sheetBody.querySelector('#snap')!.addEventListener('click', async () => {
      const blob = await takePhoto(p.trade_name).catch(() => null);
      if (blob && S.draft) {
        S.draft.photos.push({ localId: newKey('ph'), blob, ruleId: null, meta: photoMeta() });
        addThumb(sheetBody.querySelector('#thumbs')!, blob, `Gambar bukti umum ${S.draft.photos.filter((x) => !x.ruleId).length}`);
        S.dirty = true; toast('Gambar ditambah.', 1500);
      }
    });
    sheetBody.querySelector('#save')!.addEventListener('click', async () => {
      const draft = S.draft; if (!draft) return;
      if (!Object.keys(draft.results).length) { toast('Tandakan sekurang-kurangnya satu perkara dalam senarai semak.'); return; }
      if (training) { closeSheet(true); toast('Latihan selesai. Tiada rekod disimpan.'); return; }
      const bad = Object.values(draft.results).filter((v) => v === 'tidak_patuh').length;
      const complete = rules.every((r) => draft.results[r.id]);
      const outcome = bad ? 'Tidak patuh' : complete ? 'Patuh' : 'Belum lengkap';
      const record: OutboxRecord = {
        key: newKey('insp'), userId: opts.userId, kind: 'inspection', title: p.trade_name,
        summary: `${outcome} · ${draft.photos.length} gambar`, createdAt: new Date().toISOString(),
        payload: {
          premise_id: p.id, observed_at: new Date().toISOString(), answers: draft.results, notes: draft.notes.trim(),
          ...(S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : {}), ...(S.acc != null ? { accuracy_m: Math.round(S.acc * 10) / 10 } : {}),
          heading: Math.round(S.heading * 10) / 10 % 360,
        },
        photos: draft.photos, uploaded: {}, status: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null,
      };
      try {
        await putRecord(record);
      } catch {
        toast('Gagal menyimpan dalam telefon (storan penuh?). Semakan belum disimpan.', 5000); return;
      }
      closeSheet(true);
      toast(navigator.onLine ? `Disimpan: ${outcome}. Menghantar…` : `Disimpan dalam telefon: ${outcome}. Akan dihantar apabila ada talian.`, 3500);
      await refreshSync(true);
    });
    updateOutcome();
  }

  function openUnlisted() {
    if (S.mode === 'training') { toast('Laporan tidak tersedia dalam mod latihan.'); return; }
    S.draft = { results: {}, notes: '', photos: [] };
    const types = S.rules?.types ?? [];
    openSheet(`<div class="sh">${head('Premis tiada dalam senarai')}
      <p class="note">Gunakan apabila papan tanda di hadapan anda tidak sepadan dengan mana-mana label. Ini mungkin premis tanpa lesen atau premis yang belum dipetakan.</p>
      <form id="uForm" class="sh" novalidate>
        <label class="f">Nama pada papan tanda<input id="uName" name="signboard" type="text" autocomplete="off" required maxlength="160" aria-describedby="uErr" placeholder="Contoh: Kedai Gunting Rambut Mesra"></label>
        <p class="ferr" id="uErr" role="alert" hidden></p>
        <label class="f">Jenis perniagaan yang dilihat<select id="uType">${types.map((t) => `<option value="${esc(t.code)}">${esc(t.name)}</option>`).join('')}<option value="">Lain-lain</option></select></label>
        <label class="f">Tingkat<select id="uFloor"><option value="0">Tingkat bawah</option><option value="1">Tingkat 1</option><option value="2">Tingkat 2 ke atas</option></select></label>
        <section><h3>Bukti</h3><div class="thumbs" id="thumbs"></div>
          <div class="row" style="margin-top:8px"><button class="btn sm" type="button" id="snap">Ambil gambar</button><span class="fine">Gambar papan tanda dan bahagian hadapan.</span></div></section>
        <label class="f">Catatan<textarea id="notes" maxlength="2000"></textarea></label>
        <div class="actions"><button class="btn primary" type="submit" id="save">Simpan laporan</button><span></span></div>
      </form></div>`, 'Premis tiada dalam senarai');
    sheetBody.querySelector('#snap')!.addEventListener('click', async () => {
      const blob = await takePhoto('Premis tiada dalam senarai').catch(() => null);
      if (blob && S.draft) { S.draft.photos.push({ localId: newKey('ph'), blob, ruleId: null, meta: photoMeta() }); addThumb(sheetBody.querySelector('#thumbs')!, blob, `Gambar ${S.draft.photos.length}`); S.dirty = true; }
    });
    sheetBody.querySelector('#uForm')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameEl = sheetBody.querySelector<HTMLInputElement>('#uName')!, err = sheetBody.querySelector<HTMLElement>('#uErr')!;
      const name = nameEl.value.trim();
      if (!name) { err.textContent = 'Masukkan nama seperti tertulis pada papan tanda.'; err.hidden = false; nameEl.setAttribute('aria-invalid', 'true'); nameEl.focus(); return; }
      const draft = S.draft!;
      const type = sheetBody.querySelector<HTMLSelectElement>('#uType')!.value;
      const record: OutboxRecord = {
        key: newKey('rpt'), userId: opts.userId, kind: 'unlisted', title: name, summary: `Untuk siasatan · ${draft.photos.length} gambar`,
        createdAt: new Date().toISOString(),
        payload: {
          signboard_name: name, licence_type_code: type || null, floor: Number(sheetBody.querySelector<HTMLSelectElement>('#uFloor')!.value),
          notes: sheetBody.querySelector<HTMLTextAreaElement>('#notes')!.value.trim(), observed_at: new Date().toISOString(),
          ...(S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : {}), ...(S.acc != null ? { accuracy_m: Math.round(S.acc * 10) / 10 } : {}),
          heading: Math.round(S.heading * 10) / 10 % 360,
        },
        photos: draft.photos, uploaded: {}, status: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null,
      };
      try { await putRecord(record); } catch { toast('Gagal menyimpan dalam telefon. Laporan belum disimpan.', 5000); return; }
      closeSheet(true); toast('Laporan disimpan. Menghantar…'); await refreshSync(true);
    });
  }

  function openFilters() {
    const types = S.rules?.types ?? [];
    const chips = [...types.map((t) => [t.code, t.code] as const), ['', 'TIADA LESEN'] as const]
      .map(([k, label]) => `<button class="tg" type="button" data-type="${esc(k)}" aria-pressed="${!S.types || S.types.has(k)}">${esc(label)}</button>`).join('');
    openSheet(`<div class="sh">${head('Tapis dan tetapan')}
      <section><h3>Radius paparan</h3><div class="range"><input id="fRadius" type="range" min="20" max="150" step="5" value="${S.radius}" aria-label="Radius paparan"><output id="oRadius">${S.radius} m</output></div>
        <p class="note">Label hanya dipaparkan untuk premis dalam radius ini.</p></section>
      <section><h3>Jenis lesen</h3><div class="chips" id="fTypes">${chips}</div></section>
      <label class="sw"><input id="fProblem" type="checkbox" ${S.onlyProblem ? 'checked' : ''}><span>Hanya premis bermasalah<small>Lesen tamat, digantung, hampir tamat atau ada kompaun tertunggak.</small></span></label>
      <section><h3>Sudut pandangan kamera</h3><div class="range"><input id="fFov" type="range" min="35" max="85" step="1" value="${S.fovH}" aria-label="Sudut pandangan kamera"><output id="oFov">${S.fovH}°</output></div>
        <p class="note">Kalibrasi: halakan ke satu kedai yang anda kenal di tepi skrin. Laraskan sehingga label jatuh di atas kedai itu.</p></section>
      <section><h3>Akaun</h3><p>${esc(opts.displayName)} · ${esc(opts.roleLabel)}</p>
        <p class="note" id="logoutNote"></p>
        <div class="row">${opts.canReadAll ? '<a class="btn sm" href="/semakan">Rekod semakan</a>' : '<a class="btn sm" href="/semakan">Rekod saya</a>'}
          <form method="post" action="/api/auth/logout"><button class="btn sm danger" type="submit">Log keluar</button></form></div></section>
    </div>`, 'Tapis dan tetapan');
    const n = S.sync.pending + S.sync.failed;
    if (n) sheetBody.querySelector('#logoutNote')!.textContent = `${n} rekod belum dihantar. Ia kekal dalam telefon ini dan dihantar apabila anda log masuk semula.`;
    sheetBody.querySelector('#fRadius')!.addEventListener('input', (e) => { S.radius = +(e.target as HTMLInputElement).value; sheetBody.querySelector('#oRadius')!.textContent = `${S.radius} m`; LS.set('radius', S.radius); });
    sheetBody.querySelector('#fFov')!.addEventListener('input', (e) => { S.fovH = +(e.target as HTMLInputElement).value; sheetBody.querySelector('#oFov')!.textContent = `${S.fovH}°`; LS.set('fov', S.fovH); });
    sheetBody.querySelector('#fProblem')!.addEventListener('change', (e) => { S.onlyProblem = (e.target as HTMLInputElement).checked; });
    sheetBody.querySelector('#fTypes')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-type]'); if (!b) return;
      S.types ??= new Set([...types.map((t) => t.code), '']);
      const k = b.dataset.type!; if (S.types.has(k)) S.types.delete(k); else S.types.add(k);
      b.setAttribute('aria-pressed', String(S.types.has(k)));
    });
  }

  async function openLog() {
    const [records, sent] = await Promise.all([allRecords().catch(() => []), allSent().catch(() => [])]);
    const mine = records.filter((r) => r.userId === opts.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const recentSent = sent.filter((r) => r.userId === opts.userId).sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 20);
    const other = records.length - mine.length;
    const row = (r: OutboxRecord) => `<li><div class="row" style="justify-content:space-between"><strong>${esc(r.title)}</strong>`
      + `<span class="pill ${r.status === 'failed' ? 'bad' : 'warn'}">${r.status === 'failed' ? 'Ditolak' : 'Belum dihantar'}</span></div>`
      + `<span class="fine">${fmtTime(r.createdAt)} · ${esc(r.summary)}${r.attempts ? ` · ${r.attempts} cubaan` : ''}</span>`
      + (r.status === 'failed' ? `<span class="fine" style="color:var(--bad)">${esc(errorMessage(r.lastError))}</span><div><button class="btn sm" type="button" data-retry="${esc(r.key)}">Cuba hantar semula</button></div>` : '')
      + '</li>';
    openSheet(`<div class="sh">${head('Log semakan')}
      ${S.sync.needsLogin ? '<p class="warnbox">Sesi tamat. <a href="/login?returnTo=%2Fperiksa">Log masuk semula</a> untuk menghantar rekod.</p>' : ''}
      <section><h3>Belum dihantar (${mine.length})</h3>
        ${mine.length ? `<ul class="list log">${mine.map(row).join('')}</ul><div class="row" style="margin-top:8px"><button class="btn sm" type="button" id="syncNow">Hantar sekarang</button></div>`
          : '<div class="empty">Semua rekod telah dihantar.</div>'}
        ${other ? `<p class="note">${other} rekod milik pegawai lain dalam telefon ini. Ia hanya dihantar apabila pegawai itu log masuk.</p>` : ''}</section>
      <section><h3>Dihantar dari telefon ini</h3>
        ${recentSent.length ? `<ul class="list log">${recentSent.map((r) => `<li><div class="row" style="justify-content:space-between"><strong>${esc(r.title)}</strong><span class="pill ok">Dihantar</span></div><span class="fine">${fmtTime(r.createdAt)} · ${esc(r.summary)}</span></li>`).join('')}</ul>`
          : '<div class="empty">Belum ada.</div>'}
        <p style="margin-top:10px"><a class="btn sm" href="/semakan">Semua rekod di pelayan</a></p></section>
    </div>`, 'Log semakan');
    sheetBody.querySelector('#syncNow')?.addEventListener('click', async (e) => {
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = 'Menghantar…';
      await refreshSync(true); void openLog();
    });
    sheetBody.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
      await retryRecord(b.dataset.retry!); await refreshSync(true); void openLog();
    }));
  }

  function openDevice() {
    const cam = S.mode === 'training' ? ['ok', 'Tidak digunakan (latihan)', ''] : S.camera ? ['ok', 'Berfungsi', ''] :
      [S.cameraErr === 'denied' ? 'bad' : 'warn', S.cameraErr === 'denied' ? 'Tidak dibenarkan' : 'Tidak dapat dibuka',
        'iPhone: Tetapan → Safari → Kamera → Benarkan. Android: ikon kunci di bar alamat → Kebenaran → Kamera. Tanpa kamera, gambar diambil melalui pemilih foto.'];
    const gps = S.mode === 'training' ? ['ok', 'Lokasi latihan', ''] :
      S.geoState === 'ok' ? [(S.acc ?? 99) <= 15 ? 'ok' : (S.acc ?? 99) <= 30 ? 'warn' : 'bad', `±${Math.round(S.acc ?? 0)} m`, (S.acc ?? 0) > 15 ? 'Ketepatan rendah di antara bangunan adalah biasa. Bergerak ke kawasan lebih terbuka.' : ''] :
        S.geoState === 'denied' || S.geoState === 'unsupported' ? ['bad', 'Tidak dibenarkan', 'Benarkan Lokasi untuk pelayar ini, kemudian muat semula.'] : ['warn', 'Mencari isyarat…', 'Berdiri di kawasan terbuka.'];
    const cmp = S.mode === 'training' ? ['ok', 'Manual (latihan)', ''] : S.hasCompass ?
      [(S.compassAcc ?? 0) > 25 ? 'warn' : 'ok', S.compassAcc != null ? `Berfungsi (±${Math.round(S.compassAcc)}°)` : 'Berfungsi', 'Jika label tersasar ke kiri/kanan: gerakkan telefon dalam bentuk angka 8, jauhi kenderaan dan pintu besi.'] :
      ['warn', 'Manual', 'iPhone: muat semula dan ketik Benarkan pada soalan Gerakan & Orientasi. Seret skrin atau guna ◀ ▶ untuk pusing.'];
    const data = !S.nearby ? ['warn', 'Belum dimuatkan', ''] : S.nearbyOffline ? ['warn', `Luar talian (${fmtTime(S.nearby.fetched_at)})`, 'Semakan tetap disimpan dalam telefon dan dihantar kemudian.'] : ['ok', `${S.nearby.premises.length} premis dalam ${S.nearby.radius} m`, ''];
    const row = (name: string, [k, v, fix]: string[]) => `<li><div class="row"><span class="ldot ${k}" aria-hidden="true"></span><strong>${name}</strong><span>${esc(v)}</span></div>${fix ? `<span class="fine">${esc(fix)}</span>` : ''}</li>`;
    openSheet(`<div class="sh">${head('Status peranti')}
      <ul class="dev">${row('Kamera', cam)}${row('GPS', gps)}${row('Kompas', cmp)}${row('Data premis', data)}</ul>
      <div class="row">${S.mode === 'field' && !S.camera ? '<button class="btn sm" type="button" id="dCam">Cuba buka kamera semula</button>' : ''}
        <button class="btn sm" type="button" id="dRefetch">Muat semula data premis</button></div></div>`, 'Status peranti');
    sheetBody.querySelector('#dCam')?.addEventListener('click', async (e) => {
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = 'Membuka kamera…';
      await openCamera(); closeSheet(true); toast(S.camera ? 'Kamera dibuka.' : 'Kamera masih tidak dapat dibuka.');
    });
    sheetBody.querySelector('#dRefetch')!.addEventListener('click', async () => { closeSheet(true); await maybeFetchNearby(true); toast(S.nearbyOffline ? 'Masih tiada talian.' : 'Data premis dikemas kini.'); });
  }

  // ------------------------------------------------------------------------------ boot
  void loadRules();
  void refreshSync(true);
  on(window, 'online', () => { void refreshSync(true); void maybeFetchNearby(true); });
  const syncTimer = window.setInterval(() => { void refreshSync(true); }, 30_000);
  disposers.push(() => clearInterval(syncTimer));
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => undefined);

  return () => disposers.forEach((d) => d());
}
