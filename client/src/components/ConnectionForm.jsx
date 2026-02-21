import { useState } from 'react';

export default function ConnectionForm({ onConnect }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!host || !username) return;
    onConnect({ host, port: Number(port), username, password });
  };

  return (
    <div className="connection-form-wrapper">
      <form className="connection-form" onSubmit={handleSubmit}>
        <div className="form-header">
          <span className="form-icon">🔐</span>
          <h2>SSH Connection</h2>
          <p className="form-subtitle">Connect to a remote server</p>
        </div>

        <div className="form-grid">
          <div className="form-group host-group">
            <label htmlFor="host">Host</label>
            <input
              id="host"
              type="text"
              placeholder="192.168.1.1 or hostname"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="form-group port-group">
            <label htmlFor="port">Port</label>
            <input
              id="port"
              type="number"
              placeholder="22"
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
              placeholder="root"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
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
        </div>

        <button type="submit" className="connect-btn">
          <span className="btn-icon">→</span>
          Connect
        </button>
      </form>
    </div>
  );
}
