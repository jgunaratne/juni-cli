import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

/* ── API helpers ─────────────────────────────────────── */

async function callGemini(model, messages) {
  const res = await fetch(`${SERVER_URL}/api/gemini/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.reply ?? 'No response generated.';
}

/* ── Simple markdown → ANSI-style terminal rendering ── */

function renderForTerminal(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => code)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^### (.+)$/gm, '  $1')
    .replace(/^## (.+)$/gm, '  $1')
    .replace(/^# (.+)$/gm, '  $1');
}

/* ── Component ────────────────────────────────────────── */

const GeminiChat = forwardRef(function GeminiChat({ model = 'gemini-3-flash-preview', isActive, onStatusChange, onRunCommand }, ref) {
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    pasteText: (text) => {
      setInput(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  }));

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Signal ready status on mount
  useEffect(() => {
    onStatusChange('ready');
  }, [onStatusChange]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Focus input when tab becomes active
  useEffect(() => {
    if (isActive) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isActive]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Handle special commands
    if (text === 'clear') {
      setMessages([]);
      setInput('');
      return;
    }

    if (text === 'help') {
      setMessages((prev) => [
        ...prev,
        { type: 'system', text: 'Available commands:' },
        { type: 'system', text: '  clear     — Clear the terminal' },
        { type: 'system', text: '  help      — Show this help message' },
        { type: 'system', text: '  model     — Show current model info' },
        { type: 'system', text: '' },
        { type: 'system', text: 'Type any message to chat with Gemini.' },
      ]);
      setInput('');
      return;
    }

    if (text === 'model') {
      setMessages((prev) => [
        ...prev,
        { type: 'system', text: `Model: ${model} (via Vertex AI)` },
      ]);
      setInput('');
      return;
    }

    // Add to command history
    setCommandHistory((prev) => [text, ...prev].slice(0, 50));
    setHistoryIndex(-1);

    const userEntry = { type: 'user', text };
    setMessages((prev) => [...prev, userEntry]);
    setInput('');
    setIsLoading(true);

    try {
      // Build message history for API (only user/model messages)
      const apiMessages = [...messages, userEntry]
        .filter((m) => m.type === 'user' || m.type === 'model')
        .map((m) => ({ role: m.type === 'user' ? 'user' : 'model', text: m.text }));

      const reply = await callGemini(model, apiMessages);
      setMessages((prev) => [...prev, { type: 'model', text: renderForTerminal(reply) }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { type: 'error', text: err instanceof Error ? err.message : 'Unknown error' },
      ]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [input, isLoading, messages, model]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      // Arrow up/down for command history
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length > 0) {
          const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setInput(commandHistory[newIndex]);
        } else {
          setHistoryIndex(-1);
          setInput('');
        }
      }
    },
    [handleSend, commandHistory, historyIndex],
  );

  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  return (
    <div
      className="terminal-container"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      <div className="terminal-toolbar">
        <div className="toolbar-left">
          <span className="gemini-toolbar-icon">✦</span>
          <span className="terminal-title">gemini — Vertex AI</span>
        </div>
        <button className="disconnect-btn" onClick={handleClear}>
          ⌫ Clear
        </button>
      </div>

      <div
        className="gemini-terminal"
        ref={scrollRef}
        onClick={() => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) {
            inputRef.current?.focus();
          }
        }}
      >
        {/* Welcome banner */}
        {messages.length === 0 && !isLoading && (
          <div className="gemini-term-welcome">
            <div className="gemini-term-ascii">
{`  ██████╗ ███████╗███╗   ███╗██╗███╗   ██╗██╗
 ██╔════╝ ██╔════╝████╗ ████║██║████╗  ██║██║
 ██║  ███╗█████╗  ██╔████╔██║██║██╔██╗ ██║██║
 ██║   ██║██╔══╝  ██║╚██╔╝██║██║██║╚██╗██║██║
 ╚██████╔╝███████╗██║ ╚═╝ ██║██║██║ ╚████║██║
  ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝`}
            </div>
            <div className="gemini-term-info">
              <span className="gemini-term-label">{model}</span> via Vertex AI
            </div>
            <div className="gemini-term-hint">
              Type a message to chat, or <span className="gemini-term-cmd">help</span> for commands.
            </div>
          </div>
        )}

        {/* Message history */}
        {messages.map((entry, i) => (
          <div key={i} className={`gemini-term-line gemini-term-line--${entry.type}`}>
            {entry.type === 'user' && (
              <>
                <span className="gemini-term-prompt-symbol">❯</span>
                <span className="gemini-term-prompt-text">{entry.text}</span>
              </>
            )}
            {entry.type === 'model' && (
              <pre className="gemini-term-response">
                {entry.text.split(/(<cmd>.*?<\/cmd>)/g).map((part, j) => {
                  const match = part.match(/^<cmd>(.*?)<\/cmd>$/);
                  if (match) {
                    const cmd = match[1];
                    return (
                      <span
                        key={j}
                        className="gemini-cmd-tag"
                        title={`Click to run: ${cmd}`}
                        onClick={() => onRunCommand?.(cmd)}
                      >
                        {cmd}
                      </span>
                    );
                  }
                  return part;
                })}
              </pre>
            )}
            {entry.type === 'error' && (
              <span className="gemini-term-error">error: {entry.text}</span>
            )}
            {entry.type === 'system' && (
              <span className="gemini-term-system">{entry.text}</span>
            )}
          </div>
        ))}

        {/* Loading indicator */}
        {isLoading && (
          <div className="gemini-term-line gemini-term-line--loading">
            <span className="gemini-term-spinner" />
            <span className="gemini-term-loading-text">thinking…</span>
          </div>
        )}

        {/* Input line */}
        {!isLoading && (
          <div
            className="gemini-term-input-line"
            onClick={() => inputRef.current?.focus()}
          >
            <span className="gemini-term-prompt-symbol">❯</span>
            <div className="gemini-term-input-wrapper">
              <span className="gemini-term-input-display">{input}</span>
              <span className="gemini-term-cursor" />
              <input
                ref={inputRef}
                className="gemini-term-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                autoComplete="off"
                spellCheck="false"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default GeminiChat;
