const express = require('express');
const { AGENT_SYSTEM_PROMPT, toAnthropicTools, AGENT_TOOL_NAMES } = require('./agentTools');

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


/* ── Agent history bridge ───────────────────────────────
 *
 * The client keeps one history in Gemini shape (role user/model, parts holding
 * functionCall / functionResponse) so a single agent loop drives both
 * providers. These two functions are the only place that shape meets the
 * Anthropic Messages API.
 *
 * Two invariants the Messages API enforces, and Gemini's shape does not carry:
 *
 *   - Every tool_result must name the tool_use id it answers. Gemini's
 *     functionResponse only carries a tool *name*, so the id is recovered from
 *     the assistant turn it follows.
 *   - The assistant turn must be replayed exactly, thinking blocks and their
 *     signatures included, or the model rejects the turn. The raw blocks ride
 *     along on the part as `claudeContent`; the client stores parts verbatim
 *     and hands them back untouched, so nothing is lost in the round trip.
 */

/** Convert Gemini-shaped agent history into Anthropic messages. */
function toAnthropicHistory(history) {
  const messages = [];
  let lastToolUseId = null;
  let synthesized = 0;

  for (const entry of history) {
    const parts = Array.isArray(entry.parts) ? entry.parts : [];

    if (entry.role === 'model') {
      // Replay the exact blocks Claude produced when we have them.
      const raw = parts.find((part) => Array.isArray(part.claudeContent))?.claudeContent;
      if (raw) {
        messages.push({ role: 'assistant', content: raw });
        lastToolUseId = raw.filter((b) => b.type === 'tool_use').at(-1)?.id ?? null;
        continue;
      }

      // Otherwise rebuild it — this is a turn that came from Gemini, or from a
      // session that predates the raw passthrough.
      const content = [];
      for (const part of parts) {
        if (part.functionCall) {
          const id = `toolu_replay_${synthesized++}`;
          lastToolUseId = id;
          content.push({
            type: 'tool_use',
            id,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          });
        } else if (part.text) {
          content.push({ type: 'text', text: part.text });
        }
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }

    // User turn: either a typed message or the result of a tool call.
    for (const part of parts) {
      if (part.functionResponse) {
        const result = {
          type: 'tool_result',
          // A missing id means the pairing broke; the API rejects that loudly,
          // which is better than silently answering the wrong call.
          tool_use_id: lastToolUseId ?? 'toolu_unknown',
          content: JSON.stringify(part.functionResponse.response ?? {}),
        };
        // Consecutive results belong in one user turn, as parallel tool calls
        // require. Nothing here emits parallel calls today, but a split turn is
        // rejected outright, so it is not worth depending on that.
        const previous = messages.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content)
            && previous.content.at(-1)?.type === 'tool_result') {
          previous.content.push(result);
        } else {
          messages.push({ role: 'user', content: [result] });
        }
      } else if (part.text) {
        messages.push({ role: 'user', content: [{ type: 'text', text: part.text }] });
      }
    }
  }
  return messages;
}

/** Convert one Claude turn back into the Gemini-shaped parts the client loop reads. */
function toGeminiParts(content) {
  const parts = [];
  const toolUse = content.find((block) => block.type === 'tool_use');

  if (toolUse) {
    parts.push({
      functionCall: { name: toolUse.name, args: toolUse.input ?? {} },
      // Verbatim blocks for the next request: ids and thinking signatures.
      claudeContent: content,
    });
    return parts;
  }

  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  parts.push({ text: text || 'No response generated.', claudeContent: content });
  return parts;
}

function createClaudeRoutes({ getAnthropicKey, getVertexProject, getVertexRegion }) {
  const router = express.Router();

  /**
   * Build a Messages API client. Returns null when nothing is configured, so
   * callers can answer with a useful message instead of a stack trace.
   */
  async function resolveClient(apiKey) {
    const vertexProject = getVertexProject?.();
    // A key supplied per-request from Settings is an explicit user choice and
    // outranks the ambient Vertex project; the ambient env key does not.
    if (apiKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return new Anthropic({ apiKey });
    }
    if (vertexProject) {
      // Auth is Google ADC — no Anthropic key on this path.
      const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
      return new AnthropicVertex({
        projectId: vertexProject,
        region: getVertexRegion?.() || DEFAULT_VERTEX_REGION,
      });
    }
    const envKey = getAnthropicKey?.();
    if (envKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return new Anthropic({ apiKey: envKey });
    }
    return null;
  }

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

      const client = await resolveClient(apiKey);
      if (!client) {
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

  router.post('/agent', async (req, res) => {
    try {
      const { model = DEFAULT_MODEL, history = [], apiKey } = req.body;

      if (!Array.isArray(history) || history.length === 0) {
        return res.status(400).json({ error: 'history is required' });
      }

      const client = await resolveClient(apiKey);
      if (!client) {
        return res.status(400).json({
          error: 'No Claude credentials. Set ANTHROPIC_VERTEX_PROJECT_ID (Google ADC) '
            + 'or ANTHROPIC_API_KEY in .env, or add a key in Settings.',
        });
      }

      const messages = toAnthropicHistory(history);
      if (messages.length === 0) {
        return res.status(400).json({ error: 'history contained no usable turns' });
      }

      const result = await client.messages.create({
        model,
        max_tokens: 8192,
        system: AGENT_SYSTEM_PROMPT,
        messages,
        tools: toAnthropicTools(),
        // The loop executes exactly one action per turn and returns exactly one
        // result. Parallel calls would leave the extra tool_use blocks without
        // matching tool_result blocks, which the API rejects on the next turn.
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        // Opus 4.8 runs without thinking unless adaptive is requested, and it
        // rejects budget_tokens. Depth is set by effort instead.
        thinking: { type: 'adaptive' },
        output_config: { effort: process.env.CLAUDE_AGENT_EFFORT || 'medium' },
      });

      if (result.stop_reason === 'refusal') {
        return res.json({
          parts: [{ text: 'Claude declined this request (safety classifiers). Try rephrasing the task.' }],
        });
      }

      const toolNames = (result.content || []).filter((b) => b.type === 'tool_use').map((b) => b.name);
      const unknown = toolNames.filter((name) => !AGENT_TOOL_NAMES.includes(name));
      if (unknown.length > 0) {
        console.warn('[claude-agent] model called unknown tool(s):', unknown.join(', '));
      }

      res.json({ parts: toGeminiParts(result.content || []) });
    } catch (err) {
      console.error('[claude-agent] Error:', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(err?.status && err.status < 500 ? err.status : 500).json({ error: message });
    }
  });

  return router;
}

module.exports = { createClaudeRoutes, CLAUDE_DEFAULT_MODEL: DEFAULT_MODEL };
