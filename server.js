const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ⭐ Redirect root to the presentation
app.get('/', (req, res) => {
  res.redirect('/presentation.html');
});

// ⭐ Groq proxy — keeps the API key on the server, never in the browser
app.post('/groq', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set on server.' });
  }
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Groq request failed: ' + err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let responses = [];

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', responses }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'submit') {
      const entry = {
        id: Date.now() + Math.random(),
        user: (msg.data.user || 'Anonymous').slice(0, 40),
        nps: Number(msg.data.nps),
        csat: Number(msg.data.csat),
        ces: Number(msg.data.ces),
        comment: (msg.data.comment || '').slice(0, 200),
        timestamp: Date.now()
      };
      responses.push(entry);
      broadcast({ type: 'new', entry });
    }

    if (msg.type === 'reset') {
      responses = [];
      broadcast({ type: 'reset' });
    }
  });
});

function broadcast(payload) {
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => c.readyState === 1 && c.send(str));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('✅ Server running on port ' + PORT));
