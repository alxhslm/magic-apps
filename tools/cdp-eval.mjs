#!/usr/bin/env node
/**
 * cdp-eval.mjs
 *
 * Query and inspect live Gmail or Calendar DOM and computed styles over CDP.
 *
 * Shared by both apps: account views are ordinary Chromium page targets, and
 * they are the only place to see what Google's own DOM is doing. Launch the app
 * under test with a debugging port first -- `pnpm run magimail:debug` (9222) or
 * `pnpm run magical:debug` (9223) -- then address it with --port.
 *
 * Usage:
 *   node tools/cdp-eval.mjs "document.title"
 *   node tools/cdp-eval.mjs --count 'img'
 *   node tools/cdp-eval.mjs --css '[role="navigation"]' backgroundColor color
 *   node tools/cdp-eval.mjs --screenshot /tmp/gmail-view.png
 *   node tools/cdp-eval.mjs --port 9223 "window.location.href"
 *   node tools/cdp-eval.mjs --target Work "location.hash"
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

let port = process.env.CDP_PORT || '9222';
let mode = 'eval';
let queryArg = '';
let props = [];
let screenshotPath = '';
let targetMatch = '';

let i = 0;
while (i < argv.length) {
  const arg = argv[i];
  if (arg === '--port') {
    port = argv[i + 1];
    i += 2;
  } else if (arg === '--target') {
    targetMatch = argv[i + 1];
    i += 2;
  } else if (arg === '--count') {
    mode = 'count';
    queryArg = argv[i + 1];
    i += 2;
  } else if (arg === '--css') {
    mode = 'css';
    queryArg = argv[i + 1];
    i += 2;
    while (i < argv.length && !argv[i].startsWith('--')) {
      props.push(argv[i]);
      i++;
    }
  } else if (arg === '--screenshot') {
    mode = 'screenshot';
    screenshotPath = argv[i + 1];
    i += 2;
  } else if (!arg.startsWith('--') && mode === 'eval' && !queryArg) {
    queryArg = arg;
    i++;
  } else {
    console.error(`Unknown or duplicate argument: ${arg}`);
    process.exit(1);
  }
}

if (!queryArg && mode !== 'screenshot') {
  console.log(`Usage:
  node scripts/cdp-eval.mjs "<expression>"
  node scripts/cdp-eval.mjs --count "<selector>"
  node scripts/cdp-eval.mjs --css "<selector>" [prop1 prop2 ...]
  node scripts/cdp-eval.mjs --screenshot <path> [--port <port>]
  node scripts/cdp-eval.mjs --target <title substring> "<expression>"`);
  process.exit(1);
}

// 1. Fetch CDP targets
let targets;
try {
  const res = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`);
  targets = await res.json();
} catch {
  console.error(`✗ Cannot connect to CDP on 127.0.0.1:${port}`);
  console.error(
    '  Launch the app in debug mode first: pnpm run magimail:debug (9222) or pnpm run magical:debug (9223)',
  );
  process.exit(1);
}

// Prefer mail.google.com or calendar.google.com page targets. Each account runs
// its own view, so with more than one awake the first Gmail target is whichever
// the debugger happens to list first: name the account with --target to say which.
const pages = targets.filter((t) => t.type === 'page');
const googlePages = pages.filter(
  (t) => t.url.includes('mail.google.com') || t.url.includes('calendar.google.com'),
);
const candidates = googlePages.length > 0 ? googlePages : pages;
const pageTarget = targetMatch
  ? candidates.find((t) => (t.title || '').toLowerCase().includes(targetMatch.toLowerCase()))
  : candidates[0];

if (targetMatch && !pageTarget) {
  console.error(`\u2717 No page target titled like "${targetMatch}" on port ${port}. Found:`);
  for (const t of candidates) console.error(`  ${t.title}`);
  process.exit(1);
}

if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
  console.error(`✗ No attachable page target found on port ${port}. Found:`, targets);
  process.exit(1);
}

// 2. Build CDP evaluation expression or command
let evalExpr = '';
if (mode === 'eval') {
  evalExpr = queryArg;
} else if (mode === 'count') {
  evalExpr = `(() => {
    const els = document.querySelectorAll(${JSON.stringify(queryArg)});
    return { selector: ${JSON.stringify(queryArg)}, count: els.length };
  })()`;
} else if (mode === 'css') {
  evalExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(queryArg)});
    if (!el) return { error: 'Element not found for selector: ' + ${JSON.stringify(queryArg)} };
    const cs = window.getComputedStyle(el);
    const requested = ${JSON.stringify(props)};
    const defaultProps = ['display', 'visibility', 'opacity', 'color', 'background-color', 'width', 'height', 'filter'];
    const keys = requested.length > 0 ? requested : defaultProps;
    const result = {};
    for (const k of keys) {
      result[k] = cs.getPropertyValue(k) || cs[k] || null;
    }
    return result;
  })()`;
}

// 3. Connect WebSocket and dispatch CDP request
//
// The target can be released from under us after it has been picked: both apps destroy
// an idle account's view after inactiveAccountSuspendMinutes, which closes this socket
// without ever answering the command in flight. Reject on that rather than leaving the
// await pending, so the process exits with the cause named instead of hanging.
let targetGone = false;
const ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error(`could not open a debugger connection on 127.0.0.1:${port}`));
});

try {
  if (mode === 'screenshot') {
    const res = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    if (res.error) {
      console.error('✗ Screenshot error:', res.error);
      process.exit(1);
    }
    const buf = Buffer.from(res.result.data, 'base64');
    const outPath = path.resolve(screenshotPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    console.log(`✓ Screenshot saved to: ${outPath} (${buf.length} bytes)`);
  } else {
    const res = await sendCdp(ws, 'Runtime.evaluate', {
      expression: evalExpr,
      returnByValue: true,
      awaitPromise: true,
    });

    if (res.error) {
      console.error('✗ CDP Error:', res.error);
      process.exit(1);
    }

    const { result, exceptionDetails } = res.result;
    if (exceptionDetails) {
      console.error(
        '✗ JavaScript Exception:',
        exceptionDetails.exception?.description || exceptionDetails.text,
      );
      process.exit(1);
    }

    if (result && 'value' in result) {
      if (typeof result.value === 'object' && result.value !== null) {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(result.value);
      }
    } else {
      console.log(result);
    }
  }
} catch (err) {
  if (!targetGone) throw err;
  console.error('\u2717 The page went away before it answered.');
  console.error("  Both apps release an idle account's view after inactiveAccountSuspendMinutes.");
  console.error('  0 keeps every visited account resident, and the account on screen is not');
  console.error(
    '  exempt: set it to 0 for the profile under test, or re-run while the view is live.',
  );
  process.exit(1);
} finally {
  ws.close();
}

function sendCdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onMsg = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id) settle(resolve, data);
      } catch (err) {
        settle(reject, err);
      }
    };
    // A target that is released closes the socket without ever answering the in-flight
    // command; reject rather than leaving the await pending.
    const onClose = () => {
      targetGone = true;
      settle(reject, new Error('the page went away'));
    };
    const onError = () => {
      targetGone = true;
      settle(reject, new Error('the debugger connection errored'));
    };
    // Backstop for a page that accepts the command and never answers.
    timer = setTimeout(() => settle(reject, new Error('the page did not answer in time')), 30000);
    timer.unref?.();
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      settle(reject, err);
    }
  });
}
