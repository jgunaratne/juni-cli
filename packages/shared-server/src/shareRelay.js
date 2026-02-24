const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const url = require('url');

const MAX_SESSIONS = 10;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Attach a WebSocket relay server to the given HTTP server
 * for terminal sharing sessions.
 *
 * Host flow:   ws://server/share?role=host
 * Viewer flow: ws://server/share?role=viewer&code=XXXXXXXX
 */
function setupShareRelay(server) {
  const sessions = new Map(); // shareCode → { host, viewers, createdAt, expireTimer }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    if (pathname !== '/share') return; // let other upgrade handlers (Socket.IO) handle it

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const params = new URLSearchParams(url.parse(req.url).query);
    const role = params.get('role');

    if (role === 'host') {
      handleHost(ws, sessions);
    } else if (role === 'viewer') {
      const code = params.get('code');
      handleViewer(ws, code, sessions);
    } else {
      ws.close(4000, 'Invalid role. Use ?role=host or ?role=viewer&code=XXXX');
    }
  });

  console.log('[share-relay] WebSocket relay ready on /share');
}

function generateShareCode() {
  return crypto.randomBytes(12).toString('base64url'); // 16 URL-safe chars, 96 bits entropy
}

function handleHost(ws, sessions) {
  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({ type: 'error', data: 'Maximum active sessions reached' }));
    ws.close(4001, 'Max sessions');
    return;
  }

  const code = generateShareCode();
  const session = {
    host: ws,
    viewers: new Set(),
    createdAt: Date.now(),
    expireTimer: setTimeout(() => {
      console.log(`[share-relay] session ${code} expired`);
      ws.send(JSON.stringify({ type: 'expired', data: 'Session expired after 30 minutes' }));
      cleanupSession(code, sessions);
    }, SESSION_TTL_MS),
  };

  sessions.set(code, session);
  console.log(`[share-relay] host connected, code=${code} (active=${sessions.size})`);

  ws.send(JSON.stringify({ type: 'share-code', data: code }));

  ws.on('message', (raw) => {
    // Host sends terminal output → broadcast to all viewers
    const msg = raw.toString();
    for (const viewer of session.viewers) {
      if (viewer.readyState === viewer.OPEN) {
        viewer.send(msg);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[share-relay] host disconnected, code=${code}`);
    cleanupSession(code, sessions);
  });

  ws.on('error', (err) => {
    console.error(`[share-relay] host error: ${err.message}`);
    cleanupSession(code, sessions);
  });
}

function handleViewer(ws, code, sessions) {
  if (!code) {
    ws.send(JSON.stringify({ type: 'error', data: 'Missing share code' }));
    ws.close(4002, 'Missing code');
    return;
  }

  const session = sessions.get(code);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', data: 'Invalid or expired share code' }));
    ws.close(4003, 'Invalid code');
    return;
  }

  session.viewers.add(ws);
  console.log(`[share-relay] viewer joined, code=${code} (viewers=${session.viewers.size})`);

  // Notify host that a viewer connected
  if (session.host.readyState === session.host.OPEN) {
    session.host.send(JSON.stringify({
      type: 'viewer-joined',
      data: { count: session.viewers.size },
    }));
  }

  // Notify viewer of successful connection
  ws.send(JSON.stringify({ type: 'connected', data: { code } }));

  ws.on('message', (raw) => {
    // Viewer sends input → forward to host
    if (session.host.readyState === session.host.OPEN) {
      session.host.send(raw.toString());
    }
  });

  ws.on('close', () => {
    session.viewers.delete(ws);
    console.log(`[share-relay] viewer left, code=${code} (viewers=${session.viewers.size})`);
    if (session.host.readyState === session.host.OPEN) {
      session.host.send(JSON.stringify({
        type: 'viewer-left',
        data: { count: session.viewers.size },
      }));
    }
  });

  ws.on('error', (err) => {
    console.error(`[share-relay] viewer error: ${err.message}`);
    session.viewers.delete(ws);
  });
}

function cleanupSession(code, sessions) {
  const session = sessions.get(code);
  if (!session) return;

  clearTimeout(session.expireTimer);

  // Disconnect all viewers
  for (const viewer of session.viewers) {
    if (viewer.readyState === viewer.OPEN) {
      viewer.send(JSON.stringify({ type: 'host-disconnected', data: 'Host stopped sharing' }));
      viewer.close(1000, 'Host disconnected');
    }
  }

  // Close host if still open
  if (session.host.readyState === session.host.OPEN) {
    session.host.close(1000, 'Session ended');
  }

  sessions.delete(code);
  console.log(`[share-relay] session cleaned up, code=${code} (active=${sessions.size})`);
}

module.exports = { setupShareRelay };
