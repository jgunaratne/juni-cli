require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('ssh2');
const { VertexAI } = require('@google-cloud/vertexai');

/* ── Config ────────────────────────────────────────────────── */

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';

/* ── Vertex AI Client Cache ────────────────────────────────── */

const clientCache = new Map();

function getVertexClient(project, location) {
  const key = `${project}::${location}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new VertexAI({ project, location }));
  }
  return clientCache.get(key);
}

/* ── Express + Socket.io ───────────────────────────────────── */

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
app.use(express.json({ limit: '2mb' }));

/* ── Health Check ──────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    project: DEFAULT_PROJECT || '(not set)',
    location: DEFAULT_LOCATION,
  });
});

/* ── Gemini Chat Endpoint ──────────────────────────────────── */

app.post('/api/gemini/chat', async (req, res) => {
  try {
    const {
      model = 'gemini-3-flash-preview',
      messages = [],
      project,
      location,
    } = req.body;

    const resolvedProject = project || DEFAULT_PROJECT;
    const resolvedLocation = location || DEFAULT_LOCATION;

    if (!resolvedProject) {
      return res.status(400).json({
        error: 'GCP project ID is required. Set GCP_PROJECT_ID in server/.env.',
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const contents = messages.map((m) => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
    const generativeModel = vertexAI.getGenerativeModel({
      model,
      systemInstruction: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    });

    const result = await generativeModel.generateContent({ contents });
    const response = result.response;
    const text =
      response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      'No response generated.';

    res.json({ reply: text });
  } catch (err) {
    console.error('[gemini] Chat error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/* ── Socket.io connection handler ──────────────────────────── */

io.on('connection', (socket) => {
  console.log(`[socket] client connected  id=${socket.id}`);

  let sshClient = null;
  let sshStream = null;
  let pendingSize = { rows: 24, cols: 80 };

  // ── ssh:connect ──────────────────────────────────────────────
  socket.on('ssh:connect', (credentials) => {
    const { host, port = 22, username, password, privateKey } = credentials;

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

    // Handle keyboard-interactive auth (used by many SSH servers)
    sshClient.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
      finish([password || '']);
    });

    sshClient.connect(connectConfig);
  });

  // ── ssh:data  (Browser → SSH) ───────────────────────────────
  socket.on('ssh:data', (data) => {
    if (sshStream) sshStream.write(data);
  });

  // ── ssh:resize ───────────────────────────────────────────────
  socket.on('ssh:resize', ({ cols, rows }) => {
    pendingSize = { rows, cols };
    if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
  });

  // ── disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[socket] client disconnected  id=${socket.id}`);
    if (sshStream) sshStream.end();
    if (sshClient) sshClient.end();
  });
});

/* ── Start ──────────────────────────────────────────────────── */

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✦  juni-cli server running on http://localhost:${PORT}`);
  console.log(`   GCP Project: ${DEFAULT_PROJECT || '(not set — set GCP_PROJECT_ID in .env)'}`);
  console.log(`   GCP Location: ${DEFAULT_LOCATION}`);
});
