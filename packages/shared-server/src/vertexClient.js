const { VertexAI } = require('@google-cloud/vertexai');
const { GoogleGenAI } = require('@google/genai');

/* ── Vertex AI client (for non-Gemini-3 models) ──────────── */

const vertexCache = new Map();

function getVertexClient(project, location) {
  const key = `${project}::${location}`;
  if (!vertexCache.has(key)) {
    vertexCache.set(key, new VertexAI({ project, location }));
  }
  return vertexCache.get(key);
}

/* ── @google/genai client (for Gemini 3 models via Vertex AI) */

const genaiCache = new Map();

/**
 * Preview models require the 'global' region.
 */
function requiresGlobalRegion(model) {
  return model.includes('preview');
}

/**
 * Creates a GoogleGenAI client configured for Vertex AI.
 * Auto-selects 'global' region for preview models.
 */
function getGeminiClient(project, location) {
  const resolvedLocation = requiresGlobalRegion('preview')
    ? 'global'
    : (location || 'us-central1');

  const key = `genai::${project}::${resolvedLocation}`;
  if (!genaiCache.has(key)) {
    genaiCache.set(key, new GoogleGenAI({
      vertexai: true,
      project,
      location: resolvedLocation,
    }));
  }
  return genaiCache.get(key);
}

// Models that use @google/genai via Vertex AI instead of @google-cloud/vertexai
const GENAI_MODELS = ['gemini-3-flash-preview', 'gemini-3-pro-preview'];

module.exports = { getVertexClient, getGeminiClient, GENAI_MODELS };
