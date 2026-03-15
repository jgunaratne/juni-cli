import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import RFB from 'novnc-next';
import KeyTable from 'novnc-next/core/input/keysym';

/* ── Key name → X11 keysym mapping ───────────────────── */

const KEY_MAP = {
  ctrl: KeyTable.XK_Control_L,
  control: KeyTable.XK_Control_L,
  alt: KeyTable.XK_Alt_L,
  shift: KeyTable.XK_Shift_L,
  super: KeyTable.XK_Super_L,
  meta: KeyTable.XK_Super_L,
  enter: KeyTable.XK_Return,
  return: KeyTable.XK_Return,
  tab: KeyTable.XK_Tab,
  escape: KeyTable.XK_Escape,
  esc: KeyTable.XK_Escape,
  backspace: KeyTable.XK_BackSpace,
  delete: KeyTable.XK_Delete,
  space: KeyTable.XK_space,
  up: KeyTable.XK_Up,
  down: KeyTable.XK_Down,
  left: KeyTable.XK_Left,
  right: KeyTable.XK_Right,
  home: KeyTable.XK_Home,
  end: KeyTable.XK_End,
  pageup: KeyTable.XK_Page_Up,
  pagedown: KeyTable.XK_Page_Down,
  f1: KeyTable.XK_F1, f2: KeyTable.XK_F2, f3: KeyTable.XK_F3, f4: KeyTable.XK_F4,
  f5: KeyTable.XK_F5, f6: KeyTable.XK_F6, f7: KeyTable.XK_F7, f8: KeyTable.XK_F8,
  f9: KeyTable.XK_F9, f10: KeyTable.XK_F10, f11: KeyTable.XK_F11, f12: KeyTable.XK_F12,
};

function keyNameToKeysym(name) {
  const lower = name.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  // Single character → use its char code
  if (name.length === 1) return name.charCodeAt(0);
  return null;
}

/**
 * VncViewer — Renders a noVNC remote desktop viewer inside a tab.
 * Connects through a WebSocket-to-TCP proxy.
 *
 * Exposes captureScreenshot() and executeAction() via ref for agent mode.
 */
const VncViewer = forwardRef(function VncViewer(
  { tabId, connection, isActive, onStatusChange, onClose, serverUrl },
  ref,
) {
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

  // Use a ref for onStatusChange to avoid re-running the effect when the callback changes
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  /* ── Agent imperative handle ─────────────────────────── */

  useImperativeHandle(ref, () => ({
    /**
     * Capture the VNC canvas as a base64 JPEG, resized to maxWidth.
     * Returns { base64, width, height } or null if not connected.
     */
    captureScreenshot: (maxWidth = 1024) => {
      const rfb = rfbRef.current;
      if (!rfb) return null;

      // noVNC renders into a canvas inside the container
      const canvas = containerRef.current?.querySelector('canvas');
      if (!canvas) return null;

      const origW = canvas.width;
      const origH = canvas.height;

      // Resize if needed
      const scale = origW > maxWidth ? maxWidth / origW : 1;
      const newW = Math.round(origW * scale);
      const newH = Math.round(origH * scale);

      const offscreen = document.createElement('canvas');
      offscreen.width = newW;
      offscreen.height = newH;
      const ctx = offscreen.getContext('2d');
      ctx.drawImage(canvas, 0, 0, newW, newH);

      // Export as JPEG (much smaller than PNG for screenshots)
      const dataUrl = offscreen.toDataURL('image/jpeg', 0.7);
      const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

      return { base64, width: newW, height: newH, origWidth: origW, origHeight: origH };
    },

    /**
     * Execute a desktop action on the remote VNC session.
     * Maps normalized coordinates to actual screen coordinates.
     */
    executeAction: async (action) => {
      const rfb = rfbRef.current;
      if (!rfb) return { success: false, error: 'Not connected' };

      const canvas = containerRef.current?.querySelector('canvas');
      if (!canvas) return { success: false, error: 'No canvas' };

      const screenW = canvas.width;
      const screenH = canvas.height;

      try {
        const name = action.name;
        const args = action.args || {};

        if (name === 'click') {
          const x = Math.round((args.normalizedX || 0.5) * screenW);
          const y = Math.round((args.normalizedY || 0.5) * screenH);
          const button = args.button || 'left';
          const count = args.clickCount || 1;
          const buttonMask = button === 'right' ? 4 : button === 'middle' ? 2 : 1;

          for (let i = 0; i < count; i++) {
            rfb.sendPointerEvent(x, y, buttonMask);  // press
            await new Promise((r) => setTimeout(r, 50));
            rfb.sendPointerEvent(x, y, 0);             // release
            if (i < count - 1) await new Promise((r) => setTimeout(r, 100));
          }
          return { success: true };
        }

        if (name === 'type_text') {
          const text = args.text || '';
          for (const char of text) {
            const code = char.charCodeAt(0);
            rfb.sendKey(code, null, true);   // press
            rfb.sendKey(code, null, false);  // release
            await new Promise((r) => setTimeout(r, 20));
          }
          return { success: true };
        }

        if (name === 'key_combo') {
          const keys = args.keys || [];
          const keysyms = keys.map(keyNameToKeysym).filter(Boolean);

          // Press all keys in order
          for (const ks of keysyms) {
            rfb.sendKey(ks, null, true);
          }
          await new Promise((r) => setTimeout(r, 50));
          // Release in reverse order
          for (const ks of keysyms.reverse()) {
            rfb.sendKey(ks, null, false);
          }
          return { success: true };
        }

        if (name === 'scroll') {
          const x = Math.round((args.normalizedX || 0.5) * screenW);
          const y = Math.round((args.normalizedY || 0.5) * screenH);
          const dy = args.dy || 0;
          const scrollCount = Math.abs(Math.round(dy));
          // Button 4 = scroll up, Button 5 = scroll down (RFB protocol)
          const buttonMask = dy > 0 ? 8 : 16;  // bit 3 = button 4, bit 4 = button 5

          for (let i = 0; i < scrollCount; i++) {
            rfb.sendPointerEvent(x, y, buttonMask);
            await new Promise((r) => setTimeout(r, 30));
            rfb.sendPointerEvent(x, y, 0);
            await new Promise((r) => setTimeout(r, 30));
          }
          return { success: true };
        }

        if (name === 'mouse_move') {
          const x = Math.round((args.normalizedX || 0.5) * screenW);
          const y = Math.round((args.normalizedY || 0.5) * screenH);
          rfb.sendPointerEvent(x, y, 0);
          return { success: true };
        }

        if (name === 'wait') {
          const seconds = Math.min(args.seconds || 1, 10);
          await new Promise((r) => setTimeout(r, seconds * 1000));
          return { success: true };
        }

        if (name === 'take_screenshot') {
          // No-op, the caller will take a screenshot after
          return { success: true };
        }

        return { success: false, error: `Unknown action: ${name}` };
      } catch (err) {
        console.error('[vnc-agent] action error:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * Get the current screen dimensions.
     */
    getScreenSize: () => {
      const canvas = containerRef.current?.querySelector('canvas');
      if (!canvas) return null;
      return { width: canvas.width, height: canvas.height };
    },
  }));

  /* ── RFB connection effect ─────────────────────────── */

  useEffect(() => {
    if (!serverUrl || !connection) return;

    let rfb = null;
    let disposed = false;

    const { host, port, password, username } = connection;

    // Build the proxy WebSocket URL — derive protocol from page to prevent mixed content
    let wsUrl;
    if (serverUrl && /^https?:\/\//.test(serverUrl)) {
      const serverBase = serverUrl.replace(/^http/, 'ws');
      wsUrl = `${serverBase}/vnc-proxy?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
    } else {
      const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      wsUrl = `${wsProto}://${window.location.host}/vnc-proxy?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;
    }

    onStatusChangeRef.current('connecting');

    try {
      const creds = { password: password || '' };
      if (username) creds.username = username;

      rfb = new RFB(containerRef.current, wsUrl, {
        credentials: creds,
      });

      rfbRef.current = rfb;

      // Performance & display settings
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.background = '#0d1117';
      rfb.qualityLevel = 6;       // 0-9: lower = faster, more artifacts
      rfb.compressionLevel = 2;   // 0-9: higher = more CPU, less bandwidth
      rfb.showDotCursor = true;   // show dot when remote cursor is hidden

      rfb.addEventListener('connect', () => {
        if (!disposed) onStatusChangeRef.current('ready');
      });

      rfb.addEventListener('disconnect', (e) => {
        if (!disposed) {
          console.log('[vnc] disconnected', e.detail);
          onStatusChangeRef.current('disconnected');
        }
      });

      rfb.addEventListener('securityfailure', (e) => {
        if (!disposed) {
          console.error('[vnc] security failure:', e.detail);
          onStatusChangeRef.current('error');
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
      if (!disposed) onStatusChangeRef.current('error');
    }

    return () => {
      disposed = true;
      if (rfb) {
        try { rfb.disconnect(); } catch { /* ignore */ }
      }
      rfbRef.current = null;
    };
  }, [serverUrl, connection, reconnectCount]);

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
});

export default VncViewer;
