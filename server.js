require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sessions = {};

wss.on("connection", (ws) => {
  console.log("Client connected");

  let sessionId;
  let clientRole;
  let assemblyWs;

 ws.on('message', (message, isBinary) => {
  if (isBinary) {
    // Binary audio from AssemblyAI (usually for monitoring, can ignore)
    return;
  }

  try {
    const data = JSON.parse(message.toString());
    if (data.type === 'transcript') {
      console.log('Transcript:', data.text);
      // Send to spectators
    }
  } catch (err) {
    console.warn('Non-JSON message received, ignoring:', err.message);
  }
});


  ws.on("close", () => {
    console.log("Client disconnected");
    if (sessionId && clientRole && sessions[sessionId]) {
      delete sessions[sessionId][clientRole];
      if (Object.keys(sessions[sessionId]).length === 0) {
        delete sessions[sessionId];
      }
    }
    if (assemblyWs) assemblyWs.close();
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`🔮 Magic Server running on port ${PORT}`);
});
