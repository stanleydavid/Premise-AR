'use client';

import { useEffect, useRef } from 'react';
import { startFieldApp, type FieldOptions } from './field/app';
import './field.css';

/** Static structure of the field view; field/app.ts drives it (camera overlay, sheets, outbox). */
export default function FieldApp(props: FieldOptions) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? startFieldApp(root.current, props) : undefined), [props]);

  return (
    <div className="field-root" ref={root}>
      <div id="stage" aria-label="Paparan kamera">
        <video id="cam" playsInline muted autoPlay hidden />
        <canvas id="sim" />
        <div id="labels" />
        <div id="hud">
          <div className="left">
            <button className="chip" id="hMode" type="button" aria-label="Status peranti">—</button>
            <button className="chip sync-chip ok" id="hSync" type="button"><span className="dot" aria-hidden="true" />Semua dihantar</button>
          </div>
          <div className="right">
            <span className="chip" id="hGps"><span className="dot" id="hGpsDot" /><span id="hGpsTxt">Mencari GPS…</span></span>
            <span className="chip" id="hHead">—</span>
            <button className="chip" id="hRadius" type="button">Radius</button>
            <button className="chip" id="hFreeze" type="button" aria-pressed="false">Bekukan</button>
          </div>
        </div>
        <div id="banner" hidden><span id="bannerTxt" /><div><button type="button" id="bannerAct" hidden /></div></div>
        <div id="state" role="status" aria-live="polite" hidden />
        <button className="chip" id="crowd" type="button" hidden>Premis tersembunyi</button>
        <div className="edge" id="edgeL" hidden />
        <div className="edge" id="edgeR" hidden />
        <canvas id="radar" role="button" aria-label="Radar premis. Ketik untuk senarai." tabIndex={0} />
        <div id="turn" hidden>
          <button className="fw" type="button" data-act="fw" aria-label="Jalan ke depan 3 meter">▲</button>
          <button className="bk" type="button" data-act="bk" aria-label="Undur 3 meter">▼</button>
          <button className="tl" type="button" data-act="tl" aria-label="Pusing ke kiri">◀</button>
          <button className="tr" type="button" data-act="tr" aria-label="Pusing ke kanan">▶</button>
        </div>
        <nav id="bar" aria-label="Tindakan">
          <button type="button" id="bList">Senarai</button>
          <button type="button" id="bFilter">Tapis</button>
          <button type="button" id="bUnlisted" className="hot">Lapor premis</button>
          <button type="button" id="bLog">Log</button>
        </nav>
      </div>

      <div id="scrim" hidden />
      <div id="sheet" hidden role="dialog" aria-modal="true" aria-label="Butiran"><div className="grab" /><div id="sheetBody" /></div>
      <div id="toast" hidden role="status" aria-live="polite" />

      <div id="start" className="fixed inset-0 z-30 overflow-auto bg-bg text-fg px-5" style={{ paddingTop: 'max(28px, env(safe-area-inset-top))', paddingBottom: 'max(28px, env(safe-area-inset-bottom))' }}>
        <div className="max-w-md mx-auto flex flex-col gap-5">
          <div>
            <p className="text-xs font-bold tracking-widest uppercase text-accent">Semak Premis · {props.displayName}</p>
            <h1 className="text-3xl font-bold leading-tight mt-1">Paparan lapangan</h1>
          </div>
          <p className="text-muted">Halakan kamera ke deretan kedai. Label menunjukkan premis berlesen berdekatan dan status lesennya. Padankan nama pada label dengan papan tanda, kemudian ketik label untuk semakan.</p>
          <ol className="list-decimal pl-5 flex flex-col gap-1.5">
            <li>Berdiri di kaki lima, pegang telefon tegak.</li>
            <li>Padankan nama label dengan papan tanda. GPS boleh tersasar 10–30 m, jadi nama ialah pengesahan.</li>
            <li>Ketik label: semak status, tandakan senarai semak, ambil gambar bukti.</li>
          </ol>
          <p className="text-sm text-muted">Tiada talian? Semakan disimpan dalam telefon dan dihantar secara automatik apabila ada isyarat.</p>
          <div className="grid gap-2.5">
            <button id="goField" type="button" className="min-h-[50px] rounded-xl bg-accent text-accent-fg font-semibold">Mula di lapangan (kamera, GPS, kompas)</button>
            {props.training.enabled && (
              <button id="goSim" type="button" className="min-h-[50px] rounded-xl border border-line bg-surface font-semibold">Mod latihan (tanpa kamera, tiada rekod disimpan)</button>
            )}
          </div>
          <div className="flex gap-4 text-sm">
            <a href="/semakan" className="text-accent font-semibold underline">Rekod semakan</a>
            <form method="post" action="/api/auth/logout"><button type="submit" className="text-muted underline">Log keluar</button></form>
          </div>
        </div>
      </div>
    </div>
  );
}
