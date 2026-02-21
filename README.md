# juni-cli

A web-based SSH client with a React frontend and Express backend.

## Architecture

```
Browser  ←──  socket.io (WebSocket)  ──→  Express Server  ──→  SSH Host
(React + xterm.js)                        (Node.js + ssh2)
```

## Quick Start

```bash
# Install all dependencies
npm run install:all

# Start both server (port 3001) and client (port 5173)
npm run dev
```

Then open **http://localhost:5173** in your browser.

## Running Individually

```bash
# Backend only
cd server && npm run dev    # port 3001

# Frontend only
cd client && npm run dev    # port 5173
```

## Project Structure

```
juni-cli/
├── server/           # Express + socket.io + ssh2
│   ├── index.js
│   └── package.json
├── client/           # Vite + React + xterm.js
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── index.css
│   │   └── components/
│   │       ├── ConnectionForm.jsx
│   │       └── Terminal.jsx
│   └── package.json
└── package.json      # Root scripts
```
