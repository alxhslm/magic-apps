import * as path from 'node:path';
import { SwiftHelper, type HelperEventCallback } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

/**
 * `MagimailHelper` — the menu bar item, settings window, notifications and
 * widget reloads.
 *
 * Only the binary's whereabouts are local; the JSON-RPC framing and respawn live
 * in core. In a packaged app this is `Contents/MacOS/MagimailHelper`, and the
 * directory is load-bearing: it is what gives the helper the app's bundle
 * identity. See `docs/shared/notifications.md#bundle-identity`.
 */
const helper = new SwiftHelper({
  logger: createLogger('SwiftHelper'),
  candidatePaths: [
    // Production: beside the Electron executable, so it *is* Magimail.app.
    path.resolve(process.resourcesPath || '', '..', 'MacOS', 'MagimailHelper'),
    // Dev: built from swift/ (release or debug)
    path.resolve(__dirname, '../../swift/.build/release/MagimailHelper'),
    path.resolve(__dirname, '../swift/.build/release/MagimailHelper'),
    path.resolve(__dirname, '../../swift/.build/arm64-apple-macosx/release/MagimailHelper'),
    path.resolve(__dirname, '../swift/.build/arm64-apple-macosx/release/MagimailHelper'),
    path.resolve(__dirname, '../../swift/.build/debug/MagimailHelper'),
    path.resolve(__dirname, '../swift/.build/debug/MagimailHelper'),
    path.resolve(__dirname, '../../swift/.build/arm64-apple-macosx/debug/MagimailHelper'),
    path.resolve(__dirname, '../swift/.build/arm64-apple-macosx/debug/MagimailHelper'),
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
