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

wss.on('connection', (ws) => {
  console.log('🟢 New WebSocket client connected');

  let deepgramLive = null;
  let sessionId;
  let clientRole;
  let deepgramReady = false;

  ws.on('message', async (message, isBinary) => {
    try {
      if (!isBinary) {
        // 📦 JSON control message
        const data = JSON.parse(message.toString());
        console.log("📩 Control message received:", data);

        if (data.type === 'join') {
          sessionId = data.sessionId;
          clientRole = data.role;

          if (!sessions[sessionId]) sessions[sessionId] = {};
          sessions[sessionId][clientRole] = ws;
          console.log(`✅ Client joined session ${sessionId} as ${clientRole}`);

          if (clientRole === 'spectator') {
            // 🔧 Setup Deepgram connection
            console.log(`🎧 Setting up Deepgram for spectator in session ${sessionId}`);
            
            try {
              deepgramLive = deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                punctuate: true,
                interim_results: false,
                encoding: 'opus',
                sample_rate: 48000,
              });

              deepgramLive.on('open', () => {
                console.log('🔗 Deepgram connection opened');
                deepgramReady = true;
                ws.send(JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' }));
              });

              deepgramLive.on('close', () => {
                console.log('❌ Deepgram connection closed');
                deepgramReady = false;
              });

              deepgramLive.on('error', (error) => {
                console.error('❌ Deepgram Error:', error);
                deepgramReady = false;
                ws.send(JSON.stringify({ type: 'error', message: 'Speech recognition error' }));
              });

              // ✅ Log actual transcripts
              deepgramLive.on('transcriptReceived', (dgData) => {
                try {
                  if (dgData.channel && dgData.channel.alternatives && dgData.channel.alternatives[0]) {
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
                  }
                } catch (error) {
                  console.error('Error processing transcript:', error);
                }
              });

            } catch (error) {
              console.error('❌ Failed to create Deepgram connection:', error);
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize speech recognition' }));
            }
          }
        }
      } else {
        // 🎧 Binary = audio chunks from spectator
        if (clientRole === 'spectator' && deepgramLive && deepgramReady) {
          try {
            // Convert Buffer to Uint8Array if needed
            const audioData = message instanceof Buffer ? new Uint8Array(message) : message;
            
            // Send audio to Deepgram
            deepgramLive.send(audioData);
            console.log('🎵 Audio chunk sent to Deepgram:', audioData.byteLength, 'bytes');
            
          } catch (error) {
            console.error('❌ Error sending to Deepgram:', error);
            // Try to reconnect Deepgram
            deepgramReady = false;
            setTimeout(() => {
              if (sessions[sessionId]?.spectator) {
                sessions[sessionId].spectator.send(
                  JSON.stringify({ type: 'error', message: 'Reconnecting speech recognition...' })
                );
              }
            }, 1000);
          }
        } else if (clientRole === 'spectator' && (!deepgramLive || !deepgramReady)) {
          console.log('⚠️ Deepgram not ready, skipping audio chunk');
        }
      }
    } catch (err) {
      console.error("⚠️ Message handling error:", err);
    }
  });

  ws.on('close', () => {
    console.log('🔴 Client disconnected');
    if (sessionId && clientRole && sessions[sessionId]) {
      delete sessions[sessionId][clientRole];
      if (Object.keys(sessions[sessionId]).length === 0) {
        delete sessions[sessionId];
      }
    }
    if (deepgramLive) {
      try {
        deepgramLive.finish();
        console.log('🎤 Deepgram connection finished');
      } catch (e) {
        console.error('Error finishing Deepgram connection:', e);
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    activeSessions: Object.keys(sessions).length 
  });
});

// Deepgram status endpoint
app.get('/deepgram-status', (req, res) => {
  res.status(200).json({ 
    status: 'Deepgram connected', 
    apiKey: deepgramApiKey ? 'Present' : 'Missing'
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 AI Magic Server is listening on port ${PORT}`);
  console.log(`🔑 Deepgram API Key: ${deepgramApiKey ? 'Loaded' : 'Missing'}`);
});