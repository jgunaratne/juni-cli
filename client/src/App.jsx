import { useState, useCallback, useRef, useEffect } from 'react';
import ConnectionForm from './components/ConnectionForm';
import Terminal from './components/Terminal';
import GeminiChat from './components/GeminiChat';
import './App.css';

let nextId = 1;
const SPLIT_GEMINI_ID = '__split_gemini__';

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
];

function App() {
  const [tabs, setTabs] = useState([]);           // { id, type, connection?, status }
  const [activeTab, setActiveTab] = useState(null); // id or null
  const [showForm, setShowForm] = useState(true);
  const [splitMode, setSplitMode] = useState(false);
  const [splitGeminiStatus, setSplitGeminiStatus] = useState('connecting');
  const [splitFocus, setSplitFocus] = useState('left'); // 'left' or 'right'
  const [selectedModel, setSelectedModel] = useState('gemini-2.5-flash');
  const [autoExecute, setAutoExecute] = useState(true);

  const terminalRefs = useRef({});
  const splitGeminiRef = useRef(null);

  // Shift+Tab to toggle focus between split panels
  useEffect(() => {
    if (!splitMode) return;

    const handleKeyDown = (e) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        setSplitFocus((prev) => {
          const next = prev === 'left' ? 'right' : 'left';
          if (next === 'right') {
            splitGeminiRef.current?.focus();
          } else if (activeTab && terminalRefs.current[activeTab]) {
            terminalRefs.current[activeTab].focus();
          }
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [splitMode, activeTab]);

  const handleConnect = useCallback((credentials) => {
    const id = nextId++;
    const newTab = { id, type: 'ssh', connection: credentials, status: 'connecting' };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleOpenGemini = useCallback(() => {
    const id = nextId++;
    const newTab = { id, type: 'gemini', status: 'connecting' };
    setTabs((prev) => [...prev, newTab]);
    setActiveTab(id);
    setShowForm(false);
  }, []);

  const handleStatusChange = useCallback((tabId, newStatus) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, status: newStatus } : t)),
    );
  }, []);

  const handleCloseTab = useCallback(
    (tabId) => {
      setTabs((prev) => {
        const updated = prev.filter((t) => t.id !== tabId);
        if (activeTab === tabId) {
          if (updated.length > 0) {
            setActiveTab(updated[updated.length - 1].id);
            setShowForm(false);
          } else {
            setActiveTab(null);
            setShowForm(true);
          }
        }
        return updated;
      });
    },
    [activeTab],
  );

  const handleNewTab = useCallback(() => {
    setShowForm(true);
    setActiveTab(null);
  }, []);

  const switchTab = useCallback((tabId) => {
    setActiveTab(tabId);
    setShowForm(false);
  }, []);

  const toggleSplit = useCallback(() => {
    setSplitMode((prev) => !prev);
  }, []);

  const sendToGemini = useCallback(() => {
    if (!splitMode || !activeTab) return;
    const termRef = terminalRefs.current[activeTab];
    if (!termRef) return;
    const text = termRef.getBufferText();
    if (!text.trim()) return;
    splitGeminiRef.current?.pasteText(text);
  }, [splitMode, activeTab]);

  const sendToTerminal = useCallback(() => {
    if (!splitMode || !activeTab) return;
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text.trim()) return;
    const termRef = terminalRefs.current[activeTab];
    if (!termRef) return;
    termRef.writeToTerminal(text);
    termRef.focus();
  }, [splitMode, activeTab]);

  const handleRunCommand = useCallback((cmd) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return;
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return;
    termRef.writeToTerminal(autoExecute ? cmd + '\n' : cmd);
    termRef.focus();
  }, [activeTab, tabs, autoExecute]);

  const getTabLabel = (tab) => {
    if (tab.type === 'gemini') return 'Gemini';
    return `${tab.connection.username}@${tab.connection.host}`;
  };

  // Determine status to display in header
  const activeSession = tabs.find((t) => t.id === activeTab);
  const displayStatus = showForm
    ? tabs.length > 0
      ? `${tabs.length} session${tabs.length > 1 ? 's' : ''}`
      : 'disconnected'
    : activeSession?.status || 'disconnected';

  // In split mode, show active tab on left and a dedicated Gemini on right
  const activeIsGeminiTab = activeSession?.type === 'gemini';

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>juni-cli</h1>
        </div>
        <div className="header-right">
          <button
            className={`split-toggle ${splitMode ? 'split-toggle--active' : ''}`}
            onClick={toggleSplit}
            title={splitMode ? 'Exit split screen' : 'Split screen: Terminal + Gemini'}
          >
            <span className="split-toggle-icon">⬡</span>
            {splitMode ? 'Exit Split' : 'Split'}
          </button>
          {splitMode && activeSession?.type === 'ssh' && (
            <>
              <button
                className="split-toggle split-toggle--send"
                onClick={sendToGemini}
                title="Copy terminal output to Gemini input"
              >
                <span className="split-toggle-icon">→✦</span>
                Send to Gemini
              </button>
              <button
                className="split-toggle split-toggle--send"
                onClick={sendToTerminal}
                title="Paste highlighted Gemini text into terminal"
              >
                <span className="split-toggle-icon">✦→</span>
                Send to Terminal
              </button>
            </>
          )}
          <select
            className="model-selector"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            title="Select Gemini model"
          >
            {GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <label className="auto-execute-toggle" title="When enabled, clicking a command will execute it immediately">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => setAutoExecute(e.target.checked)}
            />
            <span className="auto-execute-label">Auto-execute</span>
          </label>
          <div className="status-bar">
            <span className={`status-dot ${activeSession?.status || ''}`} />
            <span className="status-text">{displayStatus}</span>
          </div>
        </div>
      </header>

      {/* ── Tab bar ──────────────────────────────────────── */}
      {(tabs.length > 0 || showForm) && (
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTab && !showForm ? 'active' : ''} ${tab.type === 'gemini' ? 'tab--gemini' : ''}`}
              onClick={() => switchTab(tab.id)}
            >
              {tab.type === 'gemini' ? (
                <span className="tab-gemini-icon">✦</span>
              ) : (
                  <span className={`tab-status-dot ${tab.status}`} />
              )}
              <span className="tab-label">
                {getTabLabel(tab)}
              </span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                title="Close session"
              >
                ✕
              </button>
            </div>
          ))}

          {/* ── New tab buttons ─────────────────────────── */}
          <div className="tab-new-group">
            <button className="tab-new" onClick={handleNewTab} title="New SSH connection">
              +
            </button>
            <button
              className="tab-new tab-new--gemini"
              onClick={handleOpenGemini}
              title="New Gemini chat"
            >
              ✦
            </button>
          </div>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────── */}
      <main className={`app-main ${splitMode ? 'app-main--split' : ''}`}>
        {/* Left panel (or full panel when not split) */}
        <div className={`split-panel split-panel--left ${splitMode ? '' : 'split-panel--full'}`}>
          {showForm && <ConnectionForm onConnect={handleConnect} />}

          {tabs.map((tab) =>
            tab.type === 'ssh' ? (
              <Terminal
                key={tab.id}
                ref={(el) => {
                  if (el) terminalRefs.current[tab.id] = el;
                  else delete terminalRefs.current[tab.id];
                }}
                tabId={tab.id}
                connection={tab.connection}
                isActive={tab.id === activeTab && !showForm}
                onStatusChange={(status) => handleStatusChange(tab.id, status)}
                onClose={() => handleCloseTab(tab.id)}
              />
            ) : (
                /* In split mode, hide Gemini tabs from the left panel */
                !splitMode && (
                  <GeminiChat
                    key={tab.id}
                    model={selectedModel}
                    isActive={tab.id === activeTab && !showForm}
                    onStatusChange={(status) => handleStatusChange(tab.id, status)}
                    onClose={() => handleCloseTab(tab.id)}
                    onRunCommand={handleRunCommand}
                  />
                )
            ),
          )}
        </div>

        {/* Right panel — Gemini (only in split mode) */}
        {splitMode && (
          <>
            <div className="split-divider" />
            <div className="split-panel split-panel--right">
              <GeminiChat
                key={SPLIT_GEMINI_ID}
                ref={splitGeminiRef}
                model={selectedModel}
                isActive={true}
                onStatusChange={(status) => setSplitGeminiStatus(status)}
                onClose={() => setSplitMode(false)}
                onRunCommand={handleRunCommand}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
