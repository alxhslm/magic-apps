import { defineConfig } from 'tsup';

// Stamped into the main bundle at compile time so the main process can refuse
// to start a packaged pre-release build once it is more than 90 days old; see
// `prerelease-build-expiry.ts` in @magimail/core. MAGIC_BUILD_TIMESTAMP pins the
// stamp, so a packaged build can be made to look old and the refusal verified.
const BUILD_TIMESTAMP = Number(process.env.MAGIC_BUILD_TIMESTAMP) || Date.now();

export default defineConfig({
  define: { __BUILD_TIMESTAMP__: JSON.stringify(BUILD_TIMESTAMP) },
  entry: ['src/main.ts', 'src/preload.ts', 'src/css.ts', 'src/extensions-popup-preload.ts'],
  format: ['cjs'],
  clean: true,
  external: ['electron'],
  sourcemap: true,
  target: 'node20',
  onSuccess: async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const srcExtPopup = path.resolve(__dirname, 'src/extensions-popup.html');
    const distExtPopup = path.resolve(__dirname, 'dist/extensions-popup.html');
    if (fs.existsSync(srcExtPopup)) {
      fs.copyFileSync(srcExtPopup, distExtPopup);
    }
    const srcAssets = path.resolve(__dirname, 'src/assets');
    const distAssets = path.resolve(__dirname, 'dist/assets');
    if (fs.existsSync(srcAssets)) {
      fs.cpSync(srcAssets, distAssets, { recursive: true });
    }
    const srcExt = path.resolve(__dirname, 'resources/extensions');
    const distExt = path.resolve(__dirname, 'dist/resources/extensions');
    if (fs.existsSync(srcExt)) {
      fs.cpSync(srcExt, distExt, { recursive: true });
    }
  },
});
