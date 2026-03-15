const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createGeminiRoutes, createClaudeRoutes, setupSshHandler, setupShareRelay } = require('@juni/shared-server');

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:3001',
          'http://127.0.0.1:3001',
          'https://junius.servehttp.com',
          'http://junius.servehttp.com',
        ],
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    project: DEFAULT_PROJECT || '(not set)',
    location: DEFAULT_LOCATION,
  });
});

app.use('/api/gemini', createGeminiRoutes({
  defaultProject: DEFAULT_PROJECT,
  defaultLocation: DEFAULT_LOCATION,
  getApiKey: () => GEMINI_API_KEY,
}));

app.use('/api/claude', createClaudeRoutes({
  getAnthropicKey: () => process.env.ANTHROPIC_API_KEY || '',
}));

setupSshHandler(io);
setupShareRelay(server);

// Serve built client in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

/* ── VNC WebSocket-to-TCP Proxy ─────────────────── */
const net = require('net');
const { WebSocketServer } = require('ws');

const vncWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  // Only handle /vnc-proxy upgrades; let Socket.io handle its own upgrades
  if (url.pathname !== '/vnc-proxy') return;

  const targetHost = url.searchParams.get('host');
  const targetPort = Number(url.searchParams.get('port')) || 5900;

  if (!targetHost) {
    socket.destroy();
    return;
  }

  vncWss.handleUpgrade(request, socket, head, (ws) => {
    ws.binaryType = 'nodebuffer';

    console.log(`[vnc-proxy] WebSocket connected, opening TCP to ${targetHost}:${targetPort}`);

    const tcpSocket = net.createConnection({ host: targetHost, port: targetPort }, () => {
      console.log(`[vnc-proxy] TCP connected to ${targetHost}:${targetPort}`);
    });

    tcpSocket.on('data', (data) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        try {
          ws.send(data);
        } catch (err) {
          console.error(`[vnc-proxy] ws.send error: ${err.message}`);
        }
      }
    });

    tcpSocket.on('error', (err) => {
      console.error(`[vnc-proxy] TCP error: ${err.message}`);
      if (ws.readyState === 1) ws.close(1011, err.message);
    });

    tcpSocket.on('close', () => {
      console.log('[vnc-proxy] TCP connection closed');
      if (ws.readyState === 1) ws.close();
    });

    ws.on('message', (data) => {
      if (tcpSocket.writable) {
        tcpSocket.write(data);
      }
    });

    ws.on('close', () => {
      console.log('[vnc-proxy] WebSocket closed');
      tcpSocket.destroy();
    });

    ws.on('error', (err) => {
      console.error(`[vnc-proxy] WebSocket error: ${err.message}`);
      tcpSocket.destroy();
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✦  juni-cli server running on http://localhost:${PORT}`);
  console.log(`   GCP Project: ${DEFAULT_PROJECT || '(not set — set GCP_PROJECT_ID in .env)'}`);
  console.log(`   GCP Location: ${DEFAULT_LOCATION}`);
});
