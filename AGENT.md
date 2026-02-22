# Agent Mode — Architecture & Implementation

juni-cli includes an **agentic mode** that allows Gemini to autonomously execute commands on your SSH terminal. When enabled, Gemini acts as a system administrator agent — it receives a task, breaks it into steps, runs commands, reads their output, and iterates until the task is complete.

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (React)                                                 │
│                                                                  │
│  ┌─────────────┐       ┌──────────────┐       ┌──────────────┐  │
│  │  App.jsx     │──────▶│ GeminiChat   │◀─────▶│  Terminal     │  │
│  │  (wiring)    │       │ (agent loop) │       │  (SSH + PTY)  │  │
│  └─────────────┘       └──────┬───────┘       └──────┬───────┘  │
│                               │                       │          │
└───────────────────────────────┼───────────────────────┼──────────┘
                                │ HTTP POST             │ Socket.io
                                ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Server (Express)                                                │
│                                                                  │
│  /api/gemini/agent ──▶ Vertex AI (Function Calling)              │
│  Socket.io handler  ──▶ SSH connection (ssh2)                    │
└──────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. User Activates Agent Mode

The user clicks the **⚡ Agent** toggle in the header bar. This sets `agentMode=true` in `App.jsx`, which is passed as a prop to all `GeminiChat` instances.

### 2. User Sends a Task

The user types a request like *"Check disk usage and clean up /tmp if over 50%"* and presses Enter. Because `agentMode` is true, `GeminiChat.handleSend()` calls `startAgentLoop(text)` instead of the regular `callGemini()` chat API.

### 3. The Agent Loop

`startAgentLoop` orchestrates a multi-turn conversation with Gemini using **function calling**. The loop runs up to 20 iterations:

```
User message ──▶ Gemini API ──▶ Response
                                  │
                    ┌─────────────┼─────────────┬─────────────┐
                    ▼             ▼              ▼             ▼
              run_command    send_keys     task_complete    plain text
              (execute it)  (send keys)    (stop loop)     (stop loop)
                    │             │
                    ▼             ▼
              Execute on     Send keystrokes
              terminal       to terminal
              Capture output Capture snapshot
              Send output    Send output
              back to        back to
              Gemini         Gemini
                    │             │
                    └──────┬──────┘
                           ▼
                     Gemini API (next iteration) ──▶ ...
```

Each iteration:

1. **Calls `/api/gemini/agent`** with the full conversation history and an `AbortSignal`
2. **Parses the response** for function calls:
   - `run_command` → execute the command, capture output, continue loop
   - `send_keys` → send keystrokes to terminal, capture brief snapshot, continue loop
   - `task_complete` → show summary, stop loop
   - Plain text → display it, stop loop
3. **Updates the UI** with each step (reasoning, command/keys, output)

### 4. Command Execution via Sentinel (`run_command`)

When Gemini returns a `run_command` function call, the agent loop calls `onRunAgentCommand(command)` which is wired to `Terminal.runAgentCommand()`.

The terminal uses a **sentinel-based output capture** strategy:

```
Actual command sent to SSH:
  $ apt install htop; echo __JUNI_AGENT_DONE__

Terminal watches the SSH output stream for the sentinel marker.
Everything received before the marker is captured as the command output.
```

This approach:
- Works with any shell (bash, zsh, sh)
- Handles multi-line output and ANSI escape codes
- Has a **60-second timeout** for long-running commands
- Strips ANSI escape sequences before returning the output

### 5. Keystroke Sending (`send_keys`)

When Gemini returns a `send_keys` function call, the agent loop calls `onSendAgentKeys(keys)` which is wired to `Terminal.sendAgentKeys()`.

Unlike `run_command`, this does **not** use a sentinel. Instead it:

1. **Parses the key string** — e.g. `"y Enter"` or `"Ctrl+C"` — by splitting on spaces
2. **Maps special key names** to terminal escape sequences (see table below)
3. **Sends the payload** directly to the SSH socket
4. **Captures ~3 seconds** of terminal output as a snapshot
5. **Returns the cleaned output** to the agent

**Supported special keys:**

| Key Name | Sequence | Key Name | Sequence |
|----------|----------|----------|----------|
| `Enter` / `Return` | `\r` | `Ctrl+C` | `\x03` |
| `Tab` | `\t` | `Ctrl+D` | `\x04` |
| `Escape` / `Esc` | `\x1b` | `Ctrl+Z` | `\x1a` |
| `Backspace` | `\x7f` | `Ctrl+L` | `\x0c` |
| `Delete` | `\x1b[3~` | `Ctrl+A` | `\x01` |
| `Up` / `Down` / `Left` / `Right` | Arrow escapes | `Ctrl+E` | `\x05` |
| `Home` / `End` | `\x1b[H` / `\x1b[F` | `Ctrl+K` | `\x0b` |
| `PageUp` / `PageDown` | `\x1b[5~` / `\x1b[6~` | `Ctrl+U` / `Ctrl+W` / `Ctrl+R` | Standard |
| `Space` | ` ` | | |

**When to use `send_keys` vs `run_command`:**

| Use case | Tool |
|----------|------|
| Standard shell commands | `run_command` |
| Responding to a prompt (y/n, password) | `send_keys` |
| Cancelling a stuck process | `send_keys` with `Ctrl+C` |
| Sending EOF | `send_keys` with `Ctrl+D` |
| Navigating a TUI application | `send_keys` |

### 6. Conversation History Format

The agent endpoint uses Vertex AI's native function calling format. The conversation history tracks the full multi-turn exchange:

```json
[
  { "role": "user", "parts": [{ "text": "Install htop" }] },
  { "role": "model", "parts": [{ "functionCall": { "name": "run_command", "args": { "command": "apt install -y htop", "reasoning": "Installing htop package" } } }] },
  { "role": "user", "parts": [{ "functionResponse": { "name": "run_command", "response": { "output": "Reading package lists...\nhtop is already the newest version." } } }] },
  { "role": "model", "parts": [{ "functionCall": { "name": "task_complete", "args": { "summary": "htop is already installed." } } }] }
]
```

## Agent Controls

### Pause / Resume

While the agent is running, a **⏸ Pause** button (amber) appears in the toolbar. Clicking it signals the agent loop to pause **between iterations** — the current step finishes, then the loop waits.

The pause mechanism uses a promise-based gate:
1. `pauseAgent()` sets `pausedResolverRef.current = 'pending'`
2. At the top of each iteration, the loop checks this value
3. If `'pending'`, it creates a `new Promise` and stores the resolver
4. The button toggles to **▶ Resume** (green, with a pulse glow)
5. A pulsing indicator appears: *"agent paused — click Resume to continue"*
6. `resumeAgent()` calls the resolver, unblocking the loop

### Stop (Instant Abort)

The **■ Stop** button performs a **three-pronged instant abort**:

1. **`AbortController.abort()`** — Cancels the in-flight `fetch` request to Vertex AI immediately. The `callGeminiAgent` function accepts an `AbortSignal`, so the HTTP request is terminated. The catch block distinguishes `AbortError` from real errors to show `[stopped]` instead of a false error message.

2. **`onAbortAgentCapture()`** → `Terminal.abortAgentCapture()` — Immediately resolves any pending `runAgentCommand` (clears the 60s timeout) or `sendAgentKeys` (clears the 3s timer) promise with whatever output has been captured so far.

3. **Pause resolver** — If paused, resolves the pause promise so the loop can exit.

After pressing Stop, the button enters a disabled "Stopping…" state with an inline spinner, then disappears once the loop fully terminates.

### Retry

After a task completes (or fails/is stopped), a **↻ Retry** button (blue) appears in the toolbar. It re-runs the last prompt from scratch with a fresh agent history.

### New Chat

The **✦+ New Chat** button fully resets the conversation context: clears messages, agent history, agent steps, command history, the last prompt ref, and removes persisted data from localStorage.

## API Reference

### `POST /api/gemini/agent`

The main agent endpoint. Accepts a conversation history and returns the model's next response (which may include function calls).

**Request:**

```json
{
  "model": "gemini-3-flash-preview",
  "history": [
    { "role": "user", "parts": [{ "text": "..." }] },
    { "role": "model", "parts": [{ "functionCall": { ... } }] },
    { "role": "user", "parts": [{ "functionResponse": { ... } }] }
  ],
  "project": "optional-gcp-project-id",
  "location": "optional-gcp-location"
}
```

**Response:**

```json
{
  "parts": [
    { "functionCall": { "name": "run_command", "args": { "command": "ls -la", "reasoning": "Listing directory" } } }
  ]
}
```

Or for text responses:

```json
{
  "parts": [
    { "text": "The directory contains 3 files." }
  ]
}
```

**Tool Declarations:**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `run_command` | `command` (string, required), `reasoning` (string, required) | Execute a shell command on the user's SSH terminal. Output is returned via sentinel-based capture. |
| `send_keys` | `keys` (string, required), `reasoning` (string, required) | Send raw keystrokes/text to the terminal. Supports special key names (`Enter`, `Ctrl+C`, etc.). Returns a ~3s snapshot of terminal output. |
| `task_complete` | `summary` (string, required) | Signal that the task is finished with a summary of what was accomplished. |

**Configuration:**
- Model temperature: `0.3` (lower than regular chat's `0.7` for deterministic behavior)
- Max output tokens: `4096`
- System prompt includes tool usage guidance and safety rules

### `POST /api/gemini/chat`

The regular (non-agent) chat endpoint. Simpler — no function calling.

**Request:**

```json
{
  "model": "gemini-3-flash-preview",
  "messages": [
    { "role": "user", "text": "How do I check disk usage?" },
    { "role": "model", "text": "Use <cmd>df -h</cmd> to..." }
  ]
}
```

**Response:**

```json
{
  "reply": "Use <cmd>df -h</cmd> to check disk usage..."
}
```

## File-by-File Breakdown

### `server/index.js` — Agent Endpoint

- **`AGENT_TOOLS`** — Array of function declarations (`run_command`, `send_keys`, `task_complete`) passed to Vertex AI
- **`AGENT_SYSTEM_PROMPT`** — Instructs Gemini to act as an expert sysadmin, prefer `run_command` over `send_keys`, avoid interactive commands, use non-interactive flags, and call `task_complete` when done
- **`/api/gemini/agent`** — POST endpoint that forwards the conversation history to Vertex AI with tools and returns the model's response parts

### `client/src/components/Terminal.jsx` — Output Capture

Methods exposed via `useImperativeHandle`:

| Method | Description |
|--------|-------------|
| `runAgentCommand(command)` | Sends `command; echo __JUNI_AGENT_DONE__\n` to SSH, captures output until sentinel is detected. Returns a Promise that resolves with cleaned output. 60s timeout. |
| `sendAgentKeys(keys)` | Parses key string, maps special names to escape sequences, sends to SSH, captures ~3s of output. Returns a Promise. |
| `abortAgentCapture()` | Immediately resolves any pending `runAgentCommand` or `sendAgentKeys` promise. Clears timeouts. Used by the Stop button for instant abort. |
| `writeToTerminal(text)` | Sends raw text to the SSH socket (used by the "Send to Terminal" feature). |
| `getBufferText()` | Reads the full terminal buffer content (used by "Send to Gemini"). |

### `client/src/components/GeminiChat.jsx` — Agent Loop Controller

**State:**
- `agentHistory` — Full Vertex AI conversation history (function calls + responses)
- `agentSteps` — UI step cards (type, command/keys, reasoning, output, status)
- `agentRunning` — Whether the loop is active
- `agentPaused` — Whether the loop is paused between iterations
- `agentStopping` — Whether stop has been pressed (shows spinner on button)
- `abortAgentRef` — Boolean flag checked each iteration
- `abortControllerRef` — `AbortController` for cancelling in-flight API requests
- `pausedResolverRef` — Promise resolver for the pause gate
- `lastAgentPromptRef` — Stores the last prompt for Retry

**Key functions:**
- `startAgentLoop(text)` — Entry point: builds history, creates `AbortController`, runs the for-loop
- `runAgentStep(history, signal)` — Single API call with abort signal, parses response type
- `executeAgentCommand(command, reasoning, history)` — Runs command via terminal, updates history
- `executeAgentSendKeys(keys, reasoning, history)` — Sends keys via terminal, updates history
- `stopAgent()` — Three-pronged abort: `AbortController.abort()` + `abortAgentCapture()` + resolve pause
- `pauseAgent()` / `resumeAgent()` — Promise-based pause gate
- `retryAgent()` — Re-runs last prompt with fresh history
- `handleNewChat()` — Full context reset including localStorage

### `client/src/App.jsx` — Wiring

Callbacks that bridge GeminiChat to Terminal:

| Callback | Prop Name | Terminal Method |
|----------|-----------|----------------|
| `handleRunAgentCommand` | `onRunAgentCommand` | `runAgentCommand()` |
| `handleSendAgentKeys` | `onSendAgentKeys` | `sendAgentKeys()` |
| `handleAbortAgentCapture` | `onAbortAgentCapture` | `abortAgentCapture()` |
| `handleRunCommand` | `onRunCommand` | `writeToTerminal()` |

## UI Elements

### Agent Toggle
The **⚡ Agent** button in the header toggles agent mode on/off. When active, it glows orange.

### Agent Badge
When agent mode is on, the Gemini toolbar shows an `AGENT` badge with a subtle pulse animation.

### Step Cards
Each agent step renders as a card in the Gemini console:

| Step Type | Border Color | Content |
|-----------|-------------|---------|
| `command` | Subtle white | Reasoning, green `> command`, scrollable output |
| `send_keys` | Blue tint | Reasoning, blue `⌨ keys`, output snapshot |
| `complete` | Green tint | `[complete]` + summary |
| `aborted` | Red tint | `[stopped] agent stopped by user.` |
| `error` | Red tint | `[error]` + error message |

### Prompt
The input prompt changes from `gemini:/>` to `agent:/>` when agent mode is active.

### Toolbar Controls (during agent run)

| Button | Color | When Visible | Action |
|--------|-------|-------------|--------|
| ⏸ Pause | Amber | Agent running, not paused | Pause between iterations |
| ▶ Resume | Green (pulsing) | Agent paused | Resume the loop |
| ■ Stop / Stopping… | Red | Agent running | Instant three-pronged abort |
| ↻ Retry | Blue | Agent idle, has last prompt | Re-run last task |
| ✦+ New Chat | Gray/Blue | Agent idle | Full context reset |
| ⌫ | Red | Always | Clear visible messages |

## Safety Considerations

1. **System prompt guardrails** — Gemini is instructed to never run destructive commands (rm -rf /, mkfs, etc.) without explicit user confirmation
2. **Iteration limit** — The loop stops after 20 iterations maximum
3. **Command timeout** — Individual commands time out after 60 seconds
4. **Instant stop** — User can abort at any time via three-pronged abort (API + terminal + pause)
5. **Visible execution** — All commands and their output are visible in both the terminal and the Gemini step cards
6. **No background execution** — Commands run through the real terminal, so the user sees everything happening in real time
7. **Non-interactive preference** — System prompt instructs Gemini to always prefer non-interactive flags (-y, DEBIAN_FRONTEND=noninteractive) and avoid interactive editors
8. **`send_keys` containment** — The system prompt instructs Gemini to prefer `run_command` over `send_keys` for standard commands, reserving `send_keys` for truly interactive situations
