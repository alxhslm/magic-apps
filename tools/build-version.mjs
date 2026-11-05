#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A release passes its target version explicitly; every other build names the
 * commit it came from. The checked-in version stays 0.0.0 and is only the base
 * for a development build, so a build never writes to package.json.
 */
export function resolveBuildVersion({ packageVersion, commit, explicit = '' }) {
  if (explicit) {
    return explicit;
  }
  return `${packageVersion}-dev+${commit}`;
}

function readPackageVersion(appDir) {
  return JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
}

function readCommit(appDir) {
  return execFileSync('git', ['-C', appDir, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const appDir = process.argv[2];
  if (!appDir) {
    throw new Error('usage: tools/build-version.mjs <app-dir>');
  }
  process.stdout.write(
    resolveBuildVersion({
      packageVersion: readPackageVersion(appDir),
      commit: readCommit(appDir),
      explicit: process.env.MAGIC_BUILD_VERSION ?? '',
    }) + '\n',
  );
}
