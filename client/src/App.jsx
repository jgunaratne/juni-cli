import { useState, useCallback } from 'react';
import ConnectionForm from './components/ConnectionForm';
import Terminal from './components/Terminal';
import './App.css';

function App() {
  const [connection, setConnection] = useState(null);
  const [status, setStatus] = useState('disconnected');

  const handleConnect = useCallback((credentials) => {
    setConnection(credentials);
    setStatus('connecting');
  }, []);

  const handleStatusChange = useCallback((newStatus) => {
    setStatus(newStatus);
    if (newStatus === 'disconnected') {
      setConnection(null);
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    setConnection(null);
    setStatus('disconnected');
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <h1>juni-cli</h1>
        </div>
        <div className="status-bar">
          <span className={`status-dot ${status}`} />
          <span className="status-text">{status}</span>
        </div>
      </header>

      <main className="app-main">
        {!connection ? (
          <ConnectionForm onConnect={handleConnect} />
        ) : (
          <Terminal
            connection={connection}
            onStatusChange={handleStatusChange}
            onDisconnect={handleDisconnect}
          />
        )}
      </main>
    </div>
  );
}

export default App;
