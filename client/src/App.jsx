import { useState, useCallback, useRef } from 'react';
import ConnectionForm from './components/ConnectionForm';
import Terminal from './components/Terminal';
import './App.css';

let nextId = 1;

function App() {
  const [tabs, setTabs] = useState([]);           // { id, connection, status }
  const [activeTab, setActiveTab] = useState(null); // id or 'new'
  const [showForm, setShowForm] = useState(true);

  const handleConnect = useCallback((credentials) => {
    const id = nextId++;
    const newTab = { id, connection: credentials, status: 'connecting' };
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
        // If we closed the active tab, switch to another or show form
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

  // Determine status to display in header
  const activeSession = tabs.find((t) => t.id === activeTab);
  const displayStatus = showForm
    ? tabs.length > 0
      ? `${tabs.length} session${tabs.length > 1 ? 's' : ''}`
      : 'disconnected'
    : activeSession?.status || 'disconnected';

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>juni-cli</h1>
        </div>
        <div className="status-bar">
          <span className={`status-dot ${activeSession?.status || ''}`} />
          <span className="status-text">{displayStatus}</span>
        </div>
      </header>

      {/* ── Tab bar ──────────────────────────────────────── */}
      {tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTab && !showForm ? 'active' : ''}`}
              onClick={() => switchTab(tab.id)}
            >
              <span className={`tab-status-dot ${tab.status}`} />
              <span className="tab-label">
                {tab.connection.username}@{tab.connection.host}
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
          <button className="tab-new" onClick={handleNewTab} title="New connection">
            +
          </button>
        </div>
      )}

      {/* ── Content ─────────────────────────────────────── */}
      <main className="app-main">
        {showForm && <ConnectionForm onConnect={handleConnect} />}

        {tabs.map((tab) => (
          <Terminal
            key={tab.id}
            tabId={tab.id}
            connection={tab.connection}
            isActive={tab.id === activeTab && !showForm}
            onStatusChange={(status) => handleStatusChange(tab.id, status)}
            onClose={() => handleCloseTab(tab.id)}
          />
        ))}
      </main>
    </div>
  );
}

export default App;
