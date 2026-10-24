import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { LogSink } from './types.js';

/**
 * The Electron side of a Swift helper: spawn it, and carry newline-delimited
 * JSON-RPC over its stdio.
 *
 * Knows nothing about what the messages mean — the method names, the settings
 * model and the windows all stay in the app. What it owns is the framing, the
 * request/response correlation and the transparent respawn, which both apps had
 * their own copy of.
 *
 * One helper per `SwiftHelper` instance. Each app makes its own and holds it.
 */

export type HelperEventCallback = (method: string, params: Record<string, unknown>) => void;
export type HelperSpawnedCallback = () => void;

export interface SwiftHelperOptions {
  /** Absolute paths to try in order; the first that exists is used. */
  candidatePaths: string[];
  /**
   * Prefix for log lines, e.g. `[MagimailHelper]`. Redundant when `logger` is a
   * scoped logger that already names the subsystem, so it defaults to nothing.
   */
  logPrefix?: string;
  /** Where diagnostics go. Defaults to `console`. */
  logger?: LogSink;
  /** How long to wait for a reply before resolving null. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * A diagnostic line from the helper, as `LEVEL|Category|message`.
 *
 * The helper writes these to stderr; stdout is the JSON-RPC pipe and anything
 * non-JSON on it is dropped. Without the level marker every helper warning
 * would arrive as an info line that happens to contain the word "warning".
 */
const HELPER_LOG_LINE = /^([EWI])\|([^|]*)\|(.*)$/;

export class SwiftHelper {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private eventCallback: HelperEventCallback | null = null;
  private spawnedCallback: HelperSpawnedCallback | null = null;

  private readonly log: LogSink;

  constructor(private readonly options: SwiftHelperOptions) {
    this.log = options.logger ?? console;
  }

  /** Message with the prefix attached, or untouched when there is none. */
  private tag(text: string): string {
    const prefix = this.options.logPrefix;
    return prefix ? `${prefix} ${text}` : text;
  }

  /** The first candidate path that exists, or null if the binary is missing. */
  public resolvePath(): string | null {
    for (const candidate of this.options.candidatePaths) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  public isAvailable(): boolean {
    return this.resolvePath() !== null;
  }

  public isRunning(): boolean {
    return this.process !== null;
  }

  public spawn(): boolean {
    if (this.process) return true;

    const helperPath = this.resolvePath();
    if (!helperPath) {
      this.log.warn(this.tag('Binary not found: its native UI is absent this run'));
      return false;
    }

    const args: string[] = [];
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if ((arg === '-AppleLanguages' || arg === '-AppleLocale') && i + 1 < argv.length) {
        args.push(arg, argv[i + 1]);
        i++;
      }
    }

    const proc = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = proc;

    // A non-zero exit is the helper crashing, and takes the menu bar item,
    // settings window and notifications with it. It must not be an info line.
    proc.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      if (code === 0 || signal === 'SIGTERM') {
        this.log.info(this.tag(`Exited (${how})`));
      } else {
        this.log.error(this.tag(`Exited abnormally (${how})`));
      }
      if (this.process === proc) {
        this.process = null;
      }
    });
    proc.on('error', (err) => {
      this.log.error(this.tag('Failed to spawn:'), err);
      if (this.process === proc) {
        this.process = null;
      }
    });

    if (this.process.stdout) {
      const rl = readline.createInterface({ input: this.process.stdout });
      rl.on('line', (line) => this.handleLine(line));
    }
    if (this.process.stderr) {
      const rl = readline.createInterface({ input: this.process.stderr });
      rl.on('line', (line) => this.handleStderr(line));
    }

    this.log.info(this.tag('Started'));
    // Deferred: `send` respawns from inside its own write path, and the callback
    // sends down that same path.
    if (this.spawnedCallback) setImmediate(this.spawnedCallback);
    return true;
  }

  /** Maps a helper stderr line onto the matching level, prefix intact. */
  private handleStderr(line: string): void {
    const match = HELPER_LOG_LINE.exec(line);
    if (!match) {
      this.log.info(this.tag(line));
      return;
    }
    const [, level, category, text] = match;
    const message = this.tag(`${category ? `(${category}) ` : ''}${text}`);
    if (level === 'E') this.log.error(message);
    else if (level === 'W') this.log.warn(message);
    else this.log.info(message);
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line);

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.eventCallback?.(msg.method, msg.params ?? {});
      }
    } catch {
      // Ignore malformed JSON.
    }
  }

  /** Sends a request, respawning the helper if it has died. Resolves null on
   *  timeout or if the helper cannot be started. */
  public send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.process || !this.process.stdin?.writable) {
        if (!this.spawn() || !this.process?.stdin?.writable) {
          // Every caller treats null as "no native UI this run" and carries on,
          // so without this line a dead helper looks like a working one.
          this.log.error(this.tag(`${method} dropped: the helper is not running`));
          resolve(null);
          return;
        }
      }

      const id = ++this.requestId;
      this.pending.set(id, resolve);
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);

      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          // The helper is alive, so nothing else writes a line: no exit code,
          // no spawn failure. A Settings window that never opens, a menu bar
          // item that never appears and a banner that never fires all arrive
          // here, and all of them look identical to nothing having happened.
          this.log.error(this.tag(`${method} timed out after ${timeoutMs}ms`));
          resolve(null);
          this.kill();
        }
      }, timeoutMs);
    });
  }

  public onEvent(callback: HelperEventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Registers a callback fired whenever a helper process starts.
   *
   * A replacement helper is a blank one, and `send` respawns transparently — so
   * this is where state held on this side is replayed into it.
   */
  public onSpawned(callback: HelperSpawnedCallback): void {
    this.spawnedCallback = callback;
  }

  public getPid(): number | null {
    return this.process?.pid ?? null;
  }

  public kill(): void {
    const pendingResolvers = Array.from(this.pending.values());
    this.pending.clear();
    for (const resolve of pendingResolvers) {
      resolve(null);
    }
    this.process?.kill();
    this.process = null;
  }
}
