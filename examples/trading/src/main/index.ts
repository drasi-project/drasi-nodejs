import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAM_CHANNEL, type StreamEnvelope } from '../shared/types.js';
import { getResults, initEngine, setForwarder, shutdown } from './engine-host.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    show: false,
    title: 'Drasi Trading Demo',
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  setForwarder((env: StreamEnvelope) => {
    if (!win.isDestroyed()) win.webContents.send(STREAM_CHANNEL, env);
  });

  win.on('ready-to-show', () => win.show());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('trading:getResults', (_e, queryId: string) => getResults(queryId));
}

app
  .whenReady()
  .then(async () => {
    registerIpc();
    await createWindow();
    // Bring the engine up after the window exists so startup errors can surface.
    try {
      await initEngine();
    } catch (err) {
      console.error('failed to initialize engine:', err);
      mainWindow?.webContents.send('trading:error', String(err));
    }
  })
  .catch((err) => {
    console.error('failed to start:', err);
    app.quit();
  });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  e.preventDefault();
  void shutdown().finally(() => app.exit(0));
});
