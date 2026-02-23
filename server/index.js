require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('ssh2');
const { VertexAI } = require('@google-cloud/vertexai');

/* ── Config ────────────────────────────────────────────────── */

const DEFAULT_PROJECT = process.env.GCP_PROJECT_ID || '';
const DEFAULT_LOCATION = process.env.GCP_LOCATION || 'us-central1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Models that should use the Generative Language API (Google AI) instead of Vertex AI
const GENAI_MODELS = ['gemini-3-flash-preview'];

/* ── Vertex AI Client Cache ────────────────────────────────── */

const clientCache = new Map();

function getVertexClient(project, location) {
  const key = `${project}::${location}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new VertexAI({ project, location }));
  }
  return clientCache.get(key);
}

/* ── Generative Language API (Google AI) Helper ───────────── */

async function callGenAI(model, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Google AI API error: HTTP ${res.status}`);
  }

  return res.json();
}

function convertSchemaToGenAI(schema) {
  if (!schema) return schema;
  const result = { ...schema };
  if (result.type) {
    result.type = result.type.toLowerCase();
  }
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, val]) => [key, convertSchemaToGenAI(val)])
    );
  }
  if (result.items) {
    result.items = convertSchemaToGenAI(result.items);
  }
  return result;
}

/* ── Express + Socket.io ───────────────────────────────────── */

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ── Health Check ──────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    project: DEFAULT_PROJECT || '(not set)',
    location: DEFAULT_LOCATION,
  });
});

/* ── Gemini Chat Endpoint ──────────────────────────────────── */

app.post('/api/gemini/chat', async (req, res) => {
  try {
    const {
      model = 'gemini-3-flash-preview',
      messages = [],
      project,
      location,
    } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const contents = messages.map((m) => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    let text;

    if (GENAI_MODELS.includes(model)) {
      // Use Generative Language API (Google AI)
      if (!GEMINI_API_KEY) {
        return res.status(400).json({
          error: 'GEMINI_API_KEY is required for this model. Set it in server/.env.',
        });
      }

      const data = await callGenAI(model, {
        contents,
        systemInstruction: {
          parts: [{ text: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.' }],
        },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
        },
      });

      text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
    } else {
    // Use Vertex AI
      const resolvedProject = project || DEFAULT_PROJECT;
      const resolvedLocation = location || DEFAULT_LOCATION;

      if (!resolvedProject) {
        return res.status(400).json({
          error: 'GCP project ID is required. Set GCP_PROJECT_ID in server/.env.',
        });
      }

      const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
      const generativeModel = vertexAI.getGenerativeModel({
        model,
        systemInstruction: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
        },
      });

      const result = await generativeModel.generateContent({ contents });
      text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
    }

    res.json({ reply: text });
  } catch (err) {
    console.error('[gemini] Chat error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/* ── Gemini Agent Endpoint (Function Calling) ─────────────── */

const AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'run_command',
        description:
          'Execute a shell command on the user\'s remote SSH terminal. ' +
          'Use this to run any Linux/macOS command. The output of the command will be returned to you. ' +
          'Run one command at a time. For multi-step tasks, run commands sequentially and inspect output between each.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: {
              type: 'STRING',
              description: 'The shell command to execute',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you are running this command',
            },
          },
          required: ['command', 'reasoning'],
        },
      },
      {
        name: 'send_keys',
        description:
          'Send raw keystrokes or text directly to the terminal. ' +
          'Use this to interact with interactive programs, respond to prompts (y/n, passwords, etc.), ' +
          'send control sequences (Ctrl+C to cancel, Ctrl+D for EOF), or type text into running programs. ' +
          'Unlike run_command, this does NOT wait for a command to complete — it just sends the keystrokes and captures a brief snapshot of what appears. ' +
          'Special key names you can use in the keys field: Enter, Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Tab, Escape, Up, Down, Left, Right, Backspace, Delete.',
        parameters: {
          type: 'OBJECT',
          properties: {
            keys: {
              type: 'STRING',
              description:
                'The text or keystrokes to send. For regular text, just type it. ' +
                'For special keys, use names like "Enter", "Ctrl+C", "Tab". ' +
                'You can combine text and special keys by separating with a space, e.g. "y Enter" to type y then press Enter. ' +
                'To send just Enter (newline), use "Enter". To send Ctrl+C, use "Ctrl+C".',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you are sending these keystrokes',
            },
          },
          required: ['keys', 'reasoning'],
        },
      },
      {
        name: 'task_complete',
        description:
          'Signal that the task is finished. Call this when you have completed the user\'s request or determined it cannot be completed.',
        parameters: {
          type: 'OBJECT',
          properties: {
            summary: {
              type: 'STRING',
              description: 'A concise summary of what was accomplished',
            },
          },
          required: ['summary'],
        },
      },
      {
        name: 'ask_user',
        description:
          'Ask the user a clarifying question and wait for their response. ' +
          'Use this when you need more information before proceeding, when there are multiple valid approaches and you want the user to choose, ' +
          'or before performing a potentially destructive action that requires explicit confirmation.',
        parameters: {
          type: 'OBJECT',
          properties: {
            question: {
              type: 'STRING',
              description: 'The question to ask the user',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you need to ask this question',
            },
          },
          required: ['question', 'reasoning'],
        },
      },
      {
        name: 'read_terminal',
        description:
          'Read the current content visible in the terminal buffer without running any command. ' +
          'Use this to inspect the terminal state after sending keys, check on a long-running process, ' +
          'or see what is currently displayed. Returns the full terminal buffer text.',
        parameters: {
          type: 'OBJECT',
          properties: {
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you need to read the terminal',
            },
          },
          required: ['reasoning'],
        },
      },
    ],
  },
];

const AGENT_SYSTEM_PROMPT =
  'You are an expert Linux/macOS system administrator agent with full access to the user\'s terminal via SSH. ' +
  'When the user asks you to do something, use the run_command tool to execute commands on their terminal. ' +
  'Inspect the output of each command before deciding the next step. ' +
  'Break complex tasks into small, sequential steps. ' +
  'If a command fails, analyze the error and try to fix it. ' +
  'When the task is complete, call task_complete with a summary. ' +
  'If the user asks a question that does not require running commands, respond with plain text. ' +
  '\n\nTOOLS:\n' +
  '- run_command: Execute a shell command and get its full output. Best for non-interactive commands. ' +
  'Always prefer this for standard commands.\n' +
  '- send_keys: Send raw keystrokes/text to the terminal. Use this when you need to:\n' +
  '  * Respond to an interactive prompt (e.g. type "y" and press Enter)\n' +
  '  * Send Ctrl+C to cancel a stuck or long-running process\n' +
  '  * Send Ctrl+D for EOF\n' +
  '  * Interact with a running program that expects input\n' +
  '  * Type text into a TUI or interactive application\n' +
  'Note: send_keys only captures a brief snapshot of terminal output (~3 seconds), not strict command-completion output.\n' +
  '- ask_user: Ask the user a clarifying question and wait for their text response. Use when you need clarification, ' +
  'when there are multiple valid approaches, or before destructive actions.\n' +
  '- read_terminal: Read the current terminal buffer content without running a command. Use to inspect terminal state, ' +
  'check on long-running processes, or see what is displayed after sending keys.\n' +
  '\n\nCRITICAL RULES:\n' +
  '1. Prefer run_command over send_keys for standard commands — send_keys is for interactive situations only. ' +
  '2. NEVER run interactive commands that wait for user input via run_command (vim, nano, vi, less, more, top, htop, python, node, ssh, mysql, psql, irb, etc). ' +
  'If you must interact with such programs, prefer non-interactive alternatives. If absolutely necessary, use send_keys. ' +
  '3. Always use non-interactive flags: use -y for apt/yum/dnf, use DEBIAN_FRONTEND=noninteractive, use -f for commands that prompt. ' +
  '4. For file editing, use echo/printf/cat with heredocs or sed/awk — NEVER use text editors. ' +
  '5. For writing multi-line files, use: cat > filename << \'EOF\'\n...content...\nEOF ' +
  '6. When running scripts, ensure they are non-interactive (no read commands, no prompts). ' +
  '7. If a command might produce paged output, pipe through cat (e.g. git log | cat, man cmd | cat). ' +
  '8. Never run destructive commands (rm -rf /, mkfs, etc.) without the user explicitly confirming. ' +
  '9. Keep individual commands short and focused. Avoid long command chains. ' +
  '10. If you need to check if a program is installed, use "which" or "command -v", not the program itself. ' +
  '11. If a run_command times out or reports "waiting for input", use send_keys with Ctrl+C to cancel it, then try a different approach.';

app.post('/api/gemini/agent', async (req, res) => {
  try {
    const {
      model = 'gemini-3-flash-preview',
      history = [],
      project,
      location,
    } = req.body;

    // Build contents from history
    // Each entry is { role: 'user'|'model', parts: [...] }
    // Parts can be: { text }, { functionCall: { name, args } }, { functionResponse: { name, response } }
    const contents = history.map((entry) => ({
      role: entry.role,
      parts: entry.parts,
    }));

    if (contents.length === 0) {
      return res.status(400).json({ error: 'history is required' });
    }

    let parts;

    if (GENAI_MODELS.includes(model)) {
      // Use Generative Language API (Google AI)
      if (!GEMINI_API_KEY) {
        return res.status(400).json({
          error: 'GEMINI_API_KEY is required for this model. Set it in server/.env.',
        });
      }

      // Convert tool format: Vertex AI uses TYPE in caps, Google AI uses lowercase
      const genaiTools = AGENT_TOOLS.map((toolGroup) => ({
        functionDeclarations: toolGroup.functionDeclarations.map((fn) => ({
          ...fn,
          parameters: fn.parameters ? convertSchemaToGenAI(fn.parameters) : undefined,
        })),
      }));

      const data = await callGenAI(model, {
        contents,
        systemInstruction: {
          parts: [{ text: AGENT_SYSTEM_PROMPT }],
        },
        tools: genaiTools,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      });

      const candidate = data?.candidates?.[0];
      parts = candidate?.content?.parts ?? [{ text: 'No response generated.' }];
    } else {
      // Use Vertex AI
      const resolvedProject = project || DEFAULT_PROJECT;
      const resolvedLocation = location || DEFAULT_LOCATION;

      if (!resolvedProject) {
        return res.status(400).json({
          error: 'GCP project ID is required. Set GCP_PROJECT_ID in server/.env.',
        });
      }

      const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
      const generativeModel = vertexAI.getGenerativeModel({
        model,
        systemInstruction: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      });

      const result = await generativeModel.generateContent({ contents });
      const response = result.response;
      const candidate = response?.candidates?.[0];
      parts = candidate?.content?.parts ?? [{ text: 'No response generated.' }];
    }

    res.json({ parts });
  } catch (err) {
    console.error('[gemini-agent] Error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/* ── Claude Chat Endpoint ──────────────────────────────────── */

app.post('/api/claude/chat', async (req, res) => {
  try {
    const {
      model = 'claude-sonnet-4-20250514',
      messages = [],
      apiKey,
    } = req.body;

    const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY;

    if (!resolvedKey) {
      return res.status(400).json({
        error: 'Anthropic API key is required. Add it in Settings or set ANTHROPIC_API_KEY in server/.env.',
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: resolvedKey });

    const anthropicMessages = messages.map((m) => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.text,
    }));

    const result = await client.messages.create({
      model,
      max_tokens: 4096,
      system: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
      messages: anthropicMessages,
    });

    const text = result.content?.[0]?.text ?? 'No response generated.';
    res.json({ reply: text });
  } catch (err) {
    console.error('[claude] Chat error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/* ── Socket.io connection handler ──────────────────────────── */

io.on('connection', (socket) => {
  console.log(`[socket] client connected  id=${socket.id}`);

  let sshClient = null;
  let sshStream = null;
  let pendingSize = { rows: 24, cols: 80 };

  // ── ssh:connect ──────────────────────────────────────────────
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

        // SSH → Browser
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

    // Build connection config
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

    // Handle keyboard-interactive auth (used by many SSH servers)
    sshClient.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
      finish([password || '']);
    });

    sshClient.connect(connectConfig);
  });

  // ── ssh:data  (Browser → SSH) ───────────────────────────────
  socket.on('ssh:data', (data) => {
    if (sshStream) sshStream.write(data);
  });

  // ── ssh:resize ───────────────────────────────────────────────
  socket.on('ssh:resize', ({ cols, rows }) => {
    pendingSize = { rows, cols };
    if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
  });

  // ── disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[socket] client disconnected  id=${socket.id}`);
    if (sshStream) sshStream.end();
    if (sshClient) sshClient.end();
  });
});


/* ── Start ──────────────────────────────────────────────────── */

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✦  juni-cli server running on http://localhost:${PORT}`);
  console.log(`   GCP Project: ${DEFAULT_PROJECT || '(not set — set GCP_PROJECT_ID in .env)'}`);
  console.log(`   GCP Location: ${DEFAULT_LOCATION}`);
});
