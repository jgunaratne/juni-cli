import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { io } from 'socket.io-client';

import '@xterm/xterm/css/xterm.css';

// Base marker; each command appends its own sequence number and a closing __.
const AGENT_SENTINEL = '__JUNI_AGENT_DONE';

const stripAnsi = (str) => str
  .replace(/\x1b\[[\?=>!]?[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x9b[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b[()][A-Z0-9]/g, '')
  .replace(/\x1b[>=<~}|]/g, '')
  .replace(/\x1b\[[0-9;]*[ -/]*[@-~]/g, '')
  .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, '')
  .replace(/\r/g, '');

const Terminal = forwardRef(function Terminal({ tabId, connection, isActive, onStatusChange, onClose, fontFamily, fontSize, bgColor, serverUrl, isSharing, shareCode, viewerCount, onShareStart, onShareStop, onTerminalOutput, onSendToGemini }, ref) {
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const sharePanelRef = useRef(null);
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const agentCaptureRef = useRef(null);
  const agentSeqRef = useRef(0);
  const agentKeysRef = useRef(null);
  const onTerminalOutputRef = useRef(onTerminalOutput);
  // Keep the output callback ref current on every render
  useEffect(() => { onTerminalOutputRef.current = onTerminalOutput; });

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    getBufferText: () => {
      const term = xtermRef.current;
      // A parenthesised sentinel, not '': an empty string is indistinguishable
      // from a genuinely blank buffer, and that ambiguity is exactly what makes
      // the agent report "nothing in the terminal" when the real answer is
      // "this component never finished mounting". terminalSnapshot() collapses
      // sentinels to '' for chat, so nothing leaks into ambient context.
      if (!term) return '(Terminal not initialized)';
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
    abortAgentCapture: () => {
      if (agentCaptureRef.current) {
        const { resolve, timer, buffer } = agentCaptureRef.current;
        clearTimeout(timer);
        agentCaptureRef.current = null;
        const raw = stripAnsi(buffer).trim();
        resolve({ output: raw || '(aborted by user)', timedOut: false, exitCode: null, aborted: true });
      }
      if (agentKeysRef.current) {
        const { resolve, timer, cleanup } = agentKeysRef.current;
        clearTimeout(timer);
        cleanup();
        agentKeysRef.current = null;
        resolve('(aborted by user)');
      }
    },
    sendAgentKeys: (keys) => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve('Error: terminal not connected');
          return;
        }

        const KEY_MAP = {
          'Enter': '\r',
          'Return': '\r',
          'Tab': '\t',
          'Escape': '\x1b',
          'Esc': '\x1b',
          'Backspace': '\x7f',
          'Delete': '\x1b[3~',
          'Up': '\x1b[A',
          'Down': '\x1b[B',
          'Right': '\x1b[C',
          'Left': '\x1b[D',
          'Home': '\x1b[H',
          'End': '\x1b[F',
          'PageUp': '\x1b[5~',
          'PageDown': '\x1b[6~',
          'Ctrl+C': '\x03',
          'Ctrl+D': '\x04',
          'Ctrl+Z': '\x1a',
          'Ctrl+L': '\x0c',
          'Ctrl+A': '\x01',
          'Ctrl+E': '\x05',
          'Ctrl+K': '\x0b',
          'Ctrl+U': '\x15',
          'Ctrl+W': '\x17',
          'Ctrl+R': '\x12',
          'Space': ' ',
        };

        // Whitespace separates key names from literal text, but two adjacent
        // literals were being glued together — "git commit -m x Enter" arrived
        // as "gitcommit-mx". Spaces are restored between neighbouring literals
        // while key names stay as control codes.
        const tokens = keys.split(/\s+/).filter((t) => t.length > 0);
        let payload = '';
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          if (KEY_MAP[token] !== undefined) {
            payload += KEY_MAP[token];
          } else {
            payload += token;
            const next = tokens[i + 1];
            if (next !== undefined && KEY_MAP[next] === undefined) payload += ' ';
          }
        }

        let outputBuffer = '';
        const onOutput = (data) => {
          outputBuffer += data;
        };
        socketRef.current.on('ssh:output', onOutput);

        const cleanup = () => {
          socketRef.current?.off('ssh:output', onOutput);
        };

        socketRef.current.emit('ssh:data', payload);

        const timer = setTimeout(() => {
          cleanup();
          agentKeysRef.current = null;
          const cleaned = stripAnsi(outputBuffer).trim();
          resolve(cleaned || '(no visible output after sending keys)');
        }, 3000);

        agentKeysRef.current = { resolve, timer, cleanup };
      });
    },
    runAgentCommand: (command) => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          resolve({ output: 'Error: terminal not connected', timedOut: false, exitCode: null });
          return;
        }
        // A timed-out command is abandoned here but keeps running on the remote,
        // so its markers arrive later, during some *later* capture. Shared
        // markers would let that straggler complete the next command with the
        // wrong output, so each command gets its own pair.
        const seq = ++agentSeqRef.current;
        const begin = `${AGENT_SENTINEL}_${seq}_B__`;
        const end = `${AGENT_SENTINEL}_${seq}_E__`;

        const timer = setTimeout(() => {
          if (agentCaptureRef.current && agentCaptureRef.current.seq === seq) {
            const raw = stripAnsi(agentCaptureRef.current.buffer).trim();
            agentCaptureRef.current = null;
            // timedOut is reported as a field, never by wording inside output: a
            // command that times out after printing something still has a
            // truthy buffer, and callers must not guess from the text.
            resolve({ output: raw, timedOut: true, exitCode: null });
          }
        }, 20000);
        agentCaptureRef.current = { buffer: '', resolve, timer, seq, begin, end };

        // The output is bracketed by two markers the shell prints itself, so
        // extraction never has to guess where output ends. Sending the command
        // and the trailing marker as two separate lines used to leave the shell
        // prompt and the echoed marker line inside the captured output — for a
        // command with no output that noise *was* the output the model saw.
        // Keeping it to one typed line puts the prompt outside the markers.
        let payload;
        if (command.includes('\n')) {
          // A heredoc or loop cannot be flattened onto one line, so it travels
          // base64-encoded. `eval` runs it in the CURRENT shell, so cd and
          // exports still persist between agent commands — a subshell would
          // silently discard them.
          const encoded = btoa(unescape(encodeURIComponent(command)));
          payload = `printf '\\n${begin}\\n'; eval "$(printf %s ${encoded} | base64 -d)"; __jrc=$?; printf '\\n${end}:%s\\n' "$__jrc"\n`;
        } else {
          // PAGER=cat keeps git log, man and friends from opening a pager that
          // would trap the agent until the timeout.
          payload = `printf '\\n${begin}\\n'; PAGER=cat ${command}; __jrc=$?; printf '\\n${end}:%s\\n' "$__jrc"\n`;
        }
        socketRef.current.emit('ssh:data', payload);
      });
    },
  }));

  useEffect(() => {
    if (isActive && fitRef.current) {
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

  useEffect(() => {
    if (!xtermRef.current || !fitRef.current) return;
    if (fontFamily) xtermRef.current.options.fontFamily = `'${fontFamily}', monospace`;
    if (fontSize) xtermRef.current.options.fontSize = fontSize;
    if (bgColor) xtermRef.current.options.theme = { ...xtermRef.current.options.theme, background: bgColor };
    try { fitRef.current.fit(); } catch { /* not ready */ }
  }, [fontFamily, fontSize, bgColor]);

  useEffect(() => {
    const effectiveServerUrl = serverUrl || window.location.origin;

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
      if (socketRef.current) {
        socketRef.current.emit('ssh:resize', { cols, rows: safeRows });
      }
    };

    let resizeTimer;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          safeFit();
        } catch {
          // terminal may be disposed during cleanup
        }
      }, 50);
    });

    resizeObserver.observe(termRef.current);

    const initTimers = [100, 300, 600].map((ms) => setTimeout(safeFit, ms));

    xtermRef.current = term;
    fitRef.current = fit;

    const isLocal = connection.local;

    term.writeln('\x1b[1;36m⬡ juni-cli-proton\x1b[0m');
    if (isLocal) {
      term.writeln('\x1b[90mOpening local shell…\x1b[0m');
    } else {
      term.writeln(`\x1b[90mConnecting to ${connection.username}@${connection.host}:${connection.port}…\x1b[0m`);
    }
    term.writeln('');

    const socket = io(effectiveServerUrl, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('ssh:connect', connection);
      safeFit();
    });



    socket.on('ssh:output', (data) => {
      term.write(data);
      // Forward to sharing relay if active
      if (onTerminalOutputRef.current) {
        onTerminalOutputRef.current(data);
      }
      if (agentCaptureRef.current) {
        agentCaptureRef.current.buffer += data;
        const stripped = stripAnsi(agentCaptureRef.current.buffer);
        // The closing marker carries the exit status. Requiring digits after the
        // colon is what separates it from the shell's echo of the command line,
        // where the same marker appears followed by an unexpanded "%s".
        const endPattern = new RegExp(`\\n${agentCaptureRef.current.end}:(\\d+)`);
        const match = endPattern.exec(stripped);
        if (match) {
          const { resolve, timer, begin } = agentCaptureRef.current;
          clearTimeout(timer);
          agentCaptureRef.current = null;
          const before = stripped.slice(0, match.index);
          // Everything after the opening marker's own line is the command's
          // output; the echoed command line sits before it.
          const beginTag = `\n${begin}\n`;
          const beginIdx = before.lastIndexOf(beginTag);
          const output = beginIdx >= 0 ? before.slice(beginIdx + beginTag.length) : before;
          resolve({ output: output.replace(/\s+$/, ''), timedOut: false, exitCode: Number(match[1]) });
        }
      }
    });

    socket.on('ssh:status', ({ status }) => {
      onStatusChange(status);
      if (status === 'ready') {
        safeFit();
        term.focus();
      }
      if (status === 'disconnected') {
        term.writeln('\r\n\x1b[1;31mConnection closed.\x1b[0m');
      }
    });

    socket.on('ssh:error', ({ message }) => {
      term.writeln(`\r\n\x1b[1;31mError: ${message}\x1b[0m`);
      onStatusChange('error');
    });

    term.onData((data) => {
      socket.emit('ssh:data', data);
    });

    term.onResize(({ cols, rows }) => {
      socket.emit('ssh:resize', { cols, rows });
    });

    let lastSelection = '';
    const selDisposable = term.onSelectionChange(() => {
      lastSelection = term.getSelection();
    });
    const el = termRef.current;
    const handleMouseDown = () => {
      if (lastSelection) {
        const textToPaste = lastSelection;
        setTimeout(() => {
          if (!term.getSelection()) {
            socket.emit('ssh:data', textToPaste);
          }
          lastSelection = '';
        }, 50);
      }
    };
    el.addEventListener('mousedown', handleMouseDown);

    return () => {
      el.removeEventListener('mousedown', handleMouseDown);
      selDisposable.dispose();
      initTimers.forEach(clearTimeout);
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      socket.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, reconnectCount]);

  useEffect(() => {
    if (!isActive || !fitRef.current || !xtermRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitRef.current.fit();
        const { cols, rows } = xtermRef.current;
        const safeRows = Math.max(rows - 1, 1);
        xtermRef.current.resize(cols, safeRows);
        if (socketRef.current) {
          socketRef.current.emit('ssh:resize', { cols, rows: safeRows });
        }
      } catch {
        // terminal may be disposed
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [isActive]);

  // Close share panel when clicking outside
  useEffect(() => {
    if (!showSharePanel) return;
    const handleClick = (e) => {
      if (sharePanelRef.current && !sharePanelRef.current.contains(e.target)) {
        setShowSharePanel(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSharePanel]);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          {isSharing && <span className="share-indicator" title="Sharing active" />}
          <span className="terminal-title">
            {connection.local
              ? 'local shell'
              : `${connection.username}@${connection.host}:${connection.port}`
            }
          </span>
          {isSharing && viewerCount > 0 && (
            <span className="share-viewer-count">{viewerCount} viewer{viewerCount !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="toolbar-right">
          <button
            className="reconnect-btn"
            onClick={() => {
              // Disconnect old socket so the useEffect cleanup runs
              if (socketRef.current) {
                socketRef.current.disconnect();
                socketRef.current = null;
              }
              if (xtermRef.current) {
                xtermRef.current.clear();
              }
              onStatusChange('connecting');
              setReconnectCount((c) => c + 1);
            }}
            title="Reconnect SSH session"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
          </button>
          <div className="share-wrapper" ref={sharePanelRef}>
            <button
              className={`share-btn ${isSharing ? 'share-btn--active' : ''}`}
              onClick={() => setShowSharePanel((prev) => !prev)}
              title={isSharing ? 'Sharing active' : 'Share this terminal'}
            >
              {isSharing && <span className="share-indicator" style={{ width: 6, height: 6, background: '#56d364', boxShadow: '0 0 6px rgba(86, 211, 100, 0.6)' }} />} Share
            </button>
            {showSharePanel && (
              <div className="share-panel">
                <div className="settings-title">Terminal Sharing</div>
                {isSharing ? (
                  <>
                    <div className="settings-group">
                      <label className="settings-label">Share Code</label>
                      <div className="share-code-display">
                        <code className="share-code">{shareCode}</code>
                        <button
                          className="share-copy-btn"
                          onClick={() => {
                            navigator.clipboard.writeText(shareCode);
                          }}
                          title="Copy to clipboard"
                        >
                          📋
                        </button>
                      </div>
                    </div>
                    {viewerCount > 0 && (
                      <div className="share-viewers-info">
                        {viewerCount} viewer{viewerCount !== 1 ? 's' : ''} connected
                      </div>
                    )}
                    <button
                      className="share-stop-btn"
                      onClick={() => {
                        onShareStop?.();
                        setShowSharePanel(false);
                      }}
                    >
                      ⏹ Stop Sharing
                    </button>
                  </>
                ) : (
                  <>
                    <p className="share-description">
                      Share this terminal session. A secure code will be generated that others can use to connect.
                    </p>
                    <button
                      className="share-start-btn"
                      onClick={() => {
                        onShareStart?.();
                      }}
                    >
                        Start Sharing
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {onSendToGemini && (
            <button className="disconnect-btn send-to-gemini-btn" onClick={onSendToGemini} title="Copy terminal output to the Agent input">
              → Agent
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

export default Terminal;
