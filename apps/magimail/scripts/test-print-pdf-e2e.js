/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const preloadPath = path.resolve(__dirname, '../dist/preload.js');

app.whenReady().then(async () => {
  console.log('[E2E-PDF] Electron ready. Testing authentic Gmail print view and PDF export...');

  let server;
  try {
    const mockGmailPrintHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>E2E Authentic Gmail Print View</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; }
            .header { border-bottom: 2px solid #e0e0e0; padding-bottom: 12px; margin-bottom: 16px; }
            h1 { font-size: 20px; color: #202124; margin: 0 0 8px 0; }
            .meta { font-size: 13px; color: #5f6368; }
            .body { font-size: 14px; line-height: 1.6; color: #202124; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Test Subject: Quarterly Workspace Review</h1>
            <div class="meta"><strong>From:</strong> colleague@example.com &lt;colleague@example.com&gt;</div>
            <div class="meta"><strong>Date:</strong> Sun, Sep 6, 2026 at 10:00 AM</div>
            <div class="meta"><strong>To:</strong> user@example.com</div>
          </div>
          <div class="body">
            <p>Hello,</p>
            <p>Here are the project milestones achieved for this cycle. All deliverables have been met on schedule.</p>
            <p>Best regards,<br/>The Team</p>
          </div>
          <script>
            // Gmail embeds inline window.print() on view=pt pages
            // If preload suppression works, this call is a no-op and does NOT block the process!
            window.print();
            window.__printAttempted = true;
          </script>
        </body>
      </html>
    `;

    // Spin up local HTTP server
    server = http.createServer((req, res) => {
      console.log('[E2E-PDF] HTTP server received request:', req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mockGmailPrintHtml);
    });

    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        console.log('[E2E-PDF] HTTP server listening on port:', addr.port);
        resolve(addr.port);
      });
    });

    const printWin = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    printWin.webContents.on('did-start-loading', () =>
      console.log('[E2E-PDF] WebContents did-start-loading'),
    );
    printWin.webContents.on('did-finish-load', () =>
      console.log('[E2E-PDF] WebContents did-finish-load'),
    );
    printWin.webContents.on('console-message', (_event, level, message) =>
      console.log('[E2E-PDF Renderer Console]', message),
    );

    console.log('[E2E-PDF] Loading URL...');
    await printWin.loadURL(
      `http://127.0.0.1:${port}/mail/u/0/?view=pt&search=all&th=1800000000000001`,
    );
    console.log('[E2E-PDF] Loaded URL successfully!');

    // Settle via load/idle signal
    await printWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const onIdle = () => {
          if (window.requestIdleCallback) {
            window.requestIdleCallback(() => resolve(true), { timeout: 1000 });
          } else {
            setTimeout(() => resolve(true), 100);
          }
        };
        if (document.readyState === 'complete') {
          onIdle();
        } else {
          window.addEventListener('load', () => onIdle(), { once: true });
          setTimeout(() => resolve(true), 1500);
        }
      });
    `);

    // Verify window.print was called without hanging or throwing
    const printAttempted = await printWin.webContents.executeJavaScript('window.__printAttempted');
    if (!printAttempted) {
      throw new Error('window.print script failed to execute');
    }
    console.log('[E2E-PDF] Verified window.print() suppression on view=pt (no-op, non-blocking).');

    // Generate authentic PDF buffer
    console.log('[E2E-PDF] Generating PDF buffer via webContents.printToPDF...');
    const pdfBuffer = await printWin.webContents.printToPDF({
      printBackground: true,
      margins: {
        marginType: 'default',
      },
    });

    if (!pdfBuffer || pdfBuffer.length < 1000) {
      throw new Error(`PDF buffer too small or empty: ${pdfBuffer ? pdfBuffer.length : 0} bytes`);
    }

    const header = pdfBuffer.subarray(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      throw new Error(`Invalid PDF header: expected %PDF, got ${header}`);
    }
    console.log(`[E2E-PDF] Generated valid PDF: ${pdfBuffer.length} bytes, Header: ${header}`);

    // Write to a temporary file on disk to verify write capability
    const testPdfPath = path.join(__dirname, 'test-output.pdf');
    await fs.promises.writeFile(testPdfPath, pdfBuffer);
    const stats = await fs.promises.stat(testPdfPath);
    console.log(`[E2E-PDF] Successfully wrote PDF to disk: ${testPdfPath} (${stats.size} bytes)`);

    // Clean up
    await fs.promises.unlink(testPdfPath);

    // Now test error page / deleted conversation stub validation
    const mockDeletedHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Conversation deleted</title></head>
        <body>
          <p>The conversation has been deleted — The conversation requested has been deleted and is no longer available.</p>
        </body>
      </html>
    `;
    const deletedServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(mockDeletedHtml);
    });
    const deletedPort = await new Promise((resolve) => {
      deletedServer.listen(0, '127.0.0.1', () => resolve(deletedServer.address().port));
    });

    await printWin.loadURL(`http://127.0.0.1:${deletedPort}/deleted-stub`);
    const isDeletedPage = await printWin.webContents.executeJavaScript(`
      (() => {
        const title = document.title || '';
        if (/conversation deleted|conversation has been deleted/i.test(title)) return true;
        const text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        if (/the conversation (?:requested )?has been deleted/i.test(text)) return true;
        return false;
      })()
    `);

    if (!isDeletedPage) {
      throw new Error('Failed to detect "Conversation deleted" stub page');
    }
    console.log('[E2E-PDF] Verified detection of deleted conversation stub.');

    deletedServer.close();
    printWin.destroy();
    server.close();
    console.log(
      '[E2E-PDF] Cleaned up temporary test artifacts. All assertions passed successfully!',
    );

    app.exit(0);
  } catch (err) {
    server?.close();
    console.error('[E2E-PDF] Test failed:', err);
    app.exit(1);
  }
});
