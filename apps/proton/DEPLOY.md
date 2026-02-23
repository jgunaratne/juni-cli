# Building juni-cli-proton (macOS Desktop App)

> **Prerequisites:** macOS with Node.js 20+ installed.

## Development

```bash
cd ~/git/juni-cli

# Install all workspace dependencies
npm install

# Start in dev mode (Vite dev server + Electron)
cd apps/proton
npm run dev
```

This opens the Electron window pointing at `http://localhost:5173` with hot reload.

## Production Build

```bash
cd ~/git/juni-cli

# Install all workspace dependencies
npm install

# Build the distributable app (.dmg + .zip)
cd apps/proton
npm run build
```

Output goes to `apps/proton/release/`:
- `juni-cli-proton-1.0.0.dmg` — installer
- `juni-cli-proton-1.0.0-mac.zip` — portable zip

To build without creating installers (faster, for testing):

```bash
npm run pack
```

This produces `apps/proton/release/mac-arm64/juni-cli-proton.app` (or `mac/` on Intel).

## Environment

Create `apps/proton/.env` with your credentials:

```env
GCP_PROJECT_ID=your-gcp-project-id
GCP_LOCATION=us-central1
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

## Directory Structure

```
apps/proton/
├── main.js              ← Electron main process + embedded Express server
├── preload.js           ← IPC bridge to renderer
├── .env                 ← environment config
├── renderer/
│   ├── src/App.jsx      ← imports components from @juni/shared-ui
│   └── dist/            ← built by Vite (bundled into .app)
└── release/             ← electron-builder output (.dmg, .zip)
```
