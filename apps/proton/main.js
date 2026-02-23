const { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('ssh2');
const os = require('os');
const { createGeminiRoutes, createClaudeRoutes } = require('@juni/shared-server');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[proton] node-pty not available:', err.message);
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/* ── Environment ──────────────────────────────────────────── */

function getIsDev() {
  try {
    return !app.isPackaged;
  } catch {
    return true;
  }
}

const dotenv = require('dotenv');
// Load local .env first (project defaults), then ~/.juni-cli.env (user overrides).
// dotenv won't overwrite vars already set, so ~/.juni-cli.env takes precedence
// if loaded first. We load it second so the local .env acts as a fallback.
dotenv.config({ path: path.join(os.homedir(), '.juni-cli.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

/* ── Config ───────────────────────────────────────────────── */

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';

/* ── Auth method detection ────────────────────────────────── */

const fs = require('fs');

const GCLOUD_ADC_PATH = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(`[auth] Using service account key: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else if (fs.existsSync(GCLOUD_ADC_PATH)) {
  // Electron may not find the well-known ADC path automatically.
  // Explicitly set GOOGLE_APPLICATION_CREDENTIALS so the Vertex AI SDK picks it up.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = GCLOUD_ADC_PATH;
  console.log(`[auth] Using gcloud ADC credentials: ${GCLOUD_ADC_PATH}`);
} else {
  console.log('[auth] No credentials found. Run `gcloud auth application-default login` for local dev.');
}

const AUTH_METHOD = process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'ADC' : 'none';

/* ── Embedded Express Server ──────────────────────────────── */

let serverPort = 3001;
let expressServer = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const expressApp = express();
    const server = http.createServer(expressApp);

    const io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    expressApp.use(cors());
    expressApp.use(express.json({ limit: '2mb' }));

    /* ── Health Check ──────────────────────────────────── */

    expressApp.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        project: DEFAULT_PROJECT || '(not set)',
        location: DEFAULT_LOCATION,
        auth: AUTH_METHOD,
        mode: 'proton',
      });
    });

    /* ── Shared API Routes ─────────────────────────────── */

    expressApp.use('/api/gemini', createGeminiRoutes({
      defaultProject: DEFAULT_PROJECT,
      defaultLocation: DEFAULT_LOCATION,
    }));

    expressApp.use('/api/claude', createClaudeRoutes({
      getAnthropicKey: () => process.env.ANTHROPIC_API_KEY || '',
    }));

    /* ── Socket.io (SSH + Local PTY) ───────────────────── */

    io.on('connection', (socket) => {
      console.log(`[socket] client connected  id=${socket.id}`);

      let sshClient = null;
      let sshStream = null;
      let ptyProcess = null;
      let pendingSize = { rows: 24, cols: 80 };

      const writeToBackend = (data) => {
        if (ptyProcess) ptyProcess.write(data);
        else if (sshStream) sshStream.write(data);
      };

      const resizeBackend = (cols, rows) => {
        pendingSize = { rows, cols };
        if (ptyProcess) ptyProcess.resize(cols, rows);
        else if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
      };

      const cleanupBackend = () => {
        if (ptyProcess) {
          ptyProcess.kill();
          ptyProcess = null;
        }
        if (sshStream) sshStream.end();
        if (sshClient) sshClient.end();
        sshStream = null;
        sshClient = null;
      };

      socket.on('ssh:connect', (credentials) => {
        const { host, port = 22, username, password, privateKey, local } = credentials;
        const isLocal = local || LOCAL_HOSTS.includes(host);

        /* ── Local terminal (no login required) ────────── */
        if (isLocal) {
          if (!pty) {
            socket.emit('ssh:error', { message: 'node-pty is not available. Cannot open local terminal.' });
            return;
          }

          console.log('[local] spawning local shell');
          socket.emit('ssh:status', { status: 'authenticated' });

          const shellPath = process.env.SHELL || '/bin/zsh';
          const homeDir = os.homedir();

          ptyProcess = pty.spawn(shellPath, ['-l'], {
            name: 'xterm-256color',
            cols: pendingSize.cols,
            rows: pendingSize.rows,
            cwd: homeDir,
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              HOME: homeDir,
              LANG: process.env.LANG || 'en_US.UTF-8',
            },
          });

          socket.emit('ssh:status', { status: 'ready' });

          ptyProcess.onData((data) => {
            socket.emit('ssh:output', data);
          });

          ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`[local] shell exited  code=${exitCode} signal=${signal}`);
            socket.emit('ssh:status', { status: 'disconnected' });
            ptyProcess = null;
          });

          return;
        }

        /* ── Remote SSH connection ──────────────────────── */
        console.log(`[ssh] connecting to ${username}@${host}:${port}`);
        sshClient = new Client();

        sshClient.on('ready', () => {
          console.log(`[ssh] authenticated  ${username}@${host}`);
          socket.emit('ssh:status', { status: 'authenticated' });

          sshClient.shell(
            { term: 'xterm-256color', rows: pendingSize.rows, cols: pendingSize.cols },
            (err, stream) => {
              if (err) {
                socket.emit('ssh:error', { message: err.message });
                return;
              }

              sshStream = stream;
              socket.emit('ssh:status', { status: 'ready' });

              stream.on('data', (data) => {
                socket.emit('ssh:output', data.toString('utf-8'));
              });

              stream.stderr.on('data', (data) => {
                socket.emit('ssh:output', data.toString('utf-8'));
              });

              stream.on('close', () => {
                console.log(`[ssh] shell closed  ${username}@${host}`);
                socket.emit('ssh:status', { status: 'disconnected' });
                if (sshClient) sshClient.end();
              });
            });
        });

        sshClient.on('error', (err) => {
          console.error(`[ssh] error: ${err.message}`);
          socket.emit('ssh:error', { message: err.message });
        });

        sshClient.on('close', () => {
          console.log('[ssh] connection closed');
          socket.emit('ssh:status', { status: 'disconnected' });
          sshClient = null;
          sshStream = null;
        });

        const connectConfig = {
          host,
          port: Number(port),
          username,
          tryKeyboard: true,
          readyTimeout: 10000,
        };
        if (privateKey) {
          connectConfig.privateKey = privateKey;
        } else if (password) {
          connectConfig.password = password;
        }

        sshClient.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
          finish([password || '']);
        });

        sshClient.connect(connectConfig);
      });

      socket.on('ssh:data', (data) => {
        writeToBackend(data);
      });

      socket.on('ssh:resize', ({ cols, rows }) => {
        resizeBackend(cols, rows);
      });

      socket.on('disconnect', () => {
        console.log(`[socket] client disconnected  id=${socket.id}`);
        cleanupBackend();
      });
    });

    /* ── Start server ──────────────────────────────────── */

    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      expressServer = server;
      console.log(`✦  juni-cli-proton server on http://127.0.0.1:${serverPort}`);
      resolve(serverPort);
    });

    server.on('error', reject);
  });
}

/* ── Electron Window ───────────────────────────────────────── */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (getIsDev()) {
    mainWindow.loadURL(`http://localhost:5173`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ── macOS Menu ────────────────────────────────────────────── */

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── IPC Handlers ──────────────────────────────────────────── */

function setupIPC() {
  ipcMain.handle('get-server-port', () => serverPort);
  ipcMain.handle('get-platform', () => process.platform);
  ipcMain.handle('get-app-version', () => app.getVersion());
}

/* ── App Lifecycle ─────────────────────────────────────────── */

app.whenReady().then(async () => {
  setupIPC();
  buildMenu();

  try {
    const port = await startServer();
    console.log(`[proton] Server started on port ${port}`);
  } catch (err) {
    console.error('[proton] Failed to start server:', err);
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (expressServer) {
    expressServer.close();
  }
  app.quit();
});
