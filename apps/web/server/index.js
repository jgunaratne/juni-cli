const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createGeminiRoutes, createClaudeRoutes, setupSshHandler } = require('@juni/shared-server');

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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

// Serve built client in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✦  juni-cli server running on http://localhost:${PORT}`);
  console.log(`   GCP Project: ${DEFAULT_PROJECT || '(not set — set GCP_PROJECT_ID in .env)'}`);
  console.log(`   GCP Location: ${DEFAULT_LOCATION}`);
});
