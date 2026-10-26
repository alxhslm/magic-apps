import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcAssetsDir = path.resolve(__dirname, 'src/assets');
const magimailIcon = path.resolve(__dirname, '../apps/magimail/build/icon.svg');
const magicalIcon = path.resolve(__dirname, '../apps/magical/build/icon.svg');

function magicAppsAssets() {
  return {
    name: 'magic-apps-assets',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/assets/magimail.svg') {
            res.setHeader('Content-Type', 'image/svg+xml');
            return fs.createReadStream(magimailIcon).pipe(res);
          }
          if (req.url === '/assets/magical.svg') {
            res.setHeader('Content-Type', 'image/svg+xml');
            return fs.createReadStream(magicalIcon).pipe(res);
          }
          if (req.url?.startsWith('/assets/')) {
            const filename = req.url.slice('/assets/'.length).split('?')[0];
            const filePath = path.join(srcAssetsDir, filename);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
              else if (filePath.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
              else if (filePath.endsWith('.webp')) res.setHeader('Content-Type', 'image/webp');
              else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg'))
                res.setHeader('Content-Type', 'image/jpeg');
              return fs.createReadStream(filePath).pipe(res);
            }
          }
          next();
        });
      },
      'astro:build:done': async ({ dir }) => {
        const outAssetsDir = path.join(fileURLToPath(dir), 'assets');
        fs.mkdirSync(outAssetsDir, { recursive: true });
        if (fs.existsSync(srcAssetsDir)) {
          fs.cpSync(srcAssetsDir, outAssetsDir, { recursive: true });
        }
        if (fs.existsSync(magimailIcon)) {
          fs.copyFileSync(magimailIcon, path.join(outAssetsDir, 'magimail.svg'));
        }
        if (fs.existsSync(magicalIcon)) {
          fs.copyFileSync(magicalIcon, path.join(outAssetsDir, 'magical.svg'));
        }
        const suiteSvg = path.join(srcAssetsDir, 'suite.svg');
        if (fs.existsSync(suiteSvg)) {
          fs.copyFileSync(suiteSvg, path.join(fileURLToPath(dir), 'favicon.svg'));
        }
      },
    },
  };
}

export default defineConfig({
  site: 'https://macmagic.app',
  outDir: './_site',
  build: {
    format: 'file',
  },
  integrations: [
    starlight({
      title: 'Magic Apps',
      favicon: '/favicon.svg',
      logo: {
        src: './src/assets/suite.svg',
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/alxhslm/magic-apps',
        },
      ],
      disable404Route: true,
      customCss: ['./src/assets/docs.css'],
      components: {
        Header: './src/components/DocsHeader.astro',
        Footer: './src/components/DocsFooter.astro',
      },
      sidebar: [
        {
          label: 'Overview',
          link: '/help/',
        },
        {
          label: 'Magimail',
          items: [
            { label: 'Getting Started', link: '/help/magimail/getting-started/' },
            { label: 'Quick Compose', link: '/help/magimail/quick-compose/' },
            { label: 'Settings Reference', link: '/help/magimail/settings/' },
            { label: 'Multiple Accounts', link: '/help/magimail/accounts/' },
            { label: 'Keyboard Shortcuts', link: '/help/magimail/shortcuts/' },
            { label: 'Window Toolbar', link: '/help/magimail/toolbar/' },
            { label: 'Menu Bar & Popover', link: '/help/magimail/menu-bar/' },
            { label: 'Notifications & Badges', link: '/help/magimail/notifications/' },
            { label: 'Desktop Widgets', link: '/help/magimail/widgets/' },
            { label: 'Share Sheet Extension', link: '/help/magimail/share-sheet/' },
            { label: 'Deep Links & Automation', link: '/help/magimail/deep-links/' },
            { label: 'Focus Filters', link: '/help/magimail/focus-filters/' },
          ],
        },
        {
          label: 'Magical',
          items: [
            { label: 'Getting Started', link: '/help/magical/getting-started/' },
            { label: 'Settings Reference', link: '/help/magical/settings/' },
            { label: 'Multiple Accounts', link: '/help/magical/accounts/' },
            { label: 'Keyboard Shortcuts', link: '/help/magical/shortcuts/' },
            { label: 'Window Toolbar', link: '/help/magical/toolbar/' },
            { label: 'Invitations & Badges', link: '/help/magical/invitation-tray/' },
            { label: 'Menu Bar & Popover', link: '/help/magical/menu-bar/' },
            { label: 'Meeting Alerts & Invitations', link: '/help/magical/notifications/' },
            { label: 'Desktop Widgets', link: '/help/magical/widgets/' },
            { label: 'Google Tasks', link: '/help/magical/tasks/' },
            { label: 'Deep Links & Automation', link: '/help/magical/deep-links/' },
            { label: 'Focus Filters', link: '/help/magical/focus-filters/' },
          ],
        },
        {
          label: 'General & Support',
          items: [
            { label: 'Frequently Asked Questions', link: '/help/general/faq/' },
            { label: 'Privacy & Security', link: '/help/general/privacy/' },
            { label: 'Diagnostics & Troubleshooting', link: '/help/general/troubleshooting/' },
            { label: 'Uninstalling & Data Removal', link: '/help/general/uninstall/' },
          ],
        },
      ],
    }),
    magicAppsAssets(),
  ],
});
