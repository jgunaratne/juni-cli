# juni-cli

A web-based SSH client and AI-powered terminal assistant, available as both a **web application** and a native **Electron desktop app**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser / Electron Renderer (React + xterm.js + noVNC)         │
│                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Terminal    │  │ VncViewer  │  │ GeminiChat │  │ Settings │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────────┘ │
│        │ socket.io      │ WebSocket     │ HTTP                  │
└────────┼────────────────┼───────────────┼───────────────────────┘
         │                │               │
┌────────▼────────────────▼───────────────▼───────────────────────┐
│  Express Server (Node.js)                                       │
│                                                                 │
│  socket.io → SSH (ssh2) / local PTY (node-pty)                  │
│  /vnc-proxy → WebSocket-to-TCP proxy (VNC)                      │
│  /api/gemini → Vertex AI / Google AI                            │
│  /api/claude → Anthropic API                                    │
└─────────────────────────────────────────────────────────────────┘
```

## Monorepo Structure

```
juni-cli/
├── package.json                          ← npm workspaces root
├── packages/
│   ├── shared-server/                    ← @juni/shared-server
│   │   └── src/
│   │       ├── geminiRoutes.js           ← Gemini chat + agent endpoints
│   │       ├── claudeRoutes.js           ← Claude chat endpoint
│   │       ├── sshHandler.js             ← SSH socket.io handler
│   │       ├── agentTools.js             ← Agent tool declarations + system prompt
│   │       └── vertexClient.js           ← Vertex AI / Google AI client setup
│   └── shared-ui/                        ← @juni/shared-ui
│       └── src/
│           ├── components/
│           │   ├── GeminiChat.jsx         ← Gemini chat + agent loop
│           │   ├── ClaudeChat.jsx         ← Claude chat
│           │   ├── Terminal.jsx           ← xterm.js terminal
│           │   ├── ConnectionForm.jsx     ← SSH/VNC connection dialog
│           │   └── VncViewer.jsx          ← noVNC remote desktop viewer
│           └── utils/
│               └── smartTruncate.js       ← Output truncation utility
├── apps/
│   ├── web/                              ← Web application (deployed to server)
│   │   ├── server/index.js               ← Express backend
│   │   └── client/src/App.jsx            ← React frontend
│   └── proton/                           ← Electron desktop app
│       ├── main.js                       ← Electron main process + embedded server
│       ├── preload.js                    ← IPC bridge
│       └── renderer/src/App.jsx          ← React frontend (Electron)
```

## Quick Start

### Web App

```bash
cd juni-cli

# Install all workspace dependencies
npm install

# Start both server (port 3001) and client (port 5173)
cd apps/web
npm run dev
```

Open **http://localhost:5173** in your browser.

### Electron Desktop App (Proton)

```bash
cd juni-cli
npm install

cd apps/proton
npm run dev
```

## Features

- **Multi-tab SSH terminals** with xterm.js
- **VNC remote desktop** via noVNC (WebSocket-to-TCP proxy)
- **Local terminal** via node-pty (Proton only, for localhost connections)
- **Terminal sharing** via WebSocket relay (host/viewer model)
- **Gemini AI chat** with agent mode (autonomous command execution via function calling)
- **Claude AI chat** via Anthropic API
- **Draggable split-screen** between terminal and AI chat (horizontal or vertical)
- **Agent controls**: pause, resume, stop, retry
- **Customizable**: font family, font size, background color, split orientation

## Production Build

> **Prerequisites:** Node.js 20+

### Web App

```bash
cd juni-cli
npm install

# Build the client bundle
cd apps/web/client
npm run build

# Start the production server
cd ../
NODE_ENV=production node server/index.js
```

The server runs on port `3001` by default. See [apps/web/DEPLOY.md](apps/web/DEPLOY.md) for Nginx + systemd setup.

### Proton Desktop App (macOS)

```bash
cd juni-cli
npm install

# Build distributable .dmg + .zip
cd apps/proton
npm run build
```

Output → `apps/proton/release/`:
- `juni-cli-proton-1.0.0.dmg` — installer
- `juni-cli-proton-1.0.0-mac.zip` — portable zip

For a quick test build (no installers):

```bash
npm run pack
# → release/mac-arm64/juni-cli-proton.app
```

### Proton Desktop App (Linux)

```bash
# Install build dependencies
sudo apt-get install -y build-essential python3 make \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
  xdg-utils libatspi2.0-0 libdrm2 libgbm1 libasound2

cd juni-cli
npm install

# Build .AppImage + .deb
cd apps/proton
npm run build:linux
```

Output → `apps/proton/release/`:
- `juni-cli-proton-1.0.0.AppImage` — portable
- `juni-cli-proton_1.0.0_amd64.deb` — Debian/Ubuntu package

### Environment

Create `.env` in the app directory (`apps/proton/.env` or `apps/web/.env`):

```env
GCP_PROJECT_ID=your-gcp-project-id
GCP_LOCATION=us-central1
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
```

For Vertex AI, run `gcloud auth application-default login` or set `GOOGLE_APPLICATION_CREDENTIALS`.

## Deployment

| App | Guide |
|-----|-------|
| Web (Ubuntu + Nginx) | [apps/web/DEPLOY.md](apps/web/DEPLOY.md) |
| Proton (macOS + Linux) | [apps/proton/DEPLOY.md](apps/proton/DEPLOY.md) |

## Agent Mode

See [apps/web/AGENT.md](apps/web/AGENT.md) for full architecture documentation of the agentic terminal assistant.
