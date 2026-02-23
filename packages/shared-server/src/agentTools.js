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

module.exports = { AGENT_TOOLS, AGENT_SYSTEM_PROMPT };
