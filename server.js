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
  console.error("❌ Deepgram API Key is missing. Please check your .env file.");
  process.exit(1);
}

const deepgram = createClient(deepgramApiKey);
const sessions = {};

// Session cleanup interval
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const sessionId in sessions) {
    // Remove sessions older than 1 hour
    if (sessions[sessionId].lastActivity && now - sessions[sessionId].lastActivity > 3600000) {
      console.log(`🧹 Cleaning up expired session: ${sessionId}`);
      delete sessions[sessionId];
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} expired sessions`);
  }
}, 60000); // Check every minute

wss.on('connection', (ws) => {
  console.log('🟢 New WebSocket client connected');

  let deepgramLive;
  let sessionId;
  let clientRole;

  ws.on('message', async (message, isBinary) => {
    try {
      if (!isBinary) {
        // 📦 JSON control message
        const data = JSON.parse(message.toString());
        console.log("📩 Control message received:", data);

        // Validate input
        if (!data.type || !data.sessionId || !data.role) {
          ws.send(JSON.stringify({ error: "Invalid message format" }));
          return;
        }

        if (data.type === 'join') {
          // Validate session ID format (alphanumeric, 6 chars)
          if (!/^[a-z0-9]{6}$/i.test(data.sessionId)) {
            ws.send(JSON.stringify({ error: "Invalid session ID" }));
            return;
          }
          
          // Validate role
          if (!['magician', 'spectator'].includes(data.role)) {
            ws.send(JSON.stringify({ error: "Invalid role" }));
            return;
          }
          
          sessionId = data.sessionId;
          clientRole = data.role;

          if (!sessions[sessionId]) {
            sessions[sessionId] = {
              lastActivity: Date.now()
            };
            console.log(`🆕 New session created: ${sessionId}`);
          }
          
          sessions[sessionId][clientRole] = ws;
          sessions[sessionId].lastActivity = Date.now();
          
          console.log(`✅ Client joined session ${sessionId} as ${clientRole}`);
          
          // Send confirmation to client
          ws.send(JSON.stringify({ 
            type: 'joined', 
            sessionId, 
            role: clientRole,
            message: `Successfully joined as ${clientRole}`
          }));

          if (clientRole === 'spectator') {
            console.log(`🎧 Setting up Deepgram for spectator in session ${sessionId}`);
            
            // 🔧 Tell Deepgram what encoding we're streaming
            deepgramLive = deepgram.listen.live({
              model: 'nova-2',
              language: 'en-US',
              punctuate: true,
              interim_results: false,  // We only want final results
              encoding: 'opus',
              sample_rate: 48000,
            });

            deepgramLive.on('open', () => {
              console.log('🔗 Deepgram connection opened');
              ws.send(JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' }));
            });
            
            deepgramLive.on('close', () => {
              console.log('❌ Deepgram connection closed');
            });
            
            deepgramLive.on('error', (error) => {
              console.error('❌ Deepgram Error:', error);
              if (sessions[sessionId]?.spectator) {
                sessions[sessionId].spectator.send(
                  JSON.stringify({ type: 'error', message: 'Speech recognition service unavailable' })
                );
              }
            });

            // Handle transcript data
            deepgramLive.on('transcriptReceived', (dgData) => {
              try {
                const transcript = dgData.channel.alternatives[0].transcript.trim();
                if (transcript) {
                  console.log("📝 Deepgram transcript received:", transcript);
                  
                  if (sessions[sessionId]?.magician) {
                    sessions[sessionId].magician.send(
                      JSON.stringify({ type: 'transcript', word: transcript })
                    );
                    console.log(`📤 Sent transcript to magician: "${transcript}"`);
                  }
                }
              } catch (error) {
                console.error('Error processing transcript:', error);
              }
            });
            
            deepgramLive.on('metadata', (metadata) => {
              console.log('🔊 Deepgram metadata:', metadata);
            });
          }
        }
      } else {
        // 🎧 Binary = audio chunks from spectator
        if (clientRole === 'spectator' && deepgramLive) {
          // Update session activity timestamp
          if (sessions[sessionId]) {
            sessions[sessionId].lastActivity = Date.now();
          }
          
          // Send audio to Deepgram
          deepgramLive.send(message);
          console.log('🎵 Audio chunk sent to Deepgram:', message.byteLength, 'bytes');
        }
      }
    } catch (err) {
      console.error("⚠️ Message handling error:", err);
      ws.send(JSON.stringify({ error: "Message processing failed" }));
    }
  });

  ws.on('close', () => {
    console.log(`🔴 Client disconnected from session ${sessionId} (role: ${clientRole})`);
    if (sessionId && clientRole && sessions[sessionId]) {
      delete sessions[sessionId][clientRole];
      if (Object.keys(sessions[sessionId]).length === 1) { // Only lastActivity remains
        console.log(`🗑️ Session ${sessionId} is empty, marking for cleanup`);
      }
    }
    if (deepgramLive) {
      deepgramLive.finish();
      console.log('🎤 Deepgram connection finished');
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    activeSessions: Object.keys(sessions).length 
  });
});

// Get session info endpoint
app.get('/sessions', (req, res) => {
  const sessionInfo = {};
  for (const sessionId in sessions) {
    sessionInfo[sessionId] = {
      roles: Object.keys(sessions[sessionId]).filter(key => key !== 'lastActivity'),
      lastActivity: new Date(sessions[sessionId].lastActivity).toISOString()
    };
  }
  
  res.status(200).json(sessionInfo);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 AI Magic Server is listening on port ${PORT}`);
  console.log(`🔑 Deepgram API Key: ${deepgramApiKey ? 'Loaded' : 'Missing'}`);
});