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
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
              run_command    task_complete    plain text
              (execute it)   (stop loop)     (stop loop)
                    │
                    ▼
              Execute on terminal
              Capture output
              Send output back to Gemini
                    │
                    ▼
              Gemini API (next iteration) ──▶ ...
```

Each iteration:

1. **Calls `/api/gemini/agent`** with the full conversation history
2. **Parses the response** for function calls:
   - `run_command` → execute the command, capture output, continue loop
   - `task_complete` → show summary, stop loop
   - Plain text → display it, stop loop
3. **Updates the UI** with each step (reasoning, command, output)

### 4. Command Execution via Sentinel

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
- Has a 30-second timeout for long-running commands
- Strips ANSI escape sequences before returning the output

### 5. Conversation History Format

The agent endpoint uses Vertex AI's native function calling format. The conversation history tracks the full multi-turn exchange:

```json
[
  { "role": "user", "parts": [{ "text": "Install htop" }] },
  { "role": "model", "parts": [{ "functionCall": { "name": "run_command", "args": { "command": "apt install -y htop", "reasoning": "Installing htop package" } } }] },
  { "role": "user", "parts": [{ "functionResponse": { "name": "run_command", "response": { "output": "Reading package lists...\nhtop is already the newest version." } } }] },
  { "role": "model", "parts": [{ "functionCall": { "name": "task_complete", "args": { "summary": "htop is already installed." } } }] }
]
```

## File-by-File Breakdown

### `server/index.js` — `/api/gemini/agent` Endpoint

**Tool definitions** passed to Vertex AI:

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `run_command` | `command` (string), `reasoning` (string) | Execute a shell command on the terminal |
| `task_complete` | `summary` (string) | Signal the task is finished |

**System prompt** instructs Gemini to:
- Act as an expert Linux/macOS system administrator
- Break complex tasks into small sequential steps
- Inspect output between each command
- Never run destructive commands without confirmation
- Call `task_complete` when done

**Configuration**: temperature is set to `0.3` (lower than the regular chat's `0.7`) for more deterministic, predictable agent behavior.

### `client/src/components/Terminal.jsx` — Output Capture

The `runAgentCommand(command)` method exposed via `useImperativeHandle`:

1. Returns a **Promise** that resolves with the command output
2. Sets up a capture buffer in `agentCaptureRef`
3. Sends `command; echo __JUNI_AGENT_DONE__\n` to the SSH socket
4. The `ssh:output` handler appends incoming data to the buffer
5. When the sentinel is detected in the buffer:
   - Extracts text before the sentinel
   - Strips ANSI escape codes
   - Resolves the promise with the clean output
6. Times out after **30 seconds** if the sentinel never appears

### `client/src/components/GeminiChat.jsx` — Agent Loop Controller

Key state:
- `agentHistory` — Full Vertex AI conversation history (with function calls/responses)
- `agentSteps` — UI representation of each step (for rendering step cards)
- `agentRunning` — Whether the loop is active
- `abortAgentRef` — Flag checked each iteration (set by the Stop button)

Key functions:
- `startAgentLoop(text)` — Entry point, builds initial history, runs the loop
- `runAgentStep(history)` — Single API call, parses the response type
- `executeAgentCommand(command, reasoning, history)` — Runs a command via the terminal, updates history with function call + response
- `stopAgent()` — Sets the abort flag to break the loop

### `client/src/App.jsx` — Wiring

- `agentMode` state + toggle button
- `handleRunAgentCommand` callback — finds the active SSH terminal and calls `runAgentCommand` on it
- Both props passed to all `GeminiChat` instances (tabs and split panel)

## UI Elements

### Agent Toggle
The **⚡ Agent** button in the header toggles agent mode on/off. When active, it glows orange.

### Agent Badge
When agent mode is on, the Gemini toolbar shows an `AGENT` badge with a subtle pulse animation.

### Step Cards
Each agent step renders as a card in the Gemini console:

- **Command steps** (orange border): Show reasoning (italic), command (green `$ prefix`), and output (scrollable, max 200px height, truncated at 2000 chars)
- **Complete steps** (green border): Show the `✦` icon and summary
- **Aborted steps** (red border): Show when the user clicked Stop
- **Error steps** (red border): Show API or execution errors

### Prompt
The input prompt changes from `gemini:/>` to `agent:/>` when agent mode is active.

### Stop Button
A red **■ Stop** button appears in the toolbar while the agent is running, allowing the user to abort the loop at any time.

## Safety Considerations

1. **System prompt guardrails** — Gemini is instructed to never run destructive commands (rm -rf /, mkfs, etc.) without explicit user confirmation
2. **Iteration limit** — The loop stops after 20 iterations maximum
3. **Timeout** — Individual commands time out after 30 seconds
4. **Stop button** — User can abort at any time
5. **Visible execution** — All commands and their output are visible in both the terminal and the Gemini step cards
6. **No background execution** — Commands run through the real terminal, so the user sees everything happening in real time
