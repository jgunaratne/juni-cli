/**
 * VNC Agent Tools — Gemini function declarations for desktop control via VNC.
 *
 * The agent sees screenshots and can perform mouse/keyboard actions using
 * normalized (0-1) coordinates, mirroring the mousecontrol project's approach.
 */

const VNC_AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'click',
        description:
          'Click at a position on the remote desktop. Coordinates are normalized (0-1) ' +
          'relative to the screen size. (0,0) is the top-left corner, (1,1) is the bottom-right.',
        parameters: {
          type: 'OBJECT',
          properties: {
            normalizedX: {
              type: 'NUMBER',
              description: 'Horizontal position (0-1), where 0 is left edge and 1 is right edge',
            },
            normalizedY: {
              type: 'NUMBER',
              description: 'Vertical position (0-1), where 0 is top edge and 1 is bottom edge',
            },
            button: {
              type: 'STRING',
              description: 'Mouse button to click: "left", "middle", or "right". Defaults to "left".',
            },
            clickCount: {
              type: 'NUMBER',
              description: 'Number of clicks (1 for single, 2 for double). Defaults to 1.',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of what you are clicking and why',
            },
          },
          required: ['normalizedX', 'normalizedY', 'reasoning'],
        },
      },
      {
        name: 'type_text',
        description:
          'Type a string of text on the remote desktop. The text will be typed character by character. ' +
          'Use this for entering text into fields, search bars, terminals, etc.',
        parameters: {
          type: 'OBJECT',
          properties: {
            text: {
              type: 'STRING',
              description: 'The text string to type',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of what you are typing and why',
            },
          },
          required: ['text', 'reasoning'],
        },
      },
      {
        name: 'key_combo',
        description:
          'Send a keyboard shortcut or special key combination. ' +
          'Examples: ["ctrl", "c"] for copy, ["alt", "F4"] to close window, ["enter"] to press Enter.',
        parameters: {
          type: 'OBJECT',
          properties: {
            keys: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description:
                'Array of key names to press simultaneously. ' +
                'Modifier keys: "ctrl", "alt", "shift", "super"/"meta". ' +
                'Special keys: "enter", "tab", "escape", "backspace", "delete", "space", ' +
                '"up", "down", "left", "right", "home", "end", "pageup", "pagedown", ' +
                '"f1"-"f12". For regular characters, use the character itself (e.g. "a", "1").',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of what this key combination does',
            },
          },
          required: ['keys', 'reasoning'],
        },
      },
      {
        name: 'scroll',
        description:
          'Scroll at a position on the remote desktop. Use positive dy for scrolling down, negative for up.',
        parameters: {
          type: 'OBJECT',
          properties: {
            normalizedX: {
              type: 'NUMBER',
              description: 'Horizontal position (0-1) to scroll at',
            },
            normalizedY: {
              type: 'NUMBER',
              description: 'Vertical position (0-1) to scroll at',
            },
            dy: {
              type: 'NUMBER',
              description: 'Scroll amount. Positive = scroll down, negative = scroll up. Typically 3-5 for a page.',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you are scrolling',
            },
          },
          required: ['normalizedX', 'normalizedY', 'dy', 'reasoning'],
        },
      },
      {
        name: 'mouse_move',
        description:
          'Move the mouse cursor to a position without clicking. ' +
          'Useful for hovering to reveal tooltips or menus.',
        parameters: {
          type: 'OBJECT',
          properties: {
            normalizedX: {
              type: 'NUMBER',
              description: 'Horizontal position (0-1)',
            },
            normalizedY: {
              type: 'NUMBER',
              description: 'Vertical position (0-1)',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you are moving the mouse',
            },
          },
          required: ['normalizedX', 'normalizedY', 'reasoning'],
        },
      },
      {
        name: 'wait',
        description:
          'Wait a specified number of seconds before taking the next screenshot. ' +
          'Use this when an action needs time to take effect (e.g. page loading, animation completing).',
        parameters: {
          type: 'OBJECT',
          properties: {
            seconds: {
              type: 'NUMBER',
              description: 'Number of seconds to wait (1-10)',
            },
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you are waiting',
            },
          },
          required: ['seconds', 'reasoning'],
        },
      },
      {
        name: 'take_screenshot',
        description:
          'Take a fresh screenshot of the current screen state without performing any action. ' +
          'Use this to check the result of a previous action or inspect the current state.',
        parameters: {
          type: 'OBJECT',
          properties: {
            reasoning: {
              type: 'STRING',
              description: 'Brief explanation of why you need a new screenshot',
            },
          },
          required: ['reasoning'],
        },
      },
      {
        name: 'task_complete',
        description:
          'Signal that the task is finished. Call this when you have completed the user\'s request ' +
          'or determined it cannot be completed.',
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
          'Use when you need more information or are unsure what to do.',
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
    ],
  },
];

const VNC_AGENT_SYSTEM_PROMPT =
  'You are a desktop automation agent that can see and control a remote computer via VNC. ' +
  'You receive screenshots of the remote desktop and can perform mouse and keyboard actions. ' +
  'Your goal is to help the user accomplish tasks on the remote desktop.\n\n' +
  'WORKFLOW:\n' +
  '1. You will receive a screenshot of the current desktop state along with the user\'s task\n' +
  '2. Analyze the screenshot to understand what is on screen\n' +
  '3. Decide on the next action to take\n' +
  '4. Execute ONE action at a time\n' +
  '5. After each action, you will receive a new screenshot showing the result\n' +
  '6. Repeat until the task is complete\n\n' +
  'COORDINATE SYSTEM:\n' +
  '- All coordinates are normalized (0-1), relative to the screen dimensions\n' +
  '- (0, 0) = top-left corner, (1, 1) = bottom-right corner\n' +
  '- (0.5, 0.5) = center of the screen\n' +
  '- Be precise with coordinates — look at the screenshot carefully to target the correct UI element\n\n' +
  'TOOLS:\n' +
  '- click: Click at a screen position (left/right/double-click)\n' +
  '- type_text: Type a string of text\n' +
  '- key_combo: Send keyboard shortcuts (Ctrl+C, Alt+Tab, Enter, etc.)\n' +
  '- scroll: Scroll up/down at a position\n' +
  '- mouse_move: Move cursor without clicking (for hover effects)\n' +
  '- wait: Pause before next screenshot (for loading screens)\n' +
  '- take_screenshot: Get a fresh screenshot without acting\n' +
  '- task_complete: Signal you are done\n' +
  '- ask_user: Ask the user a question\n\n' +
  'CRITICAL RULES:\n' +
  '1. Always analyze the screenshot before acting — describe what you see briefly\n' +
  '2. Execute ONE action per turn, then wait for the updated screenshot\n' +
  '3. Be precise with click coordinates — aim for the center of buttons/links/fields\n' +
  '4. After clicking a text field, use type_text to enter text\n' +
  '5. Use key_combo for keyboard shortcuts (Ctrl+S to save, Enter to confirm, etc.)\n' +
  '6. If something doesn\'t work, try a different approach\n' +
  '7. If you are stuck or unsure, use ask_user to get help\n' +
  '8. Call task_complete when the task is finished\n' +
  '9. Maximum 50 steps per task — be efficient';

module.exports = { VNC_AGENT_TOOLS, VNC_AGENT_SYSTEM_PROMPT };
