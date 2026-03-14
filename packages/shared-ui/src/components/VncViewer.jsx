import { useEffect, useRef, useState, useCallback } from 'react';
import RFB from 'novnc-next';

/**
 * VncViewer — Renders a noVNC remote desktop viewer inside a tab.
 * Connects through a WebSocket-to-TCP proxy hosted by the Electron main process.
 */
export default function VncViewer({ tabId, connection, isActive, onStatusChange, onClose, serverUrl }) {
  const containerRef = useRef(null);
  const rfbRef = useRef(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const handleReconnect = useCallback(() => {
    if (rfbRef.current) {
      try { rfbRef.current.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    }
    onStatusChange('connecting');
    setReconnectCount((c) => c + 1);
  }, [onStatusChange]);

  useEffect(() => {
    if (!serverUrl || !connection) return;

    let rfb = null;
    let disposed = false;

    const { host, port, password, username } = connection;

    // Build the proxy WebSocket URL
    const serverBase = serverUrl.replace(/^http/, 'ws');
    const wsUrl = `${serverBase}/vnc-proxy?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;

    onStatusChange('connecting');

    try {
      const creds = { password: password || '' };
      if (username) creds.username = username;

      rfb = new RFB(containerRef.current, wsUrl, {
        credentials: creds,
      });

      rfbRef.current = rfb;

      // Styling
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.background = '#0d1117';

      rfb.addEventListener('connect', () => {
        if (!disposed) onStatusChange('ready');
      });

      rfb.addEventListener('disconnect', (e) => {
        if (!disposed) {
          console.log('[vnc] disconnected', e.detail);
          onStatusChange('disconnected');
        }
      });

      rfb.addEventListener('securityfailure', (e) => {
        if (!disposed) {
          console.error('[vnc] security failure:', e.detail);
          onStatusChange('error');
        }
      });

      rfb.addEventListener('credentialsrequired', () => {
        const creds = {};
        if (username) creds.username = username;
        if (password) creds.password = password;
        if (Object.keys(creds).length) {
          rfb.sendCredentials(creds);
        }
      });
    } catch (err) {
      console.error('[vnc] init error:', err);
      if (!disposed) onStatusChange('error');
    }

    return () => {
      disposed = true;
      if (rfb) {
        try { rfb.disconnect(); } catch { /* ignore */ }
      }
      rfbRef.current = null;
    };
  }, [serverUrl, connection, reconnectCount, onStatusChange]);

  // Focus the VNC canvas when the tab becomes active
  useEffect(() => {
    if (isActive && rfbRef.current) {
      try { rfbRef.current.focus(); } catch { /* ignore */ }
    }
  }, [isActive]);

  return (
    <div
      className="terminal-container vnc-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="vnc-indicator" title="VNC" />
          <span className="terminal-title">
            VNC {connection.host}:{connection.port}
          </span>
        </div>
        <div className="toolbar-right">
          <button
            className="reconnect-btn"
            onClick={handleReconnect}
            title="Reconnect VNC session"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
          </button>
          <button className="disconnect-btn" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div
        className="vnc-viewport"
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#0d1117' }}
      />
    </div>
  );
}
