# Deploying juni-cli to Ubuntu + Nginx

> **Architecture reminder**: The browser only sends keystrokes over WebSocket
> (socket.io). **All SSH connections are made entirely on the Express backend**
> using the `ssh2` library. The frontend never touches SSH directly.

---

## 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x
```

## 2. Clone & Install

```bash
cd /opt
sudo git clone https://github.com/YOUR_USER/juni-cli.git
sudo chown -R $USER:$USER /opt/juni-cli
cd /opt/juni-cli

# Install all dependencies
cd server && npm install --omit=dev && cd ..
cd client && npm install && cd ..
```

## 3. Build the Frontend

```bash
cd /opt/juni-cli/client
npm run build          # produces client/dist/
```

The `dist/` folder contains static HTML/CSS/JS that nginx will serve directly.

## 4. Run the Backend with PM2

```bash
sudo npm install -g pm2

# Start the Express server
cd /opt/juni-cli/server
CORS_ORIGIN=https://yourdomain.com pm2 start index.js --name juni-cli

# Save so it auto-starts on reboot
pm2 save
pm2 startup            # follow the printed command
```

Check it's running:

```bash
pm2 status
curl http://localhost:3001/api/health
```

## 5. Configure Nginx

Create `/etc/nginx/sites-available/juni-cli`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Serve the built React frontend
    root /opt/juni-cli/client/dist;
    index index.html;

    # SPA fallback — all non-file routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Reverse-proxy socket.io (WebSocket + polling)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        # WebSocket upgrade headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for real-time terminal data
        proxy_buffering off;
        proxy_cache off;

        # Long timeout for persistent SSH sessions
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Reverse-proxy API routes
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and reload:

```bash
sudo ln -s /etc/nginx/sites-available/juni-cli /etc/nginx/sites-enabled/
sudo nginx -t          # check config syntax
sudo systemctl reload nginx
```

## 6. Enable HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Certbot will auto-configure the SSL redirect. After this, update PM2:

```bash
cd /opt/juni-cli/server
pm2 delete juni-cli
CORS_ORIGIN=https://yourdomain.com pm2 start index.js --name juni-cli
pm2 save
```

## 7. Firewall

```bash
sudo ufw allow 'Nginx Full'    # ports 80 + 443
sudo ufw allow OpenSSH         # don't lock yourself out
sudo ufw enable
```

---

## Updating

```bash
cd /opt/juni-cli
git pull
cd client && npm install && npm run build && cd ..
cd server && npm install --omit=dev && cd ..
pm2 restart juni-cli
```

## Environment Variables

| Variable | Where | Default | Example |
|---|---|---|---|
| `PORT` | Server | `3001` | `3001` |
| `CORS_ORIGIN` | Server | localhost origins | `https://yourdomain.com` |
| `VITE_SERVER_URL` | Client build-time | `window.location.origin` | only needed for split-domain setups |
