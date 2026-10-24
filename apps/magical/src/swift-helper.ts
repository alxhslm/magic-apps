import * as path from 'node:path';
import { SwiftHelper, type HelperEventCallback } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

/**
 * `MagicalHelper` — the settings window's process.
 *
 * Only the binary's whereabouts are local; the JSON-RPC framing and respawn
 * live in core. In a packaged app the helper is `Contents/MacOS/MagicalHelper`,
 * and that directory is load-bearing: it is what gives the helper the app's
 * bundle identity.
 */
const helper = new SwiftHelper({
  logger: createLogger('SwiftHelper'),
  candidatePaths: [
    // Production: beside the Electron executable, so it *is* Magical.app.
    path.resolve(process.resourcesPath || '', '..', 'MacOS', 'MagicalHelper'),
    // Dev: built from swift/, release or debug, with and without the
    // architecture-scoped path SwiftPM uses on some toolchains.
    path.resolve(__dirname, '../swift/.build/release/MagicalHelper'),
    path.resolve(__dirname, '../../swift/.build/release/MagicalHelper'),
    path.resolve(__dirname, '../swift/.build/arm64-apple-macosx/release/MagicalHelper'),
    path.resolve(__dirname, '../../swift/.build/arm64-apple-macosx/release/MagicalHelper'),
    path.resolve(__dirname, '../swift/.build/debug/MagicalHelper'),
    path.resolve(__dirname, '../../swift/.build/debug/MagicalHelper'),
    path.resolve(__dirname, '../swift/.build/arm64-apple-macosx/debug/MagicalHelper'),
    path.resolve(__dirname, '../../swift/.build/arm64-apple-macosx/debug/MagicalHelper'),
  ],
});

export function isHelperAvailable(): boolean {
  return helper.isAvailable();
}

export function spawnHelper(): boolean {
  return helper.spawn();
}

export function sendToHelper(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return helper.send(method, params);
}

export function onHelperEvent(callback: HelperEventCallback): void {
  helper.onEvent(callback);
}

/**
 * Registers a callback fired whenever a helper process starts.
 *
 * A replacement helper is a blank one, and `sendToHelper` respawns
 * transparently — so this is where state held on this side is replayed into it.
 */
export function onHelperSpawned(callback: () => void): void {
  helper.onSpawned(callback);
}

export function killHelper(): void {
  helper.kill();
}

export function isHelperRunning(): boolean {
  return helper.isRunning();
}

export function getHelperPid(): number | null {
  return helper.getPid();
}
