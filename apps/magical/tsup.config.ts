import { defineConfig } from 'tsup';

// Stamped into the main bundle at compile time so the main process can refuse
// to start a packaged pre-release build once it is more than 90 days old; see
// `prerelease-build-expiry.ts` in @magimail/core. MAGIC_BUILD_TIMESTAMP pins the
// stamp, so a packaged build can be made to look old and the refusal verified.
const BUILD_TIMESTAMP = Number(process.env.MAGIC_BUILD_TIMESTAMP) || Date.now();

export default defineConfig({
  define: { __BUILD_TIMESTAMP__: JSON.stringify(BUILD_TIMESTAMP) },
  // `calendar-decoder` and `calendar-recurrence` are entries of their own so the canaries in
  // `tools/` can require the production decoder and expander without pulling in electron.
  entry: [
    'src/main.ts',
    'src/calendar-preload.ts',
    'src/calendar-decoder.ts',
    'src/calendar-recurrence.ts',
  ],
  format: ['cjs'],
  clean: true,
  external: ['electron'],
  sourcemap: true,
  target: 'node20',
});
