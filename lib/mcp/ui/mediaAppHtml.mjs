import { MEDIA_APP_SCRIPT } from './mediaAppBundle.mjs';

export function mediaAppHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: light dark;
  --app-bg: var(--color-background-primary, #f7f6f2);
  --panel: var(--color-background-secondary, #ffffff);
  --text: var(--color-text-primary, #181816);
  --muted: var(--color-text-secondary, #6b6a64);
  --line: var(--color-border-secondary, rgba(24, 24, 22, .13));
  --accent: #6657d9;
  --good: #237a50;
  --bad: #b3423e;
  font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  background: var(--app-bg);
  color: var(--text);
}
* { box-sizing: border-box; }
body { margin: 0; background: transparent; color: var(--text); }
button { font: inherit; }
#app { display: grid; gap: 12px; padding: 2px; }
#app.gallery { grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
#app.single { grid-template-columns: minmax(0, 1fr); }
.card { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
.card-single { max-width: 900px; }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; }
.identity { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.generation-id { font-weight: 700; letter-spacing: -.02em; }
.media-kind { color: var(--muted); font-size: 12px; text-transform: capitalize; }
.status { flex: none; border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 650; text-transform: capitalize; }
.status.success { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }
.status.failure { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.status.pending { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.media-grid { display: grid; gap: 1px; background: var(--line); }
.media-grid.count-2, .media-grid.count-3, .media-grid.count-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.media-frame { position: relative; min-height: 190px; display: grid; place-items: center; overflow: hidden; background: #111; }
.media-frame img, .media-frame video { display: block; width: 100%; max-height: 620px; object-fit: contain; }
.gallery .media-frame img, .gallery .media-frame video { aspect-ratio: 1 / 1; object-fit: cover; }
.open-button { position: absolute; right: 10px; bottom: 10px; cursor: pointer; border: 1px solid rgba(255,255,255,.26); border-radius: 999px; padding: 7px 10px; color: white; background: rgba(10,10,10,.72); backdrop-filter: blur(8px); }
.open-button:hover { background: rgba(10,10,10,.9); }
.pending-state, .empty-state, .initial-state { min-height: 210px; display: grid; place-items: center; align-content: center; gap: 14px; padding: 30px; color: var(--muted); text-align: center; }
.pending-state p, .empty-state p { margin: 0; }
.pulse { width: 38px; height: 38px; border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: spin .9s linear infinite; }
.empty-state.is-error { color: var(--bad); }
.card-footer { overflow: hidden; padding: 9px 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.global-error { grid-column: 1 / -1; border: 1px solid color-mix(in srgb, var(--bad) 28%, transparent); border-radius: 10px; padding: 9px 12px; color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, transparent); font-size: 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 520px) {
  #app.gallery { grid-template-columns: 1fr; }
  .media-frame { min-height: 160px; }
}
@media (prefers-reduced-motion: reduce) { .pulse { animation-duration: 2s; } }
</style>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script>${MEDIA_APP_SCRIPT}</script>
</body>
</html>`;
}
