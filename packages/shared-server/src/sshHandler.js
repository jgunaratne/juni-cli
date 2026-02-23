const { Client } = require('ssh2');

function setupSshHandler(io) {
  io.on('connection', (socket) => {
    console.log(`[socket] client connected  id=${socket.id}`);

    let sshClient = null;
    let sshStream = null;
    let pendingSize = { rows: 24, cols: 80 };

    socket.on('ssh:connect', (credentials) => {
      const { host, port = 22, username, password, privateKey } = credentials;

      console.log(`[ssh] connecting to ${username}@${host}:${port}`);
      sshClient = new Client();

      sshClient.on('ready', () => {
        console.log(`[ssh] authenticated  ${username}@${host}`);
        socket.emit('ssh:status', { status: 'authenticated' });

        sshClient.shell(
          { term: 'xterm-256color', rows: pendingSize.rows, cols: pendingSize.cols },
          (err, stream) => {
            if (err) {
              socket.emit('ssh:error', { message: err.message });
              return;
            }

            sshStream = stream;
            socket.emit('ssh:status', { status: 'ready' });

            stream.on('data', (data) => {
              socket.emit('ssh:output', data.toString('utf-8'));
            });

            stream.stderr.on('data', (data) => {
              socket.emit('ssh:output', data.toString('utf-8'));
            });

            stream.on('close', () => {
              console.log(`[ssh] shell closed  ${username}@${host}`);
              socket.emit('ssh:status', { status: 'disconnected' });
              if (sshClient) sshClient.end();
            });
          });
      });

      sshClient.on('error', (err) => {
        console.error(`[ssh] error: ${err.message}`);
        socket.emit('ssh:error', { message: err.message });
      });

      sshClient.on('close', () => {
        console.log('[ssh] connection closed');
        socket.emit('ssh:status', { status: 'disconnected' });
        sshClient = null;
        sshStream = null;
      });

      const connectConfig = {
        host,
        port: Number(port),
        username,
        tryKeyboard: true,
        readyTimeout: 10000,
      };
      if (privateKey) {
        connectConfig.privateKey = privateKey;
      } else if (password) {
        connectConfig.password = password;
      }

      sshClient.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        finish([password || '']);
      });

      sshClient.connect(connectConfig);
    });

    socket.on('ssh:data', (data) => {
      if (sshStream) sshStream.write(data);
    });

    socket.on('ssh:resize', ({ cols, rows }) => {
      pendingSize = { rows, cols };
      if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
    });

    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected  id=${socket.id}`);
      if (sshStream) sshStream.end();
      if (sshClient) sshClient.end();
    });
  });
}

module.exports = { setupSshHandler };
