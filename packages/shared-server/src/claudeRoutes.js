const express = require('express');

// Claude Opus 4.8. On Vertex the id carries no publisher prefix and no date
// suffix — the bare first-party id is what the endpoint expects.
const DEFAULT_MODEL = 'claude-opus-4-8';

// Vertex serves Claude from a small set of locations, and "not servable here"
// is a 400 rather than a redirect: `global` answers, a non-serving region
// rejects the model outright, and a region at capacity returns 429. This
// deliberately does NOT read GCP_LOCATION — that is the Gemini region, and
// reusing it would break every Claude request.
const DEFAULT_VERTEX_REGION = 'global';

// Opus 4.8 runs without thinking unless adaptive is asked for explicitly, and
// it rejects `budget_tokens` outright. Effort is the depth control; `low` keeps
// a terminal-side assistant responsive, and these are short Linux Q&A turns.
const DEFAULT_EFFORT = 'low';

/** Pull the assistant's prose out of a response that may also carry thinking blocks. */
function extractText(content) {
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
  return text || null;
}

function createClaudeRoutes({ getAnthropicKey, getVertexProject, getVertexRegion }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const {
        model = DEFAULT_MODEL,
        messages = [],
        apiKey,
        effort,
      } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      const vertexProject = getVertexProject?.();
      // A key supplied per-request from Settings is an explicit choice by the
      // user, so it outranks the ambient Vertex project; the ambient env key
      // does not, because Vertex is the configured path on this deployment.
      const resolvedKey = apiKey || (vertexProject ? '' : getAnthropicKey());

      let client;
      if (apiKey || (!vertexProject && resolvedKey)) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        client = new Anthropic({ apiKey: resolvedKey });
      } else if (vertexProject) {
        // Auth is Google ADC — there is no Anthropic API key on this path.
        const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
        client = new AnthropicVertex({
          projectId: vertexProject,
          region: getVertexRegion?.() || DEFAULT_VERTEX_REGION,
        });
      } else {
        return res.status(400).json({
          error:
            'No Claude credentials. Set ANTHROPIC_VERTEX_PROJECT_ID (Google ADC) '
            + 'or ANTHROPIC_API_KEY in .env, or add a key in Settings.',
        });
      }

      const anthropicMessages = messages.map((m) => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.text,
      }));

      const result = await client.messages.create({
        model,
        max_tokens: 16000,
        system: 'You are a Linux expert. Every time you mention a terminal command, you must wrap it in <cmd> and </cmd> tags. Example: Use <cmd>ls -la</cmd> to list files.',
        messages: anthropicMessages,
        thinking: { type: 'adaptive' },
        output_config: { effort: effort || DEFAULT_EFFORT },
        // Sampling parameters are rejected on current Claude models; steer with
        // the system prompt instead.
      });

      // Safety classifiers can decline with HTTP 200, so stop_reason is checked
      // before the content is read.
      if (result.stop_reason === 'refusal') {
        return res.status(200).json({
          reply: 'Claude declined this request.',
          stopReason: 'refusal',
          category: result.stop_details?.category ?? null,
        });
      }

      res.json({ reply: extractText(result.content) ?? 'No response generated.' });
    } catch (err) {
      console.error('[claude] Chat error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: message });
    }
  });

  return router;
}

module.exports = { createClaudeRoutes, CLAUDE_DEFAULT_MODEL: DEFAULT_MODEL };
