const { createGeminiRoutes } = require('./geminiRoutes');
const { createClaudeRoutes } = require('./claudeRoutes');
const { setupSshHandler } = require('./sshHandler');
const { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } = require('./agentTools');
const { getVertexClient, getGeminiClient, GENAI_MODELS } = require('./vertexClient');

module.exports = {
  createGeminiRoutes,
  createClaudeRoutes,
  setupSshHandler,
  AGENT_TOOLS,
  AGENT_SYSTEM_PROMPT,
  getVertexClient,
  getGeminiClient,
  GENAI_MODELS,
};
