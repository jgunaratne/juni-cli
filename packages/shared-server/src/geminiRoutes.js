const express = require('express');
const { getVertexClient, getGeminiClient, GENAI_MODELS } = require('./vertexClient');
const { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } = require('./agentTools');

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

function createGeminiRoutes({ defaultProject, defaultLocation }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const {
        model = 'gemini-3.1-pro-preview',
        messages = [],
        project,
        location,
      } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      const resolvedProject = project || defaultProject;
      const resolvedLocation = location || defaultLocation;

      if (!resolvedProject) {
        return res.status(400).json({
          error: 'GCP project ID is required. Set GCP_PROJECT_ID in .env.',
        });
      }

      let text;

      if (GENAI_MODELS.includes(model)) {
        // Gemini 3 models → @google/genai via Vertex AI
        const client = getGeminiClient(resolvedProject, resolvedLocation);
        const response = await client.models.generateContent({
          model,
          contents: messages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.text }],
          })),
          config: {
            systemInstruction: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
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
          systemInstruction: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
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
        model = 'gemini-3.1-pro-preview',
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

      if (!resolvedProject) {
        return res.status(400).json({
          error: 'GCP project ID is required. Set GCP_PROJECT_ID in .env.',
        });
      }

      let parts;

      if (GENAI_MODELS.includes(model)) {
        // Gemini 3 preview: use prompt-based tool calling (native function calling is unreliable)
        const client = getGeminiClient(resolvedProject, resolvedLocation);

        // Convert history: replace functionCall/functionResponse with text equivalents
        const promptContents = contents.map((entry) => {
          const newParts = entry.parts.map((p) => {
            if (p.functionCall) {
              return { text: `[TOOL_CALL] ${JSON.stringify(p.functionCall)}` };
            }
            if (p.functionResponse) {
              return { text: `[TOOL_RESULT] ${JSON.stringify(p.functionResponse)}` };
            }
            return p;
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

        // Extract the FIRST complete JSON object using bracket counting
        function extractFirstJSON(str) {
          let depth = 0;
          let start = -1;
          for (let i = 0; i < str.length; i++) {
            if (str[i] === '{') {
              if (depth === 0) start = i;
              depth++;
            } else if (str[i] === '}') {
              depth--;
              if (depth === 0 && start >= 0) {
                return str.slice(start, i + 1);
              }
            }
          }
          return null;
        }

        // Parse JSON response into parts format
        try {
          let cleaned = responseText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
          cleaned = cleaned.replace(/^\[TOOL_CALL\]\s*/i, '');
          const jsonStr = extractFirstJSON(cleaned);
          if (!jsonStr) throw new Error('No JSON found');
          const parsed = JSON.parse(jsonStr);

          if (parsed.functionCall) {
            parts = [{ functionCall: parsed.functionCall }];
          } else if (parsed.name && parsed.args) {
            parts = [{ functionCall: { name: parsed.name, args: parsed.args } }];
          } else if (parsed.text) {
            parts = [{ text: parsed.text }];
          } else {
            parts = [{ text: responseText }];
          }
        } catch {
          // Not valid JSON — treat as plain text response
          parts = [{ text: responseText || 'The model returned an empty response. Please try again.' }];
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

  return router;
}

module.exports = { createGeminiRoutes };
