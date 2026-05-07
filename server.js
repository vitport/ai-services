const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let config;
try { config = require('./config'); } catch(e) { config = require('./config.example'); }

const app = express();
const PORT = config.PORT || 12345;
const OLLAMA_HOST = config.OLLAMA_HOST || 'http://localhost:11434';
const PIPER_EXE = path.join(__dirname, 'piper.exe');
const VOICES_DIR = path.join(__dirname, 'voices');

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

// ── SEARCH SERVICE ────────────────────────────────────

app.post('/search', async (req, res) => {
  const { query, summarize = true } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const serperKey = config.SERPER_API_KEY;
  if (!serperKey || serperKey === 'YOUR_SERPER_KEY') {
    return res.status(503).json({ error: 'Serper API key not configured' });
  }

  const serperBody = JSON.stringify({ q: query, num: 10 });
  const serperOptions = {
    hostname: 'google.serper.dev',
    path: '/search',
    method: 'POST',
    headers: {
      'X-API-KEY': serperKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serperBody)
    }
  };

  const results = await new Promise((resolve, reject) => {
    const req2 = https.request(serperOptions, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Serper parse error')); }
      });
    });
    req2.on('error', reject);
    req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('Serper timeout')); });
    req2.write(serperBody);
    req2.end();
  }).catch(e => null);

  if (!results) {
    return res.status(503).json({ error: 'Search service unavailable' });
  }

  const organic = (results.organic || []).slice(0, 5).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link
  }));

  let summary = null;
  if (summarize && organic.length > 0) {
    const snippets = organic.map((r,i) => `${i+1}. ${r.title}: ${r.snippet}`).join('\n');
    const prompt = `Search query: "${query}"\nResults:\n${snippets}\n\nWrite a 2-sentence summary of these search results. No ellipsis. No truncation.`;

    try {
      const ollamaBody = JSON.stringify({ model: 'mistral:latest', prompt, stream: false });
      const ollamaResult = await new Promise((resolve, reject) => {
        const url = new URL(OLLAMA_HOST + '/api/generate');
        const opts = {
          hostname: url.hostname,
          port: url.port || 11434,
          path: '/api/generate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaBody) }
        };
        const r = http.request(opts, (res2) => {
          let d = '';
          res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
        });
        r.on('error', () => resolve(null));
        r.setTimeout(60000, () => { r.destroy(); resolve(null); });
        r.write(ollamaBody);
        r.end();
      });
      summary = ollamaResult?.response || null;
    } catch(e) {
      summary = null;
    }
  }

  res.json({ query, results: organic, summary, total: results.organic?.length || 0 });
});

app.get('/api/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q parameter required' });
  res.json({ message: 'Use POST /search with body {query, summarize}', query });
});

// ── VOICE / TTS SERVICE ───────────────────────────────

app.get('/voice/voices', (req, res) => {
  try {
    const files = fs.readdirSync(VOICES_DIR)
      .filter(f => f.endsWith('.onnx') && !f.endsWith('.json'))
      .map(f => ({
        id: f.replace('.onnx', ''),
        file: f,
        path: path.join(VOICES_DIR, f)
      }));
    res.json({ voices: files, count: files.length });
  } catch(e) {
    res.status(503).json({ error: 'Voices directory not found', detail: e.message });
  }
});

app.post('/voice/speak', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  let voiceFile;
  if (voice) {
    voiceFile = path.join(VOICES_DIR, voice.endsWith('.onnx') ? voice : voice + '.onnx');
  } else {
    try {
      const files = fs.readdirSync(VOICES_DIR).filter(f => f.endsWith('.onnx') && !f.endsWith('.json'));
      if (files.length === 0) return res.status(503).json({ error: 'No voice models found' });
      voiceFile = path.join(VOICES_DIR, files[0]);
    } catch(e) {
      return res.status(503).json({ error: 'Voices directory not found' });
    }
  }

  if (!fs.existsSync(PIPER_EXE)) {
    return res.status(503).json({ error: 'piper.exe not found', path: PIPER_EXE });
  }

  try {
    const audioBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const piper = spawn(PIPER_EXE, ['--model', voiceFile, '--output_raw'], { cwd: __dirname });

      piper.stdin.write(text);
      piper.stdin.end();
      piper.stdout.on('data', chunk => chunks.push(chunk));
      piper.stderr.on('data', () => {});
      piper.on('close', (code) => {
        if (chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error('Piper produced no output, code: ' + code));
      });
      piper.on('error', reject);
      setTimeout(() => { piper.kill(); reject(new Error('Piper timeout')); }, 15000);
    });

    res.json({
      success: true,
      audio: audioBuffer.toString('base64'),
      format: 'raw',
      text,
      voice: path.basename(voiceFile)
    });
  } catch(e) {
    res.status(500).json({ error: 'TTS failed', detail: e.message });
  }
});

app.post('/api/tts/speak', (req, res) => {
  req.url = '/voice/speak';
  app.handle(req, res);
});

app.get('/api/tts/voices', (req, res) => {
  req.url = '/voice/voices';
  app.handle(req, res);
});

// ── START ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ai-services running on http://localhost:${PORT}`);
  console.log(`🌐 LAN: http://192.168.1.2:${PORT}`);
  console.log(`🤖 Ollama proxy → ${OLLAMA_HOST}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
});
