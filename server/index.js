const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
});

app.use(cors());

// Health-check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Socket.io connection handler ───────────────────────────────
io.on('connection', (socket) => {
  console.log(`[socket] client connected  id=${socket.id}`);

  let sshClient = null;
  let sshStream = null;

  // ── ssh:connect ──────────────────────────────────────────────
  socket.on('ssh:connect', (credentials) => {
    const { host, port = 22, username, password, privateKey } = credentials;

    console.log(`[ssh] connecting to ${username}@${host}:${port}`);
    sshClient = new Client();

    sshClient.on('ready', () => {
      console.log(`[ssh] authenticated  ${username}@${host}`);
      socket.emit('ssh:status', { status: 'authenticated' });

      sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          socket.emit('ssh:error', { message: err.message });
          return;
        }

        sshStream = stream;
        socket.emit('ssh:status', { status: 'ready' });

        // SSH → Browser
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

    // Build connection config
    const connectConfig = { host, port: Number(port), username };
    if (privateKey) {
      connectConfig.privateKey = privateKey;
    } else if (password) {
      connectConfig.password = password;
    }

    sshClient.connect(connectConfig);
  });

  // ── ssh:data  (Browser → SSH) ───────────────────────────────
  socket.on('ssh:data', (data) => {
    if (sshStream) sshStream.write(data);
  });

  // ── ssh:resize ───────────────────────────────────────────────
  socket.on('ssh:resize', ({ cols, rows }) => {
    if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
  });

  // ── disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[socket] client disconnected  id=${socket.id}`);
    if (sshStream) sshStream.end();
    if (sshClient) sshClient.end();
  });
});

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
