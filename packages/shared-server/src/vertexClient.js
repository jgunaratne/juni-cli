const { VertexAI } = require('@google-cloud/vertexai');

const clientCache = new Map();

function getVertexClient(project, location) {
  const key = `${project}::${location}`;
  if (!clientCache.has(key)) {
    clientCache.set(key, new VertexAI({ project, location }));
  }
  return clientCache.get(key);
}

async function callGenAI(model, apiKey, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Google AI API error: HTTP ${res.status}`);
  }

  return res.json();
}

function convertSchemaToGenAI(schema) {
  if (!schema) return schema;
  const result = { ...schema };
  if (result.type) {
    result.type = result.type.toLowerCase();
  }
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, val]) => [key, convertSchemaToGenAI(val)])
    );
  }
  if (result.items) {
    result.items = convertSchemaToGenAI(result.items);
  }
  return result;
}

// Models that should use the Generative Language API instead of Vertex AI
const GENAI_MODELS = ['gemini-3-flash-preview'];

module.exports = { getVertexClient, callGenAI, convertSchemaToGenAI, GENAI_MODELS };
