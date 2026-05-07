const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
let config;
try { config = require('./config'); } catch(e) { config = require('./config.example'); }

const app = express();
const PORT = config.PORT || 12345;
const OLLAMA_HOST = config.OLLAMA_HOST || 'http://localhost:11434';

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ── Request logger ──────────────────────────────────
app.use((req, res, next) => {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  fs.appendFileSync('server.log', line + '\n');
  next();
});

// ── HEALTH CHECK ────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    service: 'ai-services',
    uptime: Math.floor(process.uptime()),
    ollama: OLLAMA_HOST
  });
});

// ── OLLAMA PROXY HELPER ──────────────────────────────
function ollamaRequest(ollamaPath, method, body, res) {
  const url = new URL(OLLAMA_HOST + ollamaPath);
  const options = {
    hostname: url.hostname,
    port: url.port || 11434,
    path: url.pathname,
    method: method,
    headers: { 'Content-Type': 'application/json' }
  };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

  const req2 = http.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.send(data); }
    });
  });
  req2.on('error', (e) => {
    res.status(503).json({ error: 'Ollama unreachable', detail: e.message, host: OLLAMA_HOST });
  });
  req2.setTimeout(180000, () => {
    req2.destroy();
    res.status(504).json({ error: 'Ollama timeout after 180s' });
  });
  if (bodyStr) req2.write(bodyStr);
  req2.end();
}

// ── OLLAMA ROUTES (primary) ──────────────────────────
app.get('/ollama/status', (req, res) => {
  ollamaRequest('/api/tags', 'GET', null, res);
});

app.post('/ollama/generate', (req, res) => {
  const body = { stream: false, ...req.body };
  ollamaRequest('/api/generate', 'POST', body, res);
});

app.post('/ollama/release', (req, res) => {
  const body = { model: req.body?.model || 'mistral:latest', keep_alive: 0 };
  ollamaRequest('/api/generate', 'POST', body, res);
});

// ── OLLAMA ROUTES (backward compat aliases) ──────────
// These match the existing /api/ollama/* paths used by Recipe Book,
// Timedox AI, and HR Project so they can migrate without code changes.
app.get('/api/ollama/status',    (req, res) => ollamaRequest('/api/tags', 'GET', null, res));
app.post('/api/ollama/generate', (req, res) => {
  const body = { stream: false, ...req.body };
  ollamaRequest('/api/generate', 'POST', body, res);
});
app.post('/api/ollama/release',  (req, res) => {
  const body = { model: req.body?.model || 'mistral:latest', keep_alive: 0 };
  ollamaRequest('/api/generate', 'POST', body, res);
});
app.get('/api/ollama/host', (req, res) => {
  res.json({ host: OLLAMA_HOST });
});

// ── SEARCH CONFIG (backward compat for SearchEngine.js) ──
app.get('/api/config/search', (req, res) => {
  res.json({
    serperApiKey: config.SERPER_API_KEY || '',
    googleCx: config.GOOGLE_CX || '',
    googleApiKey: config.GOOGLE_API_KEY || ''
  });
});

// ── START ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ai-services running on http://localhost:${PORT}`);
  console.log(`🌐 LAN: http://192.168.1.2:${PORT}`);
  console.log(`🤖 Ollama proxy → ${OLLAMA_HOST}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
});
