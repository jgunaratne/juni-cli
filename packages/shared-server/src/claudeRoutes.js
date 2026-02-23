const express = require('express');

function createClaudeRoutes({ getAnthropicKey }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const {
        model = 'claude-sonnet-4-20250514',
        messages = [],
        apiKey,
      } = req.body;

      const resolvedKey = apiKey || getAnthropicKey();

      if (!resolvedKey) {
        return res.status(400).json({
          error: 'Anthropic API key is required. Add it in Settings or set ANTHROPIC_API_KEY in .env.',
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

  return router;
}

module.exports = { createClaudeRoutes };
