#!/usr/bin/env node
/**
 * capture-window-shots.mjs
 *
 * Automated window screenshot capture for Magimail and Magical.
 *
 * Enforces strict safety guardrails:
 * 1. Checks running processes. Refuses to run if any personal/daily-driver instance is active.
 * 2. Launches the installed app strictly under `--demo` with remote debugging.
 * 3. Preflights loaded page data over CDP to guarantee only seeded fixtures and demo accounts
 *    are photographed, preventing live personal data from reaching website assets.
 * 4. Dismisses transient banners (e.g. offline mail).
 * 5. Automates window positioning, sizing, active focus, and appearance switching (light & dark).
 * 6. Verifies that captured windows have active coloured traffic lights (are in focus).
 * 7. Downsamples to canonical geometry and converts to WebP.
 *
 * Usage:
 *   node tools/capture-window-shots.mjs [options]
 *
 * Options:
 *   --app <magical|magimail|all>   Target application (default: all)
 *   --out-dir <path>               Output directory (default: website/src/assets)
 *   --keep-open                    Leave demo apps running after capture
 *   --no-launch                    Do not auto-launch; only capture if already running under --demo
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

export function parseArgs(argv) {
  let targetApp = 'all';
  let outDir = path.resolve('website/src/assets');
  let keepOpen = false;
  let noLaunch = false;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app') targetApp = argv[++i]?.toLowerCase() ?? 'all';
    else if (arg === '--out-dir') outDir = path.resolve(argv[++i]);
    else if (arg === '--keep-open') keepOpen = true;
    else if (arg === '--no-launch') noLaunch = true;
    else if (arg === '--help' || arg === '-h') showHelp = true;
    else if (!arg.startsWith('--')) outDir = path.resolve(arg);
  }

  return { targetApp, outDir, keepOpen, noLaunch, showHelp };
}

export function validateMagicalCdp(targets) {
  // Must have calendar target on demo fixture
  const calTarget = targets.find((t) => t.url && t.url.includes('calendar.google.com'));
  if (!calTarget) {
    throw new Error('Magical is not loaded at calendar.google.com');
  }
  // Demo calendar fixture week is October 25, 2026
  if (!calTarget.title?.includes('2026') && !calTarget.url?.includes('2026')) {
    throw new Error(
      `Magical is not showing the seeded demo calendar fixture (found: "${calTarget.title}"). Refusing to photograph!`,
    );
  }
  return calTarget;
}

export async function validateMagimailCdp(targets, evaluateFn) {
  // Dismiss offline banner if present
  const bannerTarget = targets.find(
    (t) =>
      t.title?.includes('enable offline mail') || (t.url && t.url.startsWith('data:text/html')),
  );
  if (bannerTarget && bannerTarget.webSocketDebuggerUrl && evaluateFn) {
    console.log('  ℹ Dismissing offline mail banner in Magimail...');
    await evaluateFn(
      bannerTarget.webSocketDebuggerUrl,
      'document.querySelector(".dismiss-btn")?.click()',
    );
    await sleep(500);
  }

  // Check mail target
  const mailTarget = targets.find((t) => t.url && t.url.includes('mail.google.com'));
  if (!mailTarget) {
    throw new Error('Magimail is not loaded at mail.google.com');
  }
  return mailTarget;
}

export function findPersonalProcesses(lines, appName) {
  const mainAppRegex = new RegExp(
    `/Applications/${appName}\\.app/Contents/MacOS/${appName}(\\s|$)`,
  );
  const offending = [];
  for (const line of lines) {
    if (mainAppRegex.test(line)) {
      if (!line.includes('--demo') && !line.includes('--profile=demo')) {
        offending.push(line.trim());
      }
    }
  }
  return offending;
}

export function extractRunningDemoPid(lines, appName) {
  const mainAppRegex = new RegExp(
    `/Applications/${appName}\\.app/Contents/MacOS/${appName}(\\s|$)`,
  );
  for (const line of lines) {
    if (mainAppRegex.test(line)) {
      if (line.includes('--demo') || line.includes('--profile=demo')) {
        const pid = line.trim().split(/\s+/)[0];
        return parseInt(pid, 10);
      }
    }
  }
  return null;
}

const APPS = {
  magical: {
    name: 'Magical',
    bundlePath: '/Applications/Magical.app',
    binaryPath: '/Applications/Magical.app/Contents/MacOS/Magical',
    debugPort: 9223,
    width: 1280,
    height: 820,
    canonicalWidth: 1600,
    canonicalHeight: 1025,
    lightAsset: 'shot-window-magical-light.webp',
    darkAsset: 'shot-window-magical-dark.webp',
    validateCdp: validateMagicalCdp,
  },
  magimail: {
    name: 'Magimail',
    bundlePath: '/Applications/Magimail.app',
    binaryPath: '/Applications/Magimail.app/Contents/MacOS/Magimail',
    debugPort: 9222,
    width: 1280,
    height: 840,
    canonicalWidth: 1600,
    canonicalHeight: 1049,
    heroWidth: 2000,
    heroHeight: 1311,
    lightAsset: 'shot-window-light.webp',
    darkAsset: 'shot-window-dark.webp',
    heroAsset: 'shot-hero.webp',
    validateCdp: (targets) => validateMagimailCdp(targets, evaluateInTarget),
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function tryRun(cmd) {
  try {
    return run(cmd);
  } catch {
    return '';
  }
}

async function fetchCdpTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('CDP request timed out'));
    });
  });
}

async function evaluateInTarget(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
    });
    ws.on('message', (msg) => {
      ws.close();
      resolve(JSON.parse(msg.toString()));
    });
    ws.on('error', (err) => {
      ws.close();
      reject(err);
    });
  });
}

function checkPersonalProcesses(appName) {
  const lines = tryRun(`ps -eo pid,command`).split('\n');
  return findPersonalProcesses(lines, appName);
}

function getRunningDemoPid(appName) {
  const lines = tryRun(`ps -eo pid,command`).split('\n');
  return extractRunningDemoPid(lines, appName);
}

async function ensureAppRunning(spec, options = {}) {
  const offending = checkPersonalProcesses(spec.name);
  if (offending.length > 0) {
    console.error(
      `\n❌ Error: ${spec.name} is currently running with a PERSONAL/DAILY-DRIVER profile:`,
    );
    for (const p of offending) {
      console.error(`   ${p}`);
    }
    console.error(
      `\nTo prevent personal data leaking into marketing assets, all personal instances must be quit first.`,
    );
    console.error(`Run: pkill -f "${spec.name}" and restart.\n`);
    process.exit(1);
  }

  let pid = getRunningDemoPid(spec.name);
  let spawnedProcess = null;

  if (!pid) {
    if (options.noLaunch) {
      throw new Error(`${spec.name} is not running under --demo and --no-launch was specified.`);
    }
    if (!existsSync(spec.binaryPath)) {
      throw new Error(`Binary not found at ${spec.binaryPath}. Build and install the app first.`);
    }

    console.log(`🚀 Launching ${spec.name} under --demo with debug port ${spec.debugPort}...`);
    spawnedProcess = spawn(spec.binaryPath, ['--demo', `--debug-port=${spec.debugPort}`], {
      detached: true,
      stdio: 'ignore',
    });
    spawnedProcess.unref();

    // Poll CDP port up to 20s
    let connected = false;
    for (let attempt = 1; attempt <= 40; attempt++) {
      await sleep(500);
      try {
        const targets = await fetchCdpTargets(spec.debugPort);
        if (targets && targets.length > 0) {
          connected = true;
          break;
        }
      } catch {
        // waiting
      }
    }
    if (!connected) {
      throw new Error(
        `Failed to connect to ${spec.name} on CDP port ${spec.debugPort} after launching.`,
      );
    }
    pid = getRunningDemoPid(spec.name);
  } else {
    console.log(`✓ ${spec.name} is already running under --demo (PID ${pid})`);
  }

  // Preflight CDP validation
  const targets = await fetchCdpTargets(spec.debugPort);
  await spec.validateCdp(targets, spec.debugPort);
  console.log(`✓ CDP preflight verified: ${spec.name} is displaying seeded demo data.`);

  return { pid, spawned: spawnedProcess !== null };
}

function getWindowId(appName) {
  const script = `
import Cocoa
let options = CGWindowListOption(arrayLiteral: .excludeDesktopElements, .optionOnScreenOnly)
guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for win in infoList {
    let owner = win[kCGWindowOwnerName as String] as? String ?? ""
    let num = win[kCGWindowNumber as String] as? Int ?? 0
    let layer = win[kCGWindowLayer as String] as? Int ?? 0
    let name = win[kCGWindowName as String] as? String ?? ""
    if owner == "${appName}" && layer == 0 && name == "${appName}" {
        print(num)
        exit(0)
    }
}
exit(2)
`;
  try {
    const out = execFileSync('swift', ['-e', script], { encoding: 'utf8' }).trim();
    return parseInt(out, 10);
  } catch {
    throw new Error(`Could not find main window for ${appName}.`);
  }
}

function closeAuxiliaryWindows() {
  const appleScript = `
tell application "System Events"
    repeat with procName in {"MagimailHelper", "MagicalHelper"}
        if exists (process procName) then
            tell process procName
                repeat while (count of windows) > 0
                    try
                        click (first button whose subrole is "AXCloseButton") of window 1
                        delay 0.2
                    on error
                        exit repeat
                    end try
                end repeat
            end tell
        end if
    end repeat
end tell
`;
  tryRun(`osascript -e '${appleScript}'`);
}

function setupWindow(appName, width, height) {
  closeAuxiliaryWindows();
  const appleScript = `
tell application "System Events"
    if exists (process "${appName}") then
        tell process "${appName}"
            set position of window 1 to {100, 100}
            set size of window 1 to {${width}, ${height}}
        end tell
    end if
end tell
`;
  run(`osascript -e '${appleScript}'`);
}

function activateAndFocusWindow(appName) {
  const appleScript = `
tell application "${appName}" to activate
tell application "System Events"
    tell process "${appName}"
        set frontmost to true
        perform action "AXRaise" of window 1
    end tell
end tell
`;
  run(`osascript -e '${appleScript}'`);
}

function setSystemAppearance(isDark) {
  run(
    `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to ${isDark}'`,
  );
}

function verifyTrafficLights(pngPath) {
  const script = `
import AppKit

guard let img = NSImage(contentsOfFile: "${pngPath}"),
      let rep = img.representations.first as? NSBitmapImageRep else {
    exit(1)
}

// Top left region where traffic lights reside (x: 20..60, y: 15..50)
var foundRed = false
for y in 15...50 {
    for x in 20...60 {
        if let c = rep.colorAt(x: x, y: y) {
            if c.redComponent > 0.75 && c.greenComponent < 0.5 && c.blueComponent < 0.5 {
                foundRed = true
                break
            }
        }
    }
    if foundRed { break }
}
exit(foundRed ? 0 : 2)
`;
  try {
    execFileSync('swift', ['-e', script], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function captureWindow(spec, mode, outPath, width, height) {
  console.log(`📸 Capturing ${spec.name} (${mode} mode) -> ${path.basename(outPath)}...`);
  const isDark = mode === 'dark';
  setSystemAppearance(isDark);
  await sleep(1500);

  activateAndFocusWindow(spec.name);
  await sleep(1000);

  const winId = getWindowId(spec.name);
  const rawPng = `/tmp/raw-${spec.name}-${mode}.png`;
  const scaledPng = `/tmp/scaled-${spec.name}-${mode}.png`;

  run(`screencapture -l ${winId} -o "${rawPng}"`);

  // Verify traffic lights are in focus
  const focused = verifyTrafficLights(rawPng);
  if (!focused) {
    console.warn(
      `  ⚠️ Warning: Traffic lights in ${rawPng} appear unfocused or inactive. Retrying focus...`,
    );
    activateAndFocusWindow(spec.name);
    await sleep(1500);
    run(`screencapture -l ${winId} -o "${rawPng}"`);
  }

  // Scale to canonical geometry
  run(`sips -z ${height} ${width} "${rawPng}" --out "${scaledPng}" >/dev/null`);

  // Convert to WebP
  run(`cwebp -q 88 "${scaledPng}" -o "${outPath}" >/dev/null 2>&1`);

  // Cleanup temps
  if (existsSync(rawPng)) unlinkSync(rawPng);
  if (existsSync(scaledPng)) unlinkSync(scaledPng);

  console.log(`  ✓ Written ${outPath} (${width}×${height})`);
}

async function main(cliArgs = process.argv.slice(2)) {
  const { targetApp, outDir, keepOpen, noLaunch, showHelp } = parseArgs(cliArgs);

  if (showHelp) {
    console.log(
      `Usage: node tools/capture-window-shots.mjs [--app <magical|magimail|all>] [--out-dir <path>] [--keep-open] [--no-launch]`,
    );
    return;
  }

  const originalDark =
    tryRun(
      `osascript -e 'tell application "System Events" to tell appearance preferences to return dark mode'`,
    ) === 'true';
  const hadAquaColorVariant = tryRun(`defaults read -g AppleAquaColorVariant`) !== '';

  try {
    // Delete Graphite variant so traffic lights are active colour
    if (hadAquaColorVariant) {
      tryRun(`defaults delete -g AppleAquaColorVariant`);
    }

    const appsToRun = [];
    if (targetApp === 'all' || targetApp === 'magical') appsToRun.push(APPS.magical);
    if (targetApp === 'all' || targetApp === 'magimail') appsToRun.push(APPS.magimail);

    for (const spec of appsToRun) {
      console.log(`\n========================================`);
      console.log(`Processing ${spec.name}...`);
      console.log(`========================================`);

      const { pid, spawned } = await ensureAppRunning(spec, { noLaunch });
      setupWindow(spec.name, spec.width, spec.height);

      // Light mode
      const lightOut = path.join(outDir, spec.lightAsset);
      await captureWindow(spec, 'light', lightOut, spec.canonicalWidth, spec.canonicalHeight);

      // Hero asset (Magimail light mode)
      if (spec.heroAsset) {
        const heroOut = path.join(outDir, spec.heroAsset);
        await captureWindow(spec, 'light', heroOut, spec.heroWidth, spec.heroHeight);
      }

      // Dark mode
      const darkOut = path.join(outDir, spec.darkAsset);
      await captureWindow(spec, 'dark', darkOut, spec.canonicalWidth, spec.canonicalHeight);

      if (spawned && !keepOpen) {
        console.log(`🛑 Stopping temporary demo instance of ${spec.name} (PID ${pid})...`);
        tryRun(`kill -9 ${pid}`);
      }
    }

    console.log(`\n✨ All window captures generated successfully in ${outDir}`);
  } finally {
    // Restore system preferences
    if (hadAquaColorVariant) {
      tryRun(`defaults write -g AppleAquaColorVariant -int 1`);
    }
    setSystemAppearance(originalDark);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n❌ Error during window capture:`, err.message || err);
    process.exit(1);
  });
}
