// backend/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
if (!deepgramApiKey) {
  console.error("❌ Deepgram API Key missing. Check .env");
  process.exit(1);
}

const deepgram = createClient(deepgramApiKey);
const sessions = {};

// Cleanup stale sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const sid in sessions) {
    if (now - sessions[sid].lastActivity > 60 * 60 * 1000) {
      console.log(`🧹 Cleaning session ${sid}`);
      delete sessions[sid];
    }
  }
}, 60000);

// WebSocket connections
wss.on('connection', (ws) => {
  console.log('🟢 WS client connected');

  let sessionId = null;
  let role = null;
  let deepgramLive = null;
  let deepgramReady = false;
  let chunkCount = 0;
  const audioQueue = [];

  const flushQueue = async () => {
    if (!deepgramLive || !deepgramReady) return;
    while (audioQueue.length > 0) {
      const chunk = audioQueue[0];
      try {
        const ok = deepgramLive.send(chunk);
        if (!ok) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        audioQueue.shift();
      } catch (err) {
        console.error("❌ Flush error:", err);
        break;
      }
    }
  };

  ws.on('message', async (msg, isBinary) => {
    try {
      if (!isBinary) {
        const data = JSON.parse(msg.toString());
        console.log("📩 Control message:", data);

        if (!data.type || !data.sessionId || !data.role) return;

        sessionId = data.sessionId;
        role = data.role;

        if (!sessions[sessionId]) {
          sessions[sessionId] = { lastActivity: Date.now() };
          console.log(`🆕 Session created: ${sessionId}`);
        }

        sessions[sessionId][role] = ws;
        sessions[sessionId].lastActivity = Date.now();

        ws.send(JSON.stringify({ type: 'joined', sessionId, role }));

        if (role === "spectator") {
          console.log(`🎤 Setting up Deepgram for spectator in session ${sessionId}`);

          deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-US',
            punctuate: true,
            interim_results: false,
            encoding: 'opus',
            sample_rate: 48000,
          });

          deepgramLive.on('open', () => {
            console.log("🔗 Deepgram connected");
            deepgramReady = true;
            flushQueue();
          });

          deepgramLive.on('close', () => {
            console.log("❌ Deepgram closed");
            deepgramReady = false;
          });

          deepgramLive.on('error', (err) => {
            console.error("❌ Deepgram error:", err);
            deepgramReady = false;
          });

          deepgramLive.on('transcriptReceived', (dgData) => {
            const transcript = dgData?.channel?.alternatives?.[0]?.transcript?.trim();
            if (transcript) {
              console.log(`📝 Transcript [${sessionId}]:`, transcript);

              if (sessions[sessionId]?.magician) {
                sessions[sessionId].magician.send(
                  JSON.stringify({ type: 'transcript', text: transcript })
                );
              }
            }
          });
        }
      } else {
        // Binary audio chunk from spectator
        chunkCount++;
        if (sessions[sessionId]) sessions[sessionId].lastActivity = Date.now();
        console.log(`🎵 Audio chunk #${chunkCount} (${msg.length} bytes)`);

        if (role === "spectator" && deepgramLive) {
          if (!deepgramReady) {
            audioQueue.push(msg);
            setTimeout(flushQueue, 50);
          } else {
            try {
              const ok = deepgramLive.send(msg);
              if (!ok) {
                console.warn("⚠️ send() returned false, queueing");
                audioQueue.push(msg);
                setTimeout(flushQueue, 50);
              }
            } catch (err) {
              console.error("❌ Send error:", err);
              audioQueue.push(msg);
            }
          }
        }
      }
    } catch (err) {
      console.error("⚠️ Message error:", err);
    }
  });

  ws.on('close', () => {
    console.log(`🔴 WS closed (role=${role}, session=${sessionId})`);
    if (sessions[sessionId]) delete sessions[sessionId][role];
    if (deepgramLive) deepgramLive.finish();
  });

  ws.on('error', (err) => console.error("❌ WS error:", err));
});

// HTTP endpoints
app.get('/health', (req, res) => res.json({ ok: true, sessions: Object.keys(sessions) }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
