import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ConnectionForm, Terminal, SharedTerminal, GeminiChat } from '@juni/shared-ui';

import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

let nextId = 1;
const SPLIT_GEMINI_ID = '__split_gemini__';

const GEMINI_MODELS = [
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

const MONO_FONTS = [
  { id: 'Ubuntu Mono', label: 'Ubuntu Mono', google: true },
  { id: 'JetBrains Mono', label: 'JetBrains Mono', google: true },
  { id: 'Fira Code', label: 'Fira Code', google: true },
  { id: 'Source Code Pro', label: 'Source Code Pro', google: true },
  { id: 'Inconsolata', label: 'Inconsolata', google: true },
  { id: 'IBM Plex Mono', label: 'IBM Plex Mono', google: true },
  { id: 'Space Mono', label: 'Space Mono', google: true },
  { id: 'Roboto Mono', label: 'Roboto Mono', google: true },
  { id: 'SF Mono', label: 'SF Mono (macOS)', google: false },
  { id: 'Menlo', label: 'Menlo (macOS)', google: false },
];

const SETTINGS_KEY = 'juni-cli:settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function loadGoogleFont(fontName) {
  const id = `gfont-${fontName.replace(/\s+/g, '-')}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;700&display=swap`;
  document.head.appendChild(link);
}

function App() {
  const [tabs, setTabs] = useState([]);           // { id, type, connection?, status }
  const [activeTab, setActiveTab] = useState(null); // id or null
  const [showForm, setShowForm] = useState(true);
  const [splitMode, setSplitMode] = useState(() => {
    const s = loadSettings();
    return s.splitMode ?? false;
  });
  const [splitLayout, setSplitLayout] = useState(() => {
    const s = loadSettings();
    return s.splitLayout ?? 'horizontal';
  });
  const [splitGeminiStatus, setSplitGeminiStatus] = useState('connecting');
  const [splitFocus, setSplitFocus] = useState('left');
  const [splitRatio, setSplitRatio] = useState(50);
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
  const [autoExecute, setAutoExecute] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [stepThrough, setStepThrough] = useState(false);

  const saved = loadSettings();
  const [fontFamily, setFontFamily] = useState(saved.fontFamily || 'Ubuntu Mono');
  const [fontSize, setFontSize] = useState(saved.fontSize || 15);
  const [bgColor, setBgColor] = useState(saved.bgColor || '#0d1117');

  // ── Sharing state ──────────────────────────────────
  const [sharingEnabled, setSharingEnabled] = useState(() => {
    const s = loadSettings();
    return s.sharingEnabled ?? false;
  });
  const [relayServerAddr, setRelayServerAddr] = useState(() => {
    const s = loadSettings();
    return s.relayServerAddr || '';
  });
  const [sharingState, setSharingState] = useState({});  // { [tabId]: { active, code, ws, viewerCount } }
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [connectCode, setConnectCode] = useState('');
  const [connectAddr, setConnectAddr] = useState('');
  const [connectError, setConnectError] = useState('');
  const connectDialogRef = useRef(null);



  const terminalRefs = useRef({});
  const splitGeminiRef = useRef(null);
  const settingsRef = useRef(null);
  const isDragging = useRef(false);
  const mainRef = useRef(null);

  // Load Google Font on mount and when font changes
  useEffect(() => {
    const font = MONO_FONTS.find((f) => f.id === fontFamily);
    if (font?.google) loadGoogleFont(fontFamily);
  }, [fontFamily]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ fontFamily, fontSize, bgColor, splitMode, splitLayout, sharingEnabled, relayServerAddr }));
  }, [fontFamily, fontSize, bgColor, splitMode, splitLayout, sharingEnabled, relayServerAddr]);

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-font', `'${fontFamily}', monospace`);
    document.documentElement.style.setProperty('--terminal-font-size', `${fontSize}px`);
    document.documentElement.style.setProperty('--terminal-bg', bgColor);
  }, [fontFamily, fontSize, bgColor]);

  const handleDividerMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = splitLayout === 'vertical' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [splitLayout]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      let pct;
      if (splitLayout === 'vertical') {
        const y = e.clientY - rect.top;
        pct = (y / rect.height) * 100;
      } else {
        const x = e.clientX - rect.left;
        pct = (x / rect.width) * 100;
      }
      setSplitRatio(Math.min(Math.max(pct, 15), 85));
    };
    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [splitLayout]);

  // Close settings when clicking outside
  useEffect(() => {
    if (!showSettings) return;
    const handleClick = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettings]);

  // Close connect dialog when clicking outside
  useEffect(() => {
    if (!showConnectDialog) return;
    const handleClick = (e) => {
      if (connectDialogRef.current && !connectDialogRef.current.contains(e.target)) {
        setShowConnectDialog(false);
        setConnectError('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showConnectDialog]);

  // Relay server base URL helper
  const getRelayWsUrl = useCallback((addrOverride) => {
    const addr = addrOverride || relayServerAddr || window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // If addr already includes protocol, use it as-is
    if (addr.startsWith('ws://') || addr.startsWith('wss://')) {
      return `${addr}/share`;
    }
    return `${protocol}://${addr}/share`;
  }, [relayServerAddr]);

  // ── Start sharing a terminal ──────────────────────
  const handleStartSharing = useCallback((tabId) => {
    const wsUrl = getRelayWsUrl() + '?role=host';
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[share] connected to relay as host');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'share-code') {
          setSharingState((prev) => ({
            ...prev,
            [tabId]: { active: true, code: msg.data, ws, viewerCount: 0 },
          }));
        } else if (msg.type === 'viewer-joined') {
          setSharingState((prev) => ({
            ...prev,
            [tabId]: { ...prev[tabId], viewerCount: msg.data.count },
          }));
        } else if (msg.type === 'viewer-left') {
          setSharingState((prev) => ({
            ...prev,
            [tabId]: { ...prev[tabId], viewerCount: msg.data.count },
          }));
        } else if (msg.type === 'input') {
          // Viewer typed something — send it to the SSH terminal
          const termRef = terminalRefs.current[tabId];
          if (termRef) termRef.writeToTerminal(msg.data);
        } else if (msg.type === 'resize') {
          // Viewer resized — ignore for now (host controls size)
        } else if (msg.type === 'expired') {
          handleStopSharing(tabId);
        } else if (msg.type === 'error') {
          console.error('[share] relay error:', msg.data);
          handleStopSharing(tabId);
        }
      } catch {
        // not JSON — ignore
      }
    };

    ws.onclose = () => {
      setSharingState((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    };

    ws.onerror = (err) => {
      console.error('[share] WebSocket error:', err);
    };

    // Set up output forwarding: listen on the Socket.IO connection for ssh:output
    // and relay it to viewers
    const termRef = terminalRefs.current[tabId];
    if (termRef && termRef._getSocket) {
      // We'll use a different approach: intercept in the next render cycle
    }
  }, [getRelayWsUrl]);

  // Forward terminal output to sharing relay
  useEffect(() => {
    // For each actively shared tab, we need to forward output
    const cleanups = [];
    for (const [tabId, state] of Object.entries(sharingState)) {
      if (!state.active || !state.ws) continue;
      const termRef = terminalRefs.current[tabId];
      if (!termRef) continue;
      // We'll hook into the xterm by using a MutationObserver approach
      // Actually, we need to intercept socket.io ssh:output events
      // The cleanest approach: add an onOutput callback to terminal
    }
    return () => cleanups.forEach((fn) => fn());
  }, [sharingState]);

  const handleStopSharing = useCallback((tabId) => {
    setSharingState((prev) => {
      const state = prev[tabId];
      if (state?.ws) {
        state.ws.close();
      }
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  // ── Connect to shared terminal ────────────────────
  const handleConnectToShared = useCallback(() => {
    setConnectError('');
    if (!connectCode.trim()) {
      setConnectError('Please enter a share code');
      return;
    }

    const addr = connectAddr.trim() || relayServerAddr || window.location.host;
    const wsUrl = getRelayWsUrl(addr) + `?role=viewer&code=${encodeURIComponent(connectCode.trim())}`;
    const ws = new WebSocket(wsUrl);

    const tabId = nextId++;

    ws.onopen = () => {
      console.log('[share] connected to relay as viewer');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'connected') {
          // Successfully joined — create the tab
          const newTab = {
            id: tabId,
            type: 'shared',
            shareCode: connectCode.trim(),
            shareWs: ws,
            status: 'ready',
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTab(tabId);
          setShowForm(false);
          setShowConnectDialog(false);
          setConnectCode('');
          setConnectError('');
        } else if (msg.type === 'host-disconnected') {
          setTabs((prev) =>
            prev.map((t) => (t.id === tabId ? { ...t, status: 'disconnected' } : t))
          );
        } else if (msg.type === 'error') {
          setConnectError(msg.data);
          ws.close();
        }
      } catch {
        // not JSON — raw terminal output
      }
    };

    ws.onclose = () => {
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId && t.type === 'shared' ? { ...t, status: 'disconnected' } : t))
      );
    };

    ws.onerror = () => {
      setConnectError('Failed to connect to relay server');
    };
  }, [connectCode, connectAddr, relayServerAddr, getRelayWsUrl]);

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

  const handleRunAgentCommand = useCallback(async (command) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return '(No SSH terminal connected)';
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return '(Terminal ref not found)';
    return termRef.runAgentCommand(command);
  }, [activeTab, tabs]);

  const handleSendAgentKeys = useCallback(async (keys) => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return '(No SSH terminal connected)';
    const termRef = terminalRefs.current[sshTabId];
    if (!termRef) return '(Terminal ref not found)';
    return termRef.sendAgentKeys(keys);
  }, [activeTab, tabs]);

  const handleAbortAgentCapture = useCallback(() => {
    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh')
      ? activeTab
      : tabs.find((t) => t.type === 'ssh')?.id;
    if (!sshTabId) return;
    const termRef = terminalRefs.current[sshTabId];
    if (termRef) termRef.abortAgentCapture();
  }, [activeTab, tabs]);

  const getTabLabel = (tab) => {
    if (tab.type === 'gemini') return 'Gemini';
    if (tab.type === 'shared') return `Shared (${tab.shareCode?.substring(0, 6)}…)`;
    return `${tab.connection.username}@${tab.connection.host}`;
  };

  // Determine status to display in header
  const activeSession = tabs.find((t) => t.id === activeTab);
  const displayStatus = showForm
    ? tabs.length > 0
      ? `${tabs.length} session${tabs.length > 1 ? 's' : ''}`
      : 'disconnected'
    : activeSession?.status || 'disconnected';

  // Gemini features require at least one connected SSH session
  const hasReadySSH = tabs.some((t) => t.type === 'ssh' && t.status === 'ready');

  // In split mode, show active tab on left and a dedicated Gemini on right
  const activeIsGeminiTab = activeSession?.type === 'gemini';

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>Juni CLI</h1>
        </div>
        <div className="header-right">
          <button
            className="split-toggle split-toggle--connect"
            onClick={() => setShowConnectDialog(true)}
            title="Connect to a shared terminal"
          >
            Connect to Shared
          </button>
          {hasReadySSH && (
            <button
              className={`split-toggle ${splitMode ? 'split-toggle--active' : ''}`}
              onClick={toggleSplit}
              title={splitMode ? 'Hide Gemini panel' : 'Show Gemini panel'}
            >
              Gemini
            </button>
          )}
          {hasReadySSH && (
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
          )}
          <div className="settings-wrapper" ref={settingsRef}>
            <span
              className={`settings-gear ${showSettings ? 'settings-gear--active' : ''}`}
              onClick={() => setShowSettings((prev) => !prev)}
              title="Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </span>
            {showSettings && (
              <div className="settings-panel">
                <div className="settings-title">Settings</div>
                <div className="settings-group">
                  <label className="settings-label">Font Family</label>
                  <select
                    className="settings-select"
                    value={fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                  >
                    {MONO_FONTS.map((f) => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div className="settings-group">
                  <label className="settings-label">
                    Font Size: {fontSize}px
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min="10"
                    max="22"
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                </div>
                <div className="settings-group">
                  <label className="settings-label">Background Color</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="color"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      style={{ width: '32px', height: '32px', border: 'none', cursor: 'pointer', background: 'none' }}
                    />
                    <input
                      className="settings-input"
                      type="text"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="settings-reset-btn"
                      onClick={() => setBgColor('#0d1117')}
                      title="Reset to default"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="settings-group">
                  <label className="settings-label">Split Layout</label>
                  <div className="settings-radio-group">
                    <label className={`settings-radio ${splitLayout === 'horizontal' ? 'settings-radio--active' : ''}`}>
                      <input
                        type="radio"
                        name="splitLayout"
                        value="horizontal"
                        checked={splitLayout === 'horizontal'}
                        onChange={() => setSplitLayout('horizontal')}
                      />
                      ◧ Left / Right
                    </label>
                    <label className={`settings-radio ${splitLayout === 'vertical' ? 'settings-radio--active' : ''}`}>
                      <input
                        type="radio"
                        name="splitLayout"
                        value="vertical"
                        checked={splitLayout === 'vertical'}
                        onChange={() => setSplitLayout('vertical')}
                      />
                      ⬒ Top / Bottom
                    </label>
                  </div>
                </div>
                <div className="settings-group">
                  <label className="settings-label">Terminal Sharing</label>
                  <label className="auto-execute-toggle">
                    <input
                      type="checkbox"
                      checked={sharingEnabled}
                      onChange={(e) => setSharingEnabled(e.target.checked)}
                    />
                    <span className="auto-execute-label">Enable sharing relay</span>
                  </label>
                </div>
                <div className="settings-group">
                  <label className="settings-label">Relay Server Address</label>
                  <input
                    className="settings-input"
                    type="text"
                    value={relayServerAddr}
                    onChange={(e) => setRelayServerAddr(e.target.value)}
                    placeholder={window.location.host}
                  />
                </div>
              </div>
            )}
          </div>
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
              className={`tab ${tab.id === activeTab && !showForm ? 'active' : ''} ${tab.type === 'gemini' ? 'tab--gemini' : ''} ${tab.type === 'shared' ? 'tab--shared' : ''} ${sharingState[tab.id]?.active ? 'tab--sharing' : ''}`}
              onClick={() => switchTab(tab.id)}
            >
              {tab.type === 'gemini' ? (
                <span className={`tab-status-dot ${tab.status}`} />
              ) : tab.type === 'shared' ? (
                <span className="tab-shared-icon">📡</span>
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
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          ))}

          {/* ── New tab buttons ─────────────────────────── */}
          <div className="tab-new-group">
            <button className="tab-new" onClick={handleNewTab} title="New SSH connection">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────── */}
      <main className={`app-main ${splitMode ? `app-main--split app-main--split-${splitLayout}` : ''}`} ref={mainRef} style={splitMode ? { '--split-ratio': `${splitRatio}%` } : undefined}>
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
                fontFamily={fontFamily}
                fontSize={fontSize}
                bgColor={bgColor}
                serverUrl={SERVER_URL}
                isSharing={!!sharingState[tab.id]?.active}
                shareCode={sharingState[tab.id]?.code || ''}
                viewerCount={sharingState[tab.id]?.viewerCount || 0}
                onShareStart={() => handleStartSharing(tab.id)}
                onShareStop={() => handleStopSharing(tab.id)}
                onTerminalOutput={(data) => {
                  const state = sharingState[tab.id];
                  if (state?.active && state?.ws?.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({ type: 'output', data }));
                  }
                }}
                onSendToGemini={splitMode ? sendToGemini : undefined}
              />
            ) : tab.type === 'gemini' ? (
              !splitMode && (
                <GeminiChat
                  key={tab.id}
                  model={selectedModel}
                  isActive={tab.id === activeTab && !showForm}
                  onStatusChange={(status) => handleStatusChange(tab.id, status)}
                  onClose={() => handleCloseTab(tab.id)}
                  onRunCommand={handleRunCommand}
                  agentMode={agentMode}
                    onAgentModeChange={setAgentMode}
                  onRunAgentCommand={handleRunAgentCommand}
                  onSendAgentKeys={handleSendAgentKeys}
                  onAbortAgentCapture={handleAbortAgentCapture}
                  serverUrl={SERVER_URL}
                  onReadTerminal={() => {
                    const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh') ? activeTab : tabs.find((t) => t.type === 'ssh')?.id;
                    if (!sshTabId) return '(No terminal connected)';
                    const termRef = terminalRefs.current[sshTabId];
                    return termRef ? termRef.getBufferText() : '(Terminal ref not found)';
                  }}
                  stepThrough={stepThrough}
                    onStepThroughChange={setStepThrough}
                    autoExecute={autoExecute}
                    onAutoExecuteChange={setAutoExecute}
                    onSendToTerminal={splitMode ? sendToTerminal : undefined}
                />
                )
            ) : null,
          )}

          {/* Shared terminal tabs */}
          {tabs.filter((t) => t.type === 'shared').map((tab) => (
            <SharedTerminal
              key={tab.id}
              ref={(el) => {
                if (el) terminalRefs.current[tab.id] = el;
                else delete terminalRefs.current[tab.id];
              }}
              tabId={tab.id}
              shareWs={tab.shareWs}
              shareCode={tab.shareCode}
              isActive={tab.id === activeTab && !showForm}
              onStatusChange={(status) => handleStatusChange(tab.id, status)}
              onClose={() => {
                if (tab.shareWs) tab.shareWs.close();
                handleCloseTab(tab.id);
              }}
              fontFamily={fontFamily}
              fontSize={fontSize}
              bgColor={bgColor}
            />
          ))}
        </div>

        {/* Right panel — Gemini (only in split mode) */}
        {splitMode && (
          <>
            <div className="split-divider" onMouseDown={handleDividerMouseDown} />
            <div className="split-panel split-panel--right">
              <GeminiChat
                key={SPLIT_GEMINI_ID}
                ref={splitGeminiRef}
                model={selectedModel}
                isActive={true}
                onStatusChange={(status) => setSplitGeminiStatus(status)}
                onClose={() => setSplitMode(false)}
                onRunCommand={handleRunCommand}
                agentMode={agentMode}
                onAgentModeChange={setAgentMode}
                onRunAgentCommand={handleRunAgentCommand}
                onSendAgentKeys={handleSendAgentKeys}
                onAbortAgentCapture={handleAbortAgentCapture}
                serverUrl={SERVER_URL}
                onReadTerminal={() => {
                  const sshTabId = activeTab && tabs.find((t) => t.id === activeTab && t.type === 'ssh') ? activeTab : tabs.find((t) => t.type === 'ssh')?.id;
                  if (!sshTabId) return '(No terminal connected)';
                  const termRef = terminalRefs.current[sshTabId];
                  return termRef ? termRef.getBufferText() : '(Terminal ref not found)';
                }}
                stepThrough={stepThrough}
                onStepThroughChange={setStepThrough}
                autoExecute={autoExecute}
                onAutoExecuteChange={setAutoExecute}
                onSendToTerminal={sendToTerminal}
              />
            </div>
          </>
        )}
      </main>

      {/* ── Connect to Shared dialog ─────────────────── */}
      {showConnectDialog && (
        <div className="connect-shared-overlay">
          <div className="connect-shared-dialog" ref={connectDialogRef}>
            <div className="settings-title">Connect to Shared Terminal</div>
            <div className="settings-group">
              <label className="settings-label">Relay Server</label>
              <input
                className="settings-input"
                type="text"
                value={connectAddr}
                onChange={(e) => setConnectAddr(e.target.value)}
                placeholder={relayServerAddr || window.location.host}
              />
            </div>
            <div className="settings-group">
              <label className="settings-label">Share Code</label>
              <input
                className="settings-input share-code-input"
                type="text"
                value={connectCode}
                onChange={(e) => setConnectCode(e.target.value)}
                placeholder="Paste share code here"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnectToShared();
                }}
              />
            </div>
            {connectError && (
              <div className="share-error">{connectError}</div>
            )}
            <div className="connect-shared-actions">
              <button
                className="share-start-btn"
                onClick={handleConnectToShared}
              >
                Connect
              </button>
              <button
                className="settings-reset-btn"
                onClick={() => {
                  setShowConnectDialog(false);
                  setConnectError('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
