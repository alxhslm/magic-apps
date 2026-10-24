import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/logger.ts', 'src/diagnostics.ts', 'src/ui-strings.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  external: ['electron', 'electron-log'],
  sourcemap: true,
  target: 'node20',
});
