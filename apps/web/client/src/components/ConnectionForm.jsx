import { useState, useEffect, useRef } from 'react';

const HISTORY_KEY = 'juni-cli:connection-history';
const MAX_HISTORY = 20;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory({ protocol, host, port, username, password, savePassword }) {
  const history = loadHistory();
  const proto = protocol || 'ssh';
  const key = `${proto}:${host}:${port}:${username || ''}`;
  const filtered = history.filter(
    (h) => `${h.protocol || 'ssh'}:${h.host}:${h.port}:${h.username || ''}` !== key,
  );
  const entry = { protocol: proto, host, port, username: username || '', lastUsed: Date.now() };
  if (savePassword && password) {
    entry.savedPassword = btoa(password);
  }
  filtered.unshift(entry);
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(filtered.slice(0, MAX_HISTORY)),
  );
}

export { saveToHistory };

export default function ConnectionForm({ onConnect }) {
  const [protocol, setProtocol] = useState('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [savePassword, setSavePassword] = useState(false);
  const [history, setHistory] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [filteredHistory, setFilteredHistory] = useState([]);
  const dropdownRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const handleProtocolChange = (newProtocol) => {
    setProtocol(newProtocol);
    if (newProtocol === 'vnc' && port === '22') {
      setPort('5900');
    } else if (newProtocol === 'ssh' && port === '5900') {
      setPort('22');
    }
  };

  useEffect(() => {
    if (!host) {
      setFilteredHistory(history.filter((h) => (h.protocol || 'ssh') === protocol));
    } else {
      setFilteredHistory(
        history.filter((h) =>
          (h.protocol || 'ssh') === protocol &&
          h.host.toLowerCase().includes(host.toLowerCase()),
        ),
      );
    }
  }, [host, history, protocol]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        hostRef.current &&
        !hostRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectHistory = (entry) => {
    setProtocol(entry.protocol || 'ssh');
    setHost(entry.host);
    setPort(String(entry.port));
    setUsername(entry.username || '');
    if (entry.savedPassword) {
      try {
        setPassword(atob(entry.savedPassword));
        setSavePassword(true);
      } catch {
        setPassword('');
        setSavePassword(false);
      }
    } else {
      setPassword('');
      setSavePassword(false);
    }
    setShowDropdown(false);
    if (entry.savedPassword) {
      document.querySelector('.connect-btn')?.focus();
    } else {
      document.getElementById('password')?.focus();
    }
  };

  const removeHistory = (e, entry) => {
    e.stopPropagation();
    const key = `${entry.protocol || 'ssh'}:${entry.host}:${entry.port}:${entry.username || ''}`;
    const updated = history.filter(
      (h) => `${h.protocol || 'ssh'}:${h.host}:${h.port}:${h.username || ''}` !== key,
    );
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    setHistory(updated);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!host) return;
    if (!username && protocol === 'ssh') return;

    const credentials = { protocol, host, port: Number(port), username, password };
    saveToHistory({ ...credentials, savePassword });
    onConnect(credentials);
  };

  return (
    <div className="connection-form-wrapper">
      <form className="connection-form" onSubmit={handleSubmit}>
        <div className="form-header">
          <span className="form-icon">{protocol === 'vnc' ? '🖥' : '🔐'}</span>
          <h2>{protocol === 'vnc' ? 'VNC Connection' : 'SSH Connection'}</h2>
          <p className="form-subtitle">Connect to a remote server</p>
        </div>

        {/* ── Protocol Toggle ──────────────────────── */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '28px' }}>
          <button
            type="button"
            onClick={() => handleProtocolChange('ssh')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              background: protocol === 'ssh' ? 'rgba(88, 166, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
              border: `1px solid ${protocol === 'ssh' ? 'rgba(88, 166, 255, 0.5)' : 'rgba(48, 54, 61, 0.6)'}`,
              borderRadius: '6px',
              color: protocol === 'ssh' ? '#58a6ff' : '#484f58',
              fontFamily: "'Inter', sans-serif",
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: protocol === 'ssh' ? '0 0 12px rgba(88, 166, 255, 0.15)' : 'none',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            SSH
          </button>
          <button
            type="button"
            onClick={() => handleProtocolChange('vnc')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              background: protocol === 'vnc' ? 'rgba(45, 212, 191, 0.12)' : 'rgba(255, 255, 255, 0.04)',
              border: `1px solid ${protocol === 'vnc' ? 'rgba(45, 212, 191, 0.5)' : 'rgba(48, 54, 61, 0.6)'}`,
              borderRadius: '6px',
              color: protocol === 'vnc' ? '#2dd4bf' : '#484f58',
              fontFamily: "'Inter', sans-serif",
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: protocol === 'vnc' ? '0 0 12px rgba(45, 212, 191, 0.15)' : 'none',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            VNC
          </button>
        </div>

        <div className="form-grid">
          <div className="form-group host-group">
            <label htmlFor="host">Host</label>
            <div className="host-input-wrapper">
              <input
                id="host"
                ref={hostRef}
                type="text"
                placeholder="192.168.1.1 or hostname"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onFocus={() => history.length > 0 && setShowDropdown(true)}
                autoComplete="off"
                autoFocus
                required
              />
              {history.length > 0 && (
                <button
                  type="button"
                  className="dropdown-toggle"
                  onClick={() => setShowDropdown(!showDropdown)}
                  tabIndex={-1}
                  aria-label="Show connection history"
                >
                  ▾
                </button>
              )}
              {showDropdown && filteredHistory.length > 0 && (
                <ul className="host-dropdown" ref={dropdownRef}>
                  {filteredHistory.map((entry) => (
                    <li
                      key={`${entry.protocol || 'ssh'}:${entry.host}:${entry.port}:${entry.username || ''}`}
                      onClick={() => selectHistory(entry)}
                    >
                      <div className="history-entry">
                        <span className="history-host">{entry.host}</span>
                        <span className="history-detail">
                          {entry.protocol === 'vnc'
                            ? `VNC :${entry.port}`
                            : `${entry.username}@:${entry.port}`
                          }
                        </span>
                      </div>
                      <button
                        type="button"
                        className="history-remove"
                        onClick={(e) => removeHistory(e, entry)}
                        title="Remove from history"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="form-group port-group">
            <label htmlFor="port">Port</label>
            <input
              id="port"
              type="number"
              placeholder={protocol === 'vnc' ? '5900' : '22'}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              min="1"
              max="65535"
            />
          </div>

          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              placeholder={protocol === 'vnc' ? '(optional)' : 'root'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required={protocol === 'ssh'}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <label className="save-password-toggle">
            <input
              type="checkbox"
              checked={savePassword}
              onChange={(e) => setSavePassword(e.target.checked)}
            />
            <span className="save-password-label">Save password</span>
          </label>
        </div>

        <button type="submit" className="connect-btn">
          <span className="btn-icon">→</span>
          Connect
        </button>
      </form>
    </div>
  );
}
