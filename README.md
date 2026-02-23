# juni-cli

A web-based SSH client and AI-powered terminal assistant, available as both a **web application** and a native **Electron desktop app**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser / Electron Renderer (React + xterm.js)                 │
│                                                                 │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Terminal    │  │ GeminiChat │  │ ClaudeChat │  │ Settings │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────────┘ │
│        │ socket.io      │ HTTP          │ HTTP                  │
└────────┼────────────────┼───────────────┼───────────────────────┘
         │                │               │
┌────────▼────────────────▼───────────────▼───────────────────────┐
│  Express Server (Node.js)                                       │
│                                                                 │
│  socket.io → SSH (ssh2) / local PTY (node-pty)                  │
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
│           │   └── ConnectionForm.jsx     ← SSH/local connection dialog
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
- **Local terminal** via node-pty (Proton only, for localhost connections)
- **Gemini AI chat** with agent mode (autonomous command execution via function calling)
- **Claude AI chat** via Anthropic API
- **Draggable split-screen** between terminal and AI chat (horizontal or vertical)
- **Agent controls**: pause, resume, stop, retry
- **Customizable**: font family, font size, split orientation via settings panel

## Deployment

| App | Guide |
|-----|-------|
| Web (Ubuntu + Nginx) | [apps/web/DEPLOY.md](apps/web/DEPLOY.md) |
| Proton (macOS + Linux) | [apps/proton/DEPLOY.md](apps/proton/DEPLOY.md) |

## Agent Mode

See [apps/web/AGENT.md](apps/web/AGENT.md) for full architecture documentation of the agentic terminal assistant.
