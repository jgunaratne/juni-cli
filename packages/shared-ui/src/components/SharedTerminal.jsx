import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import '@xterm/xterm/css/xterm.css';

/**
 * SharedTerminal — A view-only/interactive terminal that connects
 * to a shared terminal session via a WebSocket relay server.
 * It receives output from the host and sends input back.
 */
const SharedTerminal = forwardRef(function SharedTerminal({ tabId, shareWs, shareCode, isActive, status, onStatusChange, onReconnect, onClose, fontFamily, fontSize, bgColor }, ref) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    _writeFromRelay: (data) => {
      if (xtermRef.current) xtermRef.current.write(data);
    },
  }));

  useEffect(() => {
    if (isActive && fitRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current.fit();
          if (xtermRef.current) xtermRef.current.focus();
        } catch { /* not ready */ }
      });
    }
  }, [isActive]);

  useEffect(() => {
    if (!xtermRef.current || !fitRef.current) return;
    if (fontFamily) xtermRef.current.options.fontFamily = `'${fontFamily}', monospace`;
    if (fontSize) xtermRef.current.options.fontSize = fontSize;
    if (bgColor) xtermRef.current.options.theme = { ...xtermRef.current.options.theme, background: bgColor };
    try { fitRef.current.fit(); } catch { /* not ready */ }
  }, [fontFamily, fontSize, bgColor]);

  useEffect(() => {
    if (!shareWs) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: fontFamily ? `'${fontFamily}', monospace` : '"Ubuntu Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: fontSize || 14,
      lineHeight: 1.35,
      theme: {
        background: bgColor || '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#f0f6fc',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

    const safeFit = () => {
      fit.fit();
      const { cols, rows } = term;
      const safeRows = Math.max(rows - 1, 1);
      term.resize(cols, safeRows);
    };

    let resizeTimer;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { safeFit(); } catch { /* disposed */ }
      }, 50);
    });

    resizeObserver.observe(termRef.current);

    const initTimers = [100, 300, 600].map((ms) => setTimeout(safeFit, ms));

    xtermRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[1;35m📡 Shared Terminal\x1b[0m');
    term.writeln(`\x1b[90mConnected to shared session ${shareCode?.substring(0, 8)}…\x1b[0m`);
    term.writeln('');

    // Receive output from relay
    const handleMessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
          term.write(msg.data);
        } else if (msg.type === 'host-disconnected') {
          term.writeln('\r\n\x1b[1;31mHost disconnected.\x1b[0m');
          onStatusChange?.('disconnected');
        }
      } catch {
        // Not JSON — ignore
      }
    };

    shareWs.addEventListener('message', handleMessage);

    // Send input to relay
    term.onData((data) => {
      if (shareWs.readyState === WebSocket.OPEN) {
        shareWs.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Send resize to relay
    term.onResize(({ cols, rows }) => {
      if (shareWs.readyState === WebSocket.OPEN) {
        shareWs.send(JSON.stringify({ type: 'resize', data: { cols, rows } }));
      }
    });

    return () => {
      shareWs.removeEventListener('message', handleMessage);
      initTimers.forEach(clearTimeout);
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareWs]);

  useEffect(() => {
    if (!isActive || !fitRef.current || !xtermRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current.fit();
        const { cols, rows } = xtermRef.current;
        const safeRows = Math.max(rows - 1, 1);
        xtermRef.current.resize(cols, safeRows);
      } catch { /* disposed */ }
    }, 50);
    return () => clearTimeout(timer);
  }, [isActive]);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="share-indicator share-indicator--viewer" title="Shared" />
          <span className="terminal-title">
            Shared ({shareCode?.substring(0, 8)}…)
          </span>
        </div>
        <div className="toolbar-right">
          {status === 'disconnected' && onReconnect && (
            <button className="console-btn" onClick={onReconnect} title="Reconnect">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          )}
          <button className="disconnect-btn" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="terminal-viewport" ref={termRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
});

export default SharedTerminal;
