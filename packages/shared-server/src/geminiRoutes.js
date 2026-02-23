const express = require('express');
const { getVertexClient, callGenAI, convertSchemaToGenAI, GENAI_MODELS } = require('./vertexClient');
const { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } = require('./agentTools');

function createGeminiRoutes({ defaultProject, defaultLocation, getApiKey }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const {
        model = 'gemini-3-flash-preview',
        messages = [],
        project,
        location,
        apiKey,
      } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      const contents = messages.map((m) => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: m.text }],
      }));

      let text;
      const resolvedApiKey = apiKey || getApiKey();

      if (GENAI_MODELS.includes(model)) {
        if (!resolvedApiKey) {
          return res.status(400).json({
            error: 'GEMINI_API_KEY is required for this model. Set it in .env.',
          });
        }

        const data = await callGenAI(model, resolvedApiKey, {
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
        const resolvedProject = project || defaultProject;
        const resolvedLocation = location || defaultLocation;

        if (!resolvedProject) {
          return res.status(400).json({
            error: 'GCP project ID is required. Set GCP_PROJECT_ID in .env.',
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

  router.post('/agent', async (req, res) => {
    try {
      const {
        model = 'gemini-3-flash-preview',
        history = [],
        project,
        location,
        apiKey,
      } = req.body;

      const contents = history.map((entry) => ({
        role: entry.role,
        parts: entry.parts,
      }));

      if (contents.length === 0) {
        return res.status(400).json({ error: 'history is required' });
      }

      let parts;
      const resolvedApiKey = apiKey || getApiKey();

      if (GENAI_MODELS.includes(model)) {
        if (!resolvedApiKey) {
          return res.status(400).json({
            error: 'GEMINI_API_KEY is required for this model. Set it in .env.',
          });
        }

        const genaiTools = AGENT_TOOLS.map((toolGroup) => ({
          functionDeclarations: toolGroup.functionDeclarations.map((fn) => ({
            ...fn,
            parameters: fn.parameters ? convertSchemaToGenAI(fn.parameters) : undefined,
          })),
        }));

        const data = await callGenAI(model, resolvedApiKey, {
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
        const resolvedProject = project || defaultProject;
        const resolvedLocation = location || defaultLocation;

        if (!resolvedProject) {
          return res.status(400).json({
            error: 'GCP project ID is required. Set GCP_PROJECT_ID in .env.',
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

  return router;
}

module.exports = { createGeminiRoutes };
