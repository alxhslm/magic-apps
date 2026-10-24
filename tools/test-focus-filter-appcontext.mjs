#!/usr/bin/env node
/**
 * test-focus-filter-appcontext.mjs
 *
 * Runs a Focus Filter extension's `appContext` for real.
 *
 * The failure this guards is a trap inside Apple's own initialiser: asking
 * `FocusFilterAppContext(notificationFilterPredicate:)` for a context raises `SIGTRAP` when
 * the system requests it. Nothing about that shows up in a compile, a lint or a source
 * grep — only calling the getter does. Each extension is a bare `.appex` built by `swiftc`
 * rather than a SwiftPM target, so this compiles the same sources the appex's own
 * `build.sh` names, with a `@main` harness in place of the extension entry point, and runs
 * it.
 *
 * Usage:
 *   node tools/test-focus-filter-appcontext.mjs magimail
 *   node tools/test-focus-filter-appcontext.mjs magical
 *   pnpm --filter magimail run test:focus-filter
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APPS = {
  magimail: {
    intentType: 'MagimailFocusFilter',
    extension: 'apps/magimail/app-intents-extension',
  },
  magical: {
    intentType: 'MagicalFocusFilter',
    extension: 'apps/magical/app-intents-extension',
  },
};

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function pass(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg) {
  console.error(`  ${RED}✗${RESET} ${msg}`);
  process.exit(1);
}

const appName = process.argv[2];
const app = APPS[appName];
if (!app) {
  fail(`usage: ${path.basename(process.argv[1])} <${Object.keys(APPS).join('|')}>`);
}

console.log(`\x1b[1m▸ Running ${appName} Focus Filter appContext Test\x1b[0m\n`);

const extensionDir = path.join(REPO_ROOT, app.extension);
const buildScript = path.join(extensionDir, 'build.sh');
if (!fs.existsSync(buildScript)) fail(`build script not found: ${app.extension}/build.sh`);

// The sources are whatever the appex's own `build.sh` passes to `swiftc`, so this test
// compiles what ships and does not keep a second list that can drift.
const sources = [
  ...fs.readFileSync(buildScript, 'utf8').matchAll(/"\$SCRIPT_DIR\/([^"]+\.swift)"/g),
].map((match) => path.join(extensionDir, match[1]));
if (sources.length === 0) {
  fail(`no Swift sources found in ${app.extension}/build.sh`);
}

const entry = sources.find((source) => path.basename(source) === 'main.swift');
if (!entry) fail(`no main.swift among the sources in ${app.extension}/build.sh`);

// The extension declares `@main` on its `AppIntentsExtension`. The harness needs the only
// `@main` in the program, so drop that line from the copy and refuse to guess if it moves.
const entrySource = fs.readFileSync(entry, 'utf8');
const entryPoints = entrySource.split('\n').filter((line) => line.trim() === '@main').length;
if (entryPoints !== 1) {
  fail(`expected exactly one @main in ${path.relative(REPO_ROOT, entry)}, found ${entryPoints}`);
}

const harness = `import AppIntents
import Foundation

@main
struct FocusFilterAppContextHarness {
    static func main() {
        let context = ${app.intentType}().appContext
        guard context.notificationFilterPredicate == nil else {
            FileHandle.standardError.write(Data("appContext vends a notification predicate\\n".utf8))
            exit(1)
        }
        print("appContext vends no notification predicate")
    }
}
`;

const build = fs.mkdtempSync(path.join(os.tmpdir(), `${appName}-focus-filter-`));
const binary = path.join(build, 'focus-filter-harness');
const harnessPath = path.join(build, 'Harness.swift');

try {
  // Copied by basename: the appex's sources have distinct names, and this flattens the
  // `../swift/Sources/<module>/` hop without reproducing the tree. `main.swift` is renamed:
  // with the harness holding `@main`, a file still called main.swift is top-level code and
  // collides with it.
  const copied = sources.map((source) => {
    if (!fs.existsSync(source)) fail(`source not found: ${source}`);
    const name =
      path.basename(source) === 'main.swift' ? 'FocusFilterIntent.swift' : path.basename(source);
    const destination = path.join(build, name);
    fs.writeFileSync(
      destination,
      source === entry ? entrySource.replace(/^@main\n/m, '') : fs.readFileSync(source, 'utf8'),
    );
    return destination;
  });
  fs.writeFileSync(harnessPath, harness);

  // Same target and frameworks as each `app-intents-extension/build.sh`, minus the appex
  // entry point and the bundle.
  const compile = spawnSync(
    'swiftc',
    [
      '-target',
      'arm64-apple-macosx14.0',
      '-framework',
      'Foundation',
      '-framework',
      'AppIntents',
      '-framework',
      'ExtensionFoundation',
      '-o',
      binary,
      ...copied,
      harnessPath,
    ],
    { stdio: 'inherit' },
  );

  if (compile.error) {
    fail(`could not run swiftc: ${compile.error.message}`);
  }
  if (compile.status !== 0) {
    fail('the extension source did not compile with the harness');
  }

  const run = spawnSync(binary, [], { encoding: 'utf8' });
  // A trap surfaces as a signal, so check both: a null status means it died rather than
  // returned, which is exactly the failure mode being tested for.
  if (run.status !== 0) {
    fail(
      `appContext did not return cleanly (status ${run.status}, signal ${run.signal})\n` +
        '  A SIGTRAP here is `FocusFilterAppContext(notificationFilterPredicate:)`; ' +
        'return an empty `FocusFilterAppContext()` instead.',
    );
  }

  pass(run.stdout.trim());
  pass(`${app.intentType}.appContext cannot trap`);
} finally {
  fs.rmSync(build, { recursive: true, force: true });
}
