# Semak Premis AR — prototype

Field prototype for DBKK licensing officers: point the phone camera at a row of shops and see
floating labels with each licensed premise's **trade name, licence type and licence status**.
The officer matches the label name to the shop signboard, taps it, and runs a compliance
checklist for that licence type with photo evidence.

> Standalone static PWA (HTML/CSS/JS, no build step, no backend), hosted on GitHub Pages:
> **https://stanleydavid.github.io/Premise-AR/**
> All premises are **dummy data**. Inspection records stay in the phone's browser storage.

## Run it

Camera, GPS and compass only work over **HTTPS** (or `localhost`).

- On a phone: open https://stanleydavid.github.io/Premise-AR/ then **Add to Home Screen** to install it as a PWA.
- Local: `npx serve .` (or any static server) in this folder and open on the same machine.
- GitHub Pages serves the `main` branch root (Settings → Pages → Deploy from a branch → `main` / root).
  After pushing a change, bump `CACHE` in `sw.js` so installed copies pick it up.
- No HTTPS / desktop: choose **Mod simulasi**. Drag or use ◀ ▶ to turn, ▲ ▼ to walk.

## What it does

| Feature | How |
|---|---|
| Camera view | `getUserMedia` (back camera) |
| Position | `geolocation.watchPosition` (high accuracy); accuracy shown in the HUD, warning above ±25 m |
| Heading / tilt | `deviceorientationabsolute` (Android, W3C compass formula), `webkitCompassHeading` (iOS, permission asked on tap) |
| Label placement | bearing − heading projected with a pinhole model (FOV adjustable 35–85°), tilt moves labels vertically; nearest labels win, others stack upward; max 10 on screen |
| Status | green SAH, amber HAMPIR TAMAT (≤ 30 days), red TAMAT / DIGANTUNG, "Kompaun" flag |
| Off-screen | left/right counters + radar (tap for list) |
| Fallbacks | "Senarai berdekatan" list sorted by distance with direction words; manual turning if no compass |
| Checklist | common rules + rules per licence type, tagged VISUAL (checkable from outside) or MANUAL |
| Evidence | photo from the camera frame, stamped with premise, time, GPS ± accuracy, heading |
| Unlisted premise | report a signboard that matches no label (name, type, floor, photo, notes) |
| Pin correction | "Alih pin ke kedudukan saya" corrects a premise's coordinates |
| Offline | service worker caches the app shell |

### Dummy data placement

On the first GPS fix (field mode) 21 dummy premises are generated around the officer:
**Blok A** shophouse row ~11 m in front of the direction the phone faces, **Blok B** ~11 m behind
(across the street), 6.5 m frontages, some first-floor units, two premises behind and two beyond
80 m to test the radius filter. Re-place via *Tapis & tetapan → Letak semula di sekeliling saya*.

## Rules are examples

The compliance rules in `RULES` (top of the script in `index.html`) are **placeholders**, including
the barber/salon glazing rule (marked CONTOH). Confirm actual licence conditions with DBKK
licensing before any field use.

## Test on site — what to look for

1. GPS accuracy between shophouses (HUD chip). Expect ±5–15 m open, ±20–50 m in narrow streets.
2. Compass stability near metal shutters, zinc roofs and parked vehicles.
3. Calibrate FOV: aim at a known shop near the screen edge and adjust until its label sits on it.
4. Turn on *Simulasi ralat GPS* in simulation to show stakeholders how labels drift.

## Production gaps (not in prototype)

DBKK ID login, real licence data source and premise coordinates, server-side inspection records
with audit trail, notice/compound issuance in the licensing system, photo retention policy (PDPA),
anti-tamper on evidence (server timestamps, hashes).
