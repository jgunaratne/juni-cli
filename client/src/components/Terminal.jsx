import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

const AGENT_SENTINEL = '__JUNI_AGENT_DONE__';

const Terminal = forwardRef(function Terminal({ tabId, connection, isActive, onStatusChange, onClose, fontFamily, fontSize, bgColor }, ref) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const agentCaptureRef = useRef(null); // { buffer, resolve, timer }

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    getBufferText: () => {
      const term = xtermRef.current;
      if (!term) return '';
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)?.translateToString(true) ?? '';
        lines.push(line);
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      return lines.join('\n');
    },
    writeToTerminal: (text) => {
      if (socketRef.current) {
        socketRef.current.emit('ssh:data', text);
      }
    },
    runAgentCommand: (command) => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve('Error: terminal not connected');
          return;
        }
        // Set up capture
        const timer = setTimeout(() => {
          if (agentCaptureRef.current) {
            const output = agentCaptureRef.current.buffer;
            agentCaptureRef.current = null;
            resolve(output || '(command timed out after 30s)');
          }
        }, 30000);
        agentCaptureRef.current = { buffer: '', resolve, timer };
        // Send the command with sentinel
        socketRef.current.emit('ssh:data', `${command}; echo ${AGENT_SENTINEL}\n`);
      });
    },
  }));

  // Re-fit when tab becomes active (container goes from display:none → flex)
  useEffect(() => {
    if (isActive && fitRef.current) {
      // Need a small delay for the container to have layout dimensions
      requestAnimationFrame(() => {
        try {
          fitRef.current.fit();
          if (xtermRef.current) {
            xtermRef.current.focus();
          }
        } catch {
          // may throw if terminal not ready yet
        }
      });
    }
  }, [isActive]);

  // Update font when settings change
  useEffect(() => {
    if (!xtermRef.current || !fitRef.current) return;
    if (fontFamily) xtermRef.current.options.fontFamily = `'${fontFamily}', monospace`;
    if (fontSize) xtermRef.current.options.fontSize = fontSize;
    try { fitRef.current.fit(); } catch { /* not ready */ }
  }, [fontFamily, fontSize]);

  useEffect(() => {
    // ── Initialise xterm ──────────────────────────────────────
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: fontFamily ? `'${fontFamily}', monospace` : '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
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

    // ── Fit terminal to container via ResizeObserver ────────
    let resizeTimer;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
          const { cols, rows } = term;
          if (socketRef.current) {
            socketRef.current.emit('ssh:resize', { cols, rows });
          }
        } catch {
          // terminal may be disposed during cleanup
        }
      }, 50);
    });

    resizeObserver.observe(termRef.current);

    // Initial fit
    setTimeout(() => {
      fit.fit();
      const { cols, rows } = term;
      if (socketRef.current) {
        socketRef.current.emit('ssh:resize', { cols, rows });
      }
    }, 100);

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
      const { cols, rows } = term;
      socket.emit('ssh:resize', { cols, rows });
    });

    socket.on('ssh:output', (data) => {
      term.write(data);
      // Agent sentinel watcher
      if (agentCaptureRef.current) {
        agentCaptureRef.current.buffer += data;
        // Look for sentinel on its own line (the actual echo output),
        // not the one embedded in the echoed command line
        const sentinelLine = '\n' + AGENT_SENTINEL;
        if (agentCaptureRef.current.buffer.includes(sentinelLine)) {
          const { buffer, resolve, timer } = agentCaptureRef.current;
          clearTimeout(timer);
          agentCaptureRef.current = null;
          const stripped = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
          const idx = stripped.indexOf(sentinelLine);
          // Skip the first line (echoed command) and extract actual output
          const raw = stripped.substring(0, idx);
          const firstNewline = raw.indexOf('\n');
          const output = firstNewline >= 0
            ? raw.substring(firstNewline + 1).trim()
            : raw.trim();
          resolve(output);
        }
      }
    });

    socket.on('ssh:status', ({ status }) => {
      onStatusChange(status);
      if (status === 'ready') {
        // Shell is now open — re-fit and send final dimensions
        fit.fit();
        const { cols, rows } = term;
        socket.emit('ssh:resize', { cols, rows });
      }
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

    // Notify server when terminal dimensions change
    term.onResize(({ cols, rows }) => {
      socket.emit('ssh:resize', { cols, rows });
    });

    // Click-to-paste: clicking on selected text sends it as input
    let lastSelection = '';
    const selDisposable = term.onSelectionChange(() => {
      lastSelection = term.getSelection();
    });
    const el = termRef.current;
    const handleMouseDown = () => {
      // If there was a selection and the mousedown will clear it, paste it
      if (lastSelection) {
        // Use setTimeout so xterm processes the mousedown first (clears selection)
        const textToPaste = lastSelection;
        setTimeout(() => {
          // Only paste if the selection was actually cleared (user clicked, not started new selection)
          if (!term.getSelection()) {
            socket.emit('ssh:data', textToPaste);
          }
          lastSelection = '';
        }, 50);
      }
    };
    el.addEventListener('mousedown', handleMouseDown);

    // ── Cleanup ───────────────────────────────────────────────
    return () => {
      el.removeEventListener('mousedown', handleMouseDown);
      selDisposable.dispose();
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      socket.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="terminal-title">
            {connection.username}@{connection.host}:{connection.port}
          </span>
        </div>
        <button className="disconnect-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="terminal-viewport" ref={termRef} />
    </div>
  );
});

export default Terminal;
