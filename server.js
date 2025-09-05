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
    console.error("Deepgram API Key is missing. Please check your .env file.");
    process.exit(1);
}

// v3 initialization
const deepgram = createClient(deepgramApiKey);

// A simple way to manage sessions/rooms
const sessions = {};

wss.on('connection', async (ws) => {
    console.log('Client connected');

    let deepgramLive;
    let sessionId;
    let clientRole;

    ws.on('message', async (message) => {
        let parsed;
        try {
            parsed = JSON.parse(message);
        } catch {
            parsed = null;
        }

        if (parsed) {
            // Handle JSON messages
            if (parsed.type === 'join') {
                sessionId = parsed.sessionId;
                clientRole = parsed.role;

                if (!sessions[sessionId]) {
                    sessions[sessionId] = {};
                }
                sessions[sessionId][clientRole] = ws;
                console.log(`Client joined session ${sessionId} as ${clientRole}`);

                if (clientRole === 'spectator') {
                    // v3 live transcription
                    deepgramLive = deepgram.listen.live({
                        model: 'nova-2',
                        language: 'en-US',
                        punctuate: true,
                        interimResults: true,
                    });

                    deepgramLive.on('open', () => console.log('✅ Deepgram connection opened'));
                    deepgramLive.on('close', () => console.log('❌ Deepgram connection closed'));
                    deepgramLive.on('error', (error) => console.error('Deepgram Error:', error));

                    // v3 event is "transcript"
                    deepgramLive.on('transcript', (dgResponse) => {
                        const transcript = dgResponse.channel.alternatives[0].transcript.trim();

                        if (transcript) {
                            // Log spectator speech live on server console
                            console.log(`[Spectator ${sessionId}]: ${transcript}`);
                            // Still forward to magician
                            if (sessions[sessionId]?.magician) {
                                sessions[sessionId].magician.send(
                                    JSON.stringify({
                                        type: 'transcript',
                                        word: transcript,
                                    })
                                );
                            }
                        }
                    });

                }
            }
        } else if (clientRole === 'spectator' && deepgramLive && Buffer.isBuffer(message)) {
            // Forward audio buffer to Deepgram
            deepgramLive.send(message);
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected');
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
            }
        }
        if (deepgramLive) {
            deepgramLive.finish();
        }
    });

});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🔮 AI Magic Server is listening on port ${PORT}`);
});
