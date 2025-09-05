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

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      // Handle join
      if (data.type === "join") {
        sessionId = data.sessionId;
        clientRole = data.role;

        if (!sessions[sessionId]) sessions[sessionId] = {};
        sessions[sessionId][clientRole] = ws;

        console.log(`Client joined session ${sessionId} as ${clientRole}`);

        if (clientRole === "spectator") {
          // Connect to AssemblyAI realtime
          assemblyWs = new WebSocket(
            "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=48000",
            {
              headers: { Authorization: process.env.ASSEMBLYAI_API_KEY },
            }
          );

          assemblyWs.on("open", () => console.log("✅ AssemblyAI connection opened"));
          assemblyWs.on("close", () => console.log("❌ AssemblyAI connection closed"));
          assemblyWs.on("error", (err) => console.error("AssemblyAI Error:", err));

          // Receive transcript from AssemblyAI
          assemblyWs.on("message", (msg) => {
            const res = JSON.parse(msg.toString());
            if (res.text && sessions[sessionId] && sessions[sessionId].magician) {
              console.log("🎤 Transcript:", res.text);
              sessions[sessionId].magician.send(
                JSON.stringify({ type: "transcript", word: res.text })
              );
            }
          });
        }
      }

      // Handle audio chunks from spectator
      if (data.type === "audio" && clientRole === "spectator" && assemblyWs?.readyState === WebSocket.OPEN) {
        assemblyWs.send(JSON.stringify({ audio_data: data.data }));
      }
    } catch (err) {
      console.error("Message parse error:", err);
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
