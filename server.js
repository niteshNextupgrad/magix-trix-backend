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

  let deepgramLive = null;
  let sessionId;
  let clientRole;
  let audioChunksCount = 0;
  let isDeepgramReady = false;
  let audioBuffer = [];

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
            
            // Initialize Deepgram connection
            setupDeepgram();
          }
        }
      } else {
        // 🎧 Binary = audio chunks from spectator
        if (clientRole === 'spectator') {
          // Update session activity timestamp
          if (sessions[sessionId]) {
            sessions[sessionId].lastActivity = Date.now();
          }
          
          audioChunksCount++;
          console.log(`🎵 Audio chunk #${audioChunksCount} received: ${message.byteLength} bytes`);
          
          // Send audio to Deepgram if ready, otherwise buffer it
          if (isDeepgramReady && deepgramLive) {
            try {
              const success = deepgramLive.send(message);
              if (!success) {
                console.error('❌ Failed to send audio to Deepgram - connection may be closed');
                // Try to reconnect Deepgram
                setupDeepgram();
                // Buffer this chunk for later sending
                audioBuffer.push(message);
              } else {
                console.log(`✅ Audio chunk #${audioChunksCount} sent to Deepgram`);
              }
            } catch (error) {
              console.error('❌ Error sending to Deepgram:', error);
              // Buffer this chunk for later sending
              audioBuffer.push(message);
            }
          } else {
            console.log(`📦 Buffering audio chunk #${audioChunksCount} (Deepgram not ready)`);
            audioBuffer.push(message);
          }
        }
      }
    } catch (err) {
      console.error("⚠️ Message handling error:", err);
      ws.send(JSON.stringify({ error: "Message processing failed" }));
    }
  });

  // Function to set up Deepgram connection
  function setupDeepgram() {
    // Close existing connection if any
    if (deepgramLive) {
      try {
        deepgramLive.finish();
      } catch (e) {
        console.error('Error finishing previous Deepgram connection:', e);
      }
    }
    
    // Reset state
    isDeepgramReady = false;
    audioBuffer = [];
    
    console.log('🔄 Setting up new Deepgram connection...');
    
    // Create new Deepgram connection
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
      isDeepgramReady = true;
      
      // Send buffered audio if any
      if (audioBuffer.length > 0) {
        console.log(`📤 Sending ${audioBuffer.length} buffered audio chunks to Deepgram`);
        for (const chunk of audioBuffer) {
          try {
            const success = deepgramLive.send(chunk);
            if (!success) {
              console.error('❌ Failed to send buffered audio to Deepgram');
              break;
            }
          } catch (error) {
            console.error('❌ Error sending buffered audio to Deepgram:', error);
            break;
          }
        }
        audioBuffer = [];
      }
      
      if (sessions[sessionId]?.spectator) {
        sessions[sessionId].spectator.send(
          JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' })
        );
      }
    });
    
    deepgramLive.on('close', () => {
      console.log('❌ Deepgram connection closed');
      isDeepgramReady = false;
    });
    
    deepgramLive.on('error', (error) => {
      console.error('❌ Deepgram Error:', error);
      isDeepgramReady = false;
      
      if (sessions[sessionId]?.spectator) {
        sessions[sessionId].spectator.send(
          JSON.stringify({ type: 'error', message: 'Speech recognition service unavailable' })
        );
      }
    });

    // Handle transcript data
    deepgramLive.on('transcriptReceived', (dgData) => {
      try {
        console.log("📋 Raw Deepgram data:", JSON.stringify(dgData));
        
        if (dgData.channel && dgData.channel.alternatives && dgData.channel.alternatives[0]) {
          const transcript = dgData.channel.alternatives[0].transcript.trim();
          if (transcript) {
            console.log("📝 Deepgram transcript received:", transcript);
            
            if (sessions[sessionId]?.magician) {
              sessions[sessionId].magician.send(
                JSON.stringify({ type: 'transcript', word: transcript })
              );
              console.log(`📤 Sent transcript to magician: "${transcript}"`);
              
              // Also send confirmation to spectator
              if (sessions[sessionId]?.spectator) {
                sessions[sessionId].spectator.send(
                  JSON.stringify({ type: 'transcript_sent', word: transcript })
                );
              }
            }
          } else {
            console.log("📝 Empty transcript received (might be background noise)");
          }
        } else {
          console.log("📝 No transcript in Deepgram response");
        }
      } catch (error) {
        console.error('Error processing transcript:', error);
      }
    });
    
    deepgramLive.on('metadata', (metadata) => {
      console.log('🔊 Deepgram metadata:', metadata);
    });
  }

  ws.on('close', () => {
    console.log(`🔴 Client disconnected from session ${sessionId} (role: ${clientRole})`);
    console.log(`📊 Total audio chunks received: ${audioChunksCount}`);
    if (sessionId && clientRole && sessions[sessionId]) {
      delete sessions[sessionId][clientRole];
      if (Object.keys(sessions[sessionId]).length === 1) { // Only lastActivity remains
        console.log(`🗑️ Session ${sessionId} is empty, marking for cleanup`);
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