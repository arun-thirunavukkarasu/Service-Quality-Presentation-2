const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ⭐ Root redirect
app.get('/', (req, res) => {
  res.redirect('/presentation.html');
});

// ⭐ Groq Proxy Route (upgraded system prompt + rate guard)
const groqLastCall = new Map(); // clientId -> timestamp
const GROQ_MIN_INTERVAL_MS = 15000; // per-client cooldown

app.post('/groq', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is missing from Render Environment Variables.' });
  }

  // Per-IP rate guard (protects against accidental loops)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const last = groqLastCall.get(ip) || 0;
  if (now - last < GROQ_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: `Too soon. Please wait ${Math.ceil((GROQ_MIN_INTERVAL_MS - (now - last)) / 1000)}s.` });
  }
  groqLastCall.set(ip, now);

  // Enforce our own system prompt so the frontend can't leak/change it
  const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const userContent = userMessages.filter(m => m.role === 'user').map(m => m.content).join('\n\n') || '';
  const systemPrompt = [
    'You are a CX analyst for Karur Vysya Bank training sessions.',
    'Analyze the provided customer comments and produce:',
    '1. Exactly 3 short, actionable insights (max 8 words each).',
    '2. A single overall sentiment: one of "positive", "mixed", or "negative".',
    '3. Exactly 3 short topic tags (1-3 words each) representing main themes.',
    'Output ONLY valid JSON with this exact shape:',
    '{ "insights": ["...", "...", "..."], "sentiment": "positive|mixed|negative", "topics": ["...", "...", "..."] }',
    'No markdown, no extra keys, no explanation.'
  ].join(' ');

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: req.body?.model || 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Comments:\n' + userContent }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Groq API Error' });
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Network error reaching Groq: ' + err.message });
  }
});

// ⭐ CSV Export
app.get('/export', (req, res) => {
  const header = 'timestamp,user,nps,csat,ces,comment\n';
  const rows = responses.map(r => {
    const ts = new Date(r.timestamp).toISOString();
    const safe = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    return [ts, safe(r.user), r.nps, r.csat, r.ces, safe(r.comment)].join(',');
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kvb-responses.csv"');
  res.send(header + rows);
});

// ⭐ Manual reset via HTTP (in addition to WS)
app.post('/reset', (req, res) => {
  responses = [];
  saveResponses();
  broadcast({ type: 'reset' });
  res.json({ ok: true, count: 0 });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ═══════════ PERSISTENCE ═══════════
const STORAGE_FILE = path.join(__dirname, 'responses.json');
let responses = [];

function loadResponses() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) responses = parsed;
      console.log(`📂 Loaded ${responses.length} responses from disk`);
    }
  } catch (e) {
    console.warn('⚠️ Could not load responses.json:', e.message);
  }
}

let saveTimer = null;
function saveResponses() {
  // Debounced write (200ms) to avoid hammering disk
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(responses, null, 2));
    } catch (e) {
      console.warn('⚠️ Could not write responses.json:', e.message);
    }
  }, 200);
}

loadResponses();

// ═══════════ VALIDATION ═══════════
function validateEntry(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'Invalid payload' };
  const nps = Number(data.nps);
  const csat = Number(data.csat);
  const ces = Number(data.ces);
  if (!Number.isInteger(nps) || nps < 0 || nps > 10) return { ok: false, reason: 'NPS must be an integer 0–10' };
  if (!Number.isInteger(csat) || csat < 1 || csat > 5) return { ok: false, reason: 'CSAT must be an integer 1–5' };
  if (!Number.isInteger(ces) || ces < 1 || ces > 5) return { ok: false, reason: 'CES must be an integer 1–5' };
  return { ok: true, clean: {
    nps, csat, ces,
    user: String(data.user || 'Anonymous').slice(0, 40).trim() || 'Anonymous',
    comment: String(data.comment || '').slice(0, 200)
  }};
}

// ═══════════ RATE LIMITING ═══════════
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 3;
const connBuckets = new WeakMap(); // ws -> [timestamps]

function isRateLimited(ws) {
  const now = Date.now();
  let bucket = connBuckets.get(ws);
  if (!bucket) { bucket = []; connBuckets.set(ws, bucket); }
  // prune old
  while (bucket.length && now - bucket[0] > RATE_WINDOW_MS) bucket.shift();
  if (bucket.length >= RATE_MAX) return true;
  bucket.push(now);
  return false;
}

// ═══════════ WEBSOCKET ═══════════
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', responses }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'submit') {
      if (isRateLimited(ws)) {
        ws.send(JSON.stringify({ type: 'error', reason: 'Too many submissions. Please wait a minute.' }));
        return;
      }
      const v = validateEntry(msg.data);
      if (!v.ok) {
        ws.send(JSON.stringify({ type: 'error', reason: v.reason }));
        return;
      }
      const entry = {
        id: Date.now() + Math.random(),
        ...v.clean,
        timestamp: Date.now()
      };
      responses.push(entry);
      saveResponses();
      broadcast({ type: 'new', entry });
    }

    if (msg.type === 'reset') {
      responses = [];
      saveResponses();
      broadcast({ type: 'reset' });
    }
  });
});

function broadcast(payload) {
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => c.readyState === 1 && c.send(str));
}

// ═══════════ GRACEFUL SHUTDOWN ═══════════
function shutdown(signal) {
  console.log(`\n${signal} received. Closing…`);
  try { wss.clients.forEach(c => c.close()); } catch {}
  try { if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(STORAGE_FILE, JSON.stringify(responses, null, 2)); } } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('✅ Server running on port ' + PORT));