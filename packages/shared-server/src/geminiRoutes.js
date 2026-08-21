const express = require('express');
const { getVertexClient, getGeminiClient, getGeminiApiKeyClient, GENAI_MODELS } = require('./vertexClient');
const { AGENT_TOOLS, AGENT_SYSTEM_PROMPT, buildChatSystemPrompt } = require('./agentTools');
const { VNC_AGENT_TOOLS, VNC_AGENT_SYSTEM_PROMPT } = require('./vncAgentTools');

/**
 * Convert tool schemas from Vertex AI format (uppercase types)
 * to @google/genai format (lowercase types).
 */
function convertSchemaValue(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(convertSchemaValue);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'type' && typeof value === 'string') {
      result[key] = value.toLowerCase();
    } else {
      result[key] = convertSchemaValue(value);
    }
  }
  return result;
}

function convertToolsForGenAI(tools) {
  return convertSchemaValue(tools);
}

/**
 * Find the first complete JSON object in a string, skipping over string
 * literals.
 *
 * Counting braces blindly breaks on ordinary shell commands: `grep '}' f` or
 * `sed 's/}//g'` puts an unbalanced brace inside a JSON string, which closed
 * the object early and yielded a truncated, unparseable fragment — the tool
 * call was then silently downgraded to a text reply.
 */
function extractFirstJSON(str) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Recover `parts` from a model turn that arrived as text rather than as a
 * structured function call — either because the fallback path asked for JSON,
 * or because a model wrote a call as prose. Text that is not a tool call is
 * returned unchanged.
 */
function partsFromModelText(responseText) {
  try {
    let cleaned = String(responseText).replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    cleaned = cleaned.replace(/^\[TOOL_CALL\]\s*/i, '');
    const jsonStr = extractFirstJSON(cleaned);
    if (!jsonStr) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonStr);

    if (parsed.functionCall) return [{ functionCall: parsed.functionCall }];
    if (parsed.name && parsed.args) return [{ functionCall: { name: parsed.name, args: parsed.args } }];
    if (parsed.text) return [{ text: parsed.text }];
    return [{ text: responseText }];
  } catch {
    return [{ text: responseText || 'The model returned an empty response. Please try again.' }];
  }
}

function resolveGenAIClient(resolvedProject, resolvedLocation) {
  if (resolvedProject) {
    return getGeminiClient(resolvedProject, resolvedLocation);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    return getGeminiApiKeyClient(apiKey);
  }
  return null;
}

function createGeminiRoutes({ defaultProject, defaultLocation }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const {
        model = 'gemini-3.7-flash',
        messages = [],
        project,
        location,
        terminalContext,
      } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      const resolvedProject = project || defaultProject;
      const resolvedLocation = location || defaultLocation;

      let text;

      if (GENAI_MODELS.includes(model)) {
        // Gemini 3 models → @google/genai via Vertex AI or API key
        const client = resolveGenAIClient(resolvedProject, resolvedLocation);
        if (!client) {
          return res.status(400).json({
            error: 'No credentials available. Set GCP_PROJECT_ID or GEMINI_API_KEY in .env.',
          });
        }
        const response = await client.models.generateContent({
          model,
          contents: messages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.text }],
          })),
          config: {
            systemInstruction: buildChatSystemPrompt(terminalContext),
            temperature: 0.7,
            maxOutputTokens: 4096,
          },
        });

        // Extract text: try .text getter first, fall back to candidates
        try {
          text = response?.text;
        } catch (e) {
          console.log('[gemini-chat] response.text error:', e.message);
        }

        if (!text) {
          const candidateText = response?.candidates?.[0]?.content?.parts
            ?.filter((p) => p.text)
            ?.map((p) => p.text)
            ?.join('');
          text = candidateText || null;
        }

        if (!text) {
          console.log('[gemini-chat] Empty response from', model, '- finishReason:', response?.candidates?.[0]?.finishReason);
          text = 'The model returned an empty response. Please try again.';
        }
      } else {
        // Legacy models → @google-cloud/vertexai
        const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
        const generativeModel = vertexAI.getGenerativeModel({
          model,
          systemInstruction: buildChatSystemPrompt(terminalContext),
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
        });

        const contents = messages.map((m) => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }],
        }));

        const result = await generativeModel.generateContent({ contents });
        const response = result.response;
        text = response?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No response generated.';
      }

      console.log('[gemini-chat]', model, '→', text?.slice(0, 100));
      res.json({ reply: text });
    } catch (err) {
      console.error('[gemini-chat] Error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  router.post('/agent', async (req, res) => {
    try {
      const {
        model = 'gemini-3.7-flash',
        history = [],
        project,
        location,
      } = req.body;

      const resolvedProject = project || defaultProject;
      const resolvedLocation = location || defaultLocation;

      const contents = history.map((entry) => ({
        role: entry.role,
        parts: entry.parts,
      }));

      if (contents.length === 0) {
        return res.status(400).json({ error: 'history is required' });
      }

      let parts;

      if (GENAI_MODELS.includes(model)) {
        const client = resolveGenAIClient(resolvedProject, resolvedLocation);
        if (!client) {
          return res.status(400).json({
            error: 'No credentials available. Set GCP_PROJECT_ID or GEMINI_API_KEY in .env.',
          });
        }

        // Native function calling is the primary path. The history already holds
        // functionCall / functionResponse parts in exactly the shape the API
        // wants, so it goes through untouched — no lossy text round-trip, and
        // tool arguments arrive already parsed instead of being recovered from
        // a JSON string the model had to hand-write.
        //
        // The prompt-based path below stays as a fallback. It was the primary
        // path when Gemini 3 was in preview and native calling was unreliable;
        // it is kept because it costs nothing when unused, and it is the only
        // recourse if a model stops emitting structured calls.
        // Gemini rejects a functionCall replayed without the thoughtSignature it
        // originally issued ("Function call is missing a thought_signature").
        // Turns produced by the fallback below, or by Claude before a mid-run
        // model switch, have no signature — and once one is in the history every
        // later native call 400s, so the run silently degrades for good. Detect
        // it up front and skip straight to the fallback instead of paying for a
        // round trip that cannot succeed.
        const signaturesIntact = contents.every((entry) =>
          (entry.parts || []).every((part) => !part.functionCall || part.thoughtSignature));

        try {
          if (!signaturesIntact) throw new Error('history has unsigned function calls');
          const response = await client.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: AGENT_SYSTEM_PROMPT,
              tools: convertToolsForGenAI(AGENT_TOOLS),
              temperature: 0.3,
              maxOutputTokens: 4096,
            },
          });
          const nativeParts = response?.candidates?.[0]?.content?.parts ?? [];
          if (nativeParts.some((part) => part.functionCall)) {
            parts = nativeParts;
          } else {
            // No structured call. The turn may still be a tool call the model
            // wrote as prose, so it goes through the same recovery parser the
            // fallback uses; a genuine text answer survives it unchanged.
            const nativeText = nativeParts.map((part) => part.text).filter(Boolean).join('');
            if (nativeText.trim()) parts = partsFromModelText(nativeText);
          }
        } catch (err) {
          console.warn('[gemini-agent] native function calling failed, falling back to prompt-based:', err.message);
        }

        if (!parts) {
          // Fallback: ask for one JSON action per turn, in text.
          // functionCall/functionResponse parts have no text equivalent here, so
          // they are rendered as tagged text for the model to read back.
          const promptContents = contents.map((entry) => {
            const newParts = entry.parts.map((part) => {
              if (part.functionCall) {
                return { text: `[TOOL_CALL] ${JSON.stringify(part.functionCall)}` };
              }
              if (part.functionResponse) {
                return { text: `[TOOL_RESULT] ${JSON.stringify(part.functionResponse)}` };
              }
              return part;
            });
            return { role: entry.role, parts: newParts };
          });

          const toolPrompt =
            AGENT_SYSTEM_PROMPT + '\n\n' +
            'CRITICAL RULES:\n' +
            '1. Respond with EXACTLY ONE action per turn — never multiple.\n' +
            '2. Output ONLY a single JSON object, no other text before or after it.\n' +
            '3. Do NOT plan ahead — respond with one action, wait for the result, then decide next.\n\n' +
            'RESPONSE FORMAT:\n' +
            'To call a tool: {"functionCall":{"name":"TOOL_NAME","args":{...}}}\n' +
            'To reply with text (no tool): {"text":"your response"}\n\n' +
            'Available tools:\n' +
            '- run_command: args: command, reasoning\n' +
            '- send_keys: args: keys, reasoning\n' +
            '- task_complete: args: summary\n' +
            '- ask_user: args: question, reasoning\n' +
            '- read_terminal: args: reasoning\n';

          const response = await client.models.generateContent({
            model,
            contents: promptContents,
            config: {
              systemInstruction: toolPrompt,
              temperature: 0.3,
              maxOutputTokens: 4096,
            },
          });

          const responseText = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          console.log('[gemini-agent] prompt-based response:', responseText?.slice(0, 300));
          parts = partsFromModelText(responseText);
        }
      } else {
        // Legacy models → @google-cloud/vertexai
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

  /* ── VNC Agent endpoint ─────────────────────────────── */

  router.post('/vnc-agent', async (req, res) => {
    try {
      const {
        model = 'gemini-3.7-flash',
        history = [],
        project,
        location,
      } = req.body;

      const resolvedProject = project || defaultProject;
      const resolvedLocation = location || defaultLocation;

      if (history.length === 0) {
        return res.status(400).json({ error: 'history is required' });
      }

      const contents = history.map((entry) => ({
        role: entry.role,
        parts: entry.parts,
      }));

      let parts;

      if (GENAI_MODELS.includes(model)) {
        const client = resolveGenAIClient(resolvedProject, resolvedLocation);
        if (!client) {
          return res.status(400).json({
            error: 'No credentials available. Set GCP_PROJECT_ID or GEMINI_API_KEY in .env.',
          });
        }

        // Convert history: replace functionCall/functionResponse with text equivalents
        const promptContents = contents.map((entry) => {
          const newParts = entry.parts.map((p) => {
            if (p.functionCall) {
              return { text: `[TOOL_CALL] ${JSON.stringify(p.functionCall)}` };
            }
            if (p.functionResponse) {
              return { text: `[TOOL_RESULT] ${JSON.stringify(p.functionResponse)}` };
            }
            return p;  // pass through text and inlineData (images)
          });
          return { role: entry.role, parts: newParts };
        });

        const toolPrompt =
          VNC_AGENT_SYSTEM_PROMPT + '\n\n' +
          'RESPONSE FORMAT:\n' +
          'Respond with EXACTLY ONE JSON object, no other text before or after it.\n' +
          'To call a tool: {"functionCall":{"name":"TOOL_NAME","args":{...}}}\n' +
          'To reply with text: {"text":"your response"}\n\n' +
          'Available tools:\n' +
          '- click: args: normalizedX, normalizedY, button?, clickCount?, reasoning\n' +
          '- type_text: args: text, reasoning\n' +
          '- key_combo: args: keys[], reasoning\n' +
          '- scroll: args: normalizedX, normalizedY, dy, reasoning\n' +
          '- mouse_move: args: normalizedX, normalizedY, reasoning\n' +
          '- wait: args: seconds, reasoning\n' +
          '- take_screenshot: args: reasoning\n' +
          '- task_complete: args: summary\n' +
          '- ask_user: args: question, reasoning\n';

        const response = await client.models.generateContent({
          model,
          contents: promptContents,
          config: {
            systemInstruction: toolPrompt,
            temperature: 0.3,
            maxOutputTokens: 4096,
          },
        });

        const responseText = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('[vnc-agent] response:', responseText?.slice(0, 300));

        parts = partsFromModelText(responseText);
      } else {
        // Legacy models with native function calling
        const vertexAI = getVertexClient(resolvedProject, resolvedLocation);
        const generativeModel = vertexAI.getGenerativeModel({
          model,
          systemInstruction: VNC_AGENT_SYSTEM_PROMPT,
          tools: VNC_AGENT_TOOLS,
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
      console.error('[vnc-agent] Error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}

module.exports = { createGeminiRoutes };
