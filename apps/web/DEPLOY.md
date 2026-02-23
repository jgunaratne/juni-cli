# Deploying juni-cli to Ubuntu + Nginx

> **Architecture**: The browser sends keystrokes over WebSocket (socket.io).
> **All SSH connections are made on the Express backend** using the `ssh2` library.
> The frontend never touches SSH directly.

---

## 1. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v20.x or higher
```

## 2. Clone & Install

juni-cli is a **monorepo** with npm workspaces. You must install from the **repo root**.

```bash
cd /home/$USER
git clone https://github.com/YOUR_USER/juni-cli.git
cd juni-cli

# Install ALL workspace dependencies (shared packages + apps)
npm install
```

> **Important:** Always run `npm install` from the repo root — never from individual
> subdirectories. Workspaces resolve `@juni/shared-server` and `@juni/shared-ui`.

## 3. Configure Environment

Create or edit `apps/web/server/.env`:

```bash
nano apps/web/server/.env
```

```env
GCP_PROJECT_ID=your-gcp-project-id
GCP_LOCATION=us-central1
PORT=3001
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...

# (Optional) only needed if NOT using ADC:
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Authentication (Vertex AI)

The Vertex AI SDK uses **Application Default Credentials (ADC)** — no `.json` key file is required.

| Environment | How it works |
|---|---|
| **Local dev** | Run `gcloud auth application-default login` once. Credentials are cached at `~/.config/gcloud/application_default_credentials.json`. |
| **On GCP** (Cloud Run, GCE, GKE) | Uses the attached service account via the metadata server automatically — zero files needed. |
| **Explicit key file** | Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` in `.env` to override ADC. |

## 4. Build the Frontend

```bash
cd apps/web/client
npx vite build          # produces apps/web/client/dist/
```

## 5. Run the Backend with PM2

```bash
sudo npm install -g pm2

# Start from the REPO ROOT so workspace modules resolve correctly
cd ~/juni-cli
pm2 start apps/web/server/index.js --name juni-cli

# Save so it auto-starts on reboot
pm2 save
pm2 startup            # follow the printed command
```

Verify:

```bash
pm2 status
curl http://localhost:3001/api/health
```

## 6. Configure Nginx

Create `/etc/nginx/sites-available/juni-cli`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Serve the built React frontend directly from the build output
    root /home/YOUR_USER/juni-cli/apps/web/client/dist;
    index index.html;

    location = /favicon.ico {
        log_not_found off;
        access_log off;
        return 204;
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Reverse-proxy socket.io (WebSocket + polling)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
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

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/juni-cli /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7. Enable HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

## 8. Firewall

```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw enable
```

---

## Updating

```bash
cd ~/juni-cli
git pull
npm install                          # update workspace deps
cd apps/web/client && npx vite build # rebuild frontend
cd ~/juni-cli
pm2 restart juni-cli                 # restart backend
```

## Directory Structure

```
juni-cli/
├── package.json                     ← workspace root (npm install here)
├── packages/
│   ├── shared-server/               ← @juni/shared-server (Gemini/Claude routes, SSH, agent tools)
│   └── shared-ui/                   ← @juni/shared-ui (React components, xterm)
├── apps/
│   ├── web/
│   │   ├── server/index.js          ← Express backend (pm2 runs this)
│   │   ├── server/.env              ← environment config
│   │   └── client/dist/             ← built frontend (nginx serves this)
│   └── proton/                      ← Electron desktop app (not deployed here)
```

## Environment Variables

| Variable | Location | Default | Notes |
|---|---|---|---|
| `GCP_PROJECT_ID` | `server/.env` | — | Required for Vertex AI |
| `GCP_LOCATION` | `server/.env` | `us-central1` | GCP region |
| `GOOGLE_APPLICATION_CREDENTIALS` | `server/.env` | — | Optional — override ADC with explicit key file |
| `PORT` | `server/.env` | `3001` | Express listen port |
| `ANTHROPIC_API_KEY` | `server/.env` | — | For Claude chat |
| `GEMINI_API_KEY` | `server/.env` | — | For Gemini 3 Flash (Google AI direct) |
| `CORS_ORIGIN` | `server/.env` | `localhost:5173` | Comma-separated allowed origins |
