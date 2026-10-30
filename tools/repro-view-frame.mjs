/**
 * Reproduces the sequence that preceded the blank window on 29 October.
 *
 * A BaseWindow holds one WebContentsView. The view is released while the window is hidden,
 * exactly as RendererPool suspends every account five minutes after the window goes away,
 * and a fresh view is then created and attached to the window that had nothing in it. The
 * question each cycle answers is whether the new view has produced a frame.
 *
 * The page is a gradient, so a capture that comes back a single flat colour means the view
 * never painted. `capturePage` reads the page's own compositor, so it reports on the view,
 * not on the window: a painted capture beside a blank window is the interesting result,
 * because it puts the fault in the window server rather than the renderer.
 *
 * Run it on macOS, where the fault lives:
 *
 *   npx electron tools/repro-view-frame.mjs --cycles 10
 *   npx electron tools/repro-view-frame.mjs --cycles 10 --throttle off
 *   npx electron tools/repro-view-frame.mjs --help
 *
 * It cannot prove a fix. It can show that the sequence is or is not sufficient to produce
 * a view with no frame, and if it is, it is a reproduction to test a change against.
 */

import { app, BaseWindow, WebContentsView } from 'electron';
import { parseArgs } from 'node:util';

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>frame probe</title></head>
  <body style="margin:0;height:100vh;background:linear-gradient(135deg,#1d4ed8 0%,#9333ea 45%,#f59e0b 100%);font:600 28px system-ui;color:#fff;display:grid;place-items:center">
    <div>frame probe</div>
  </body>
</html>`)}`;

const { values: options } = parseArgs({
  options: {
    cycles: { type: 'string', default: '10' },
    'hidden-ms': { type: 'string', default: '5000' },
    'settle-ms': { type: 'string', default: '2500' },
    throttle: { type: 'string', default: 'on' },
    help: { type: 'boolean', default: false },
  },
});

if (options.help) {
  console.log(`Reproduce the blank-window sequence.

  --cycles N       how many hide/release/attach rounds to run (default 10)
  --hidden-ms N    how long the window stays hidden with no view (default 5000)
  --settle-ms N    how long the new view gets before the capture (default 2500)
  --throttle on|off  backgroundThrottling for the probe views (default on)

Each cycle: show a window with one view, hide it, release the view's WebContents, wait
while the window has nothing attached, create and attach a fresh view, show, capture.
Reported per cycle: the capture's size, how many distinct colours it holds, and how much
of it the commonest colour covers. A flat capture means the view produced no frame.`);
  process.exit(0);
}

const cycles = Number(options.cycles);
const hiddenMs = Number(options['hidden-ms']);
const settleMs = Number(options['settle-ms']);
const backgroundThrottling = options.throttle !== 'off';

if (!Number.isFinite(cycles) || cycles < 1) throw new Error('--cycles must be a positive number');
if (!Number.isFinite(hiddenMs) || hiddenMs < 0) throw new Error('--hidden-ms must be >= 0');
if (!Number.isFinite(settleMs) || settleMs < 0) throw new Error('--settle-ms must be >= 0');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let window;
let view;

function bounds() {
  const [width, height] = window.getContentSize();
  return { x: 0, y: 0, width, height };
}

/**
 * Mirrors the app's attach: visible before the child is added, then added.
 */
function attach(next) {
  if (typeof next.setVisible === 'function') next.setVisible(true);
  window.contentView.addChildView(next);
  next.setBounds(bounds());
}

function release() {
  if (!view) return;
  const doomed = view;
  view = undefined;
  if (window.contentView.children.includes(doomed)) window.contentView.removeChildView(doomed);
  if (!doomed.webContents.isDestroyed()) doomed.webContents.close();
}

function createView() {
  const created = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling,
    },
  });
  created.setBackgroundColor('#00000000');
  void created.webContents.loadURL(PAGE);
  return created;
}

/**
 * Reads a capture as a flat-versus-painted verdict.
 */
function measure(image) {
  const size = image.getSize();
  const bitmap = image.getBitmap();
  const counts = new Map();
  // Sample every 64th pixel; the page is a gradient, so this is plenty to tell it from a fill.
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 64) {
    const key = bitmap.readUInt32LE(i);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sampled = [...counts.values()].reduce((a, b) => a + b, 0);
  const dominant = counts.size === 0 ? 0 : Math.max(...counts.values());
  return {
    size: `${size.width}x${size.height}`,
    colours: counts.size,
    dominantShare: sampled === 0 ? 1 : dominant / sampled,
    empty: bitmap.length === 0,
  };
}

async function runCycle(index) {
  view = createView();
  attach(view);
  await sleep(settleMs);

  const before = measure(await view.webContents.capturePage());
  window.hide();

  // The app releases every view five minutes after the window goes away. This is that
  // state, shortened: hidden window, nothing attached.
  release();
  await sleep(hiddenMs);

  view = createView();
  attach(view);
  window.show();
  await sleep(settleMs);

  const after = measure(await view.webContents.capturePage());
  const flat = after.colours <= 1 || after.dominantShare > 0.999;
  console.log(
    `cycle ${index + 1}: before ${before.size} ${before.colours} colour(s); ` +
      `after ${after.size} ${after.colours} colour(s), ` +
      `dominant ${(after.dominantShare * 100).toFixed(1)}%; ` +
      `${flat ? 'NO FRAME' : 'painted'}`,
  );
  return flat;
}

await app.whenReady();

// Opaque, and a colour the page never uses, so a region the page cannot fill is obvious.
window = new BaseWindow({ width: 1000, height: 700, show: false, backgroundColor: '#00ff00' });

console.log(
  `backgroundThrottling ${backgroundThrottling ? 'on (default)' : 'off'}, ` +
    `${cycles} cycle(s), ${hiddenMs} ms hidden with nothing attached`,
);

let blanks = 0;
for (let i = 0; i < cycles; i += 1) {
  if (await runCycle(i)) blanks += 1;
}

console.log(`${blanks} of ${cycles} cycle(s) produced no frame`);
release();
window.destroy();
app.quit();
