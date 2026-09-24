const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 🧠 All data lives here in RAM — gone when the server restarts
let responses = [];

wss.on('connection', (ws) => {
  // Send current state to every new client
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