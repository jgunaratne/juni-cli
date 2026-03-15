const { createGeminiRoutes } = require('./geminiRoutes');
const { createClaudeRoutes } = require('./claudeRoutes');
const { setupSshHandler } = require('./sshHandler');
const { setupShareRelay } = require('./shareRelay');
const { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } = require('./agentTools');
const { VNC_AGENT_TOOLS, VNC_AGENT_SYSTEM_PROMPT } = require('./vncAgentTools');
const { getVertexClient, getGeminiClient, GENAI_MODELS } = require('./vertexClient');

module.exports = {
  createGeminiRoutes,
  createClaudeRoutes,
  setupSshHandler,
  setupShareRelay,
  AGENT_TOOLS,
  AGENT_SYSTEM_PROMPT,
  VNC_AGENT_TOOLS,
  VNC_AGENT_SYSTEM_PROMPT,
  getVertexClient,
  getGeminiClient,
  GENAI_MODELS,
};
