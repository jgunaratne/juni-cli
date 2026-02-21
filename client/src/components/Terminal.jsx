import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';

const SERVER_URL = 'http://localhost:3001';

export default function Terminal({ connection, onStatusChange, onDisconnect }) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    onDisconnect();
  }, [onDisconnect]);

  useEffect(() => {
    // ── Initialise xterm ──────────────────────────────────────
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.35,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
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

    // Small delay to ensure DOM is ready for fit
    requestAnimationFrame(() => fit.fit());

    xtermRef.current = term;
    fitRef.current = fit;

    term.writeln('\x1b[1;36m⬡ juni-cli\x1b[0m');
    term.writeln(`\x1b[90mConnecting to ${connection.username}@${connection.host}:${connection.port}…\x1b[0m`);
    term.writeln('');

    // ── Socket.io ─────────────────────────────────────────────
    const socket = io(SERVER_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('ssh:connect', connection);
    });

    socket.on('ssh:output', (data) => {
      term.write(data);
    });

    socket.on('ssh:status', ({ status }) => {
      onStatusChange(status);
      if (status === 'disconnected') {
        term.writeln('\r\n\x1b[1;31mConnection closed.\x1b[0m');
      }
    });

    socket.on('ssh:error', ({ message }) => {
      term.writeln(`\r\n\x1b[1;31mError: ${message}\x1b[0m`);
      onStatusChange('error');
    });

    // Browser → SSH
    term.onData((data) => {
      socket.emit('ssh:data', data);
    });

    // Resize handling
    const handleResize = () => {
      fit.fit();
      const { cols, rows } = term;
      socket.emit('ssh:resize', { cols, rows });
    };

    term.onResize(({ cols, rows }) => {
      socket.emit('ssh:resize', { cols, rows });
    });

    window.addEventListener('resize', handleResize);

    // ── Cleanup ───────────────────────────────────────────────
    return () => {
      window.removeEventListener('resize', handleResize);
      socket.disconnect();
      term.dispose();
    };
  }, [connection, onStatusChange]);

  return (
    <div className="terminal-container">
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="terminal-title">
            {connection.username}@{connection.host}
          </span>
        </div>
        <button className="disconnect-btn" onClick={disconnect}>
          ✕ Disconnect
        </button>
      </div>
      <div className="terminal-viewport" ref={termRef} />
    </div>
  );
}
