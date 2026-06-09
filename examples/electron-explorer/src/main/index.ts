import { app, BrowserWindow, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAM_CHANNEL, type StreamEnvelope } from '../shared/types.js';
import { initEngine, setForwarder, shutdown } from './engine-host.js';
import { registerIpc, restoreTopology } from './ipc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'Drasi Plugin Explorer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Forward engine streams to this window.
  setForwarder((env: StreamEnvelope) => {
    if (!win.isDestroyed()) win.webContents.send(STREAM_CHANNEL, env);
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Bring the engine up before the UI can issue commands.
  await initEngine();
  registerIpc();
  // Re-create any components that were defined in a previous session.
  await restoreTopology();

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('failed to start:', err);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  e.preventDefault();
  await shutdown();
  app.exit(0);
});
