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

// ✅ v3 initialization
const deepgram = createClient(deepgramApiKey);

// Session store
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
            if (parsed.type === 'join') {
                sessionId = parsed.sessionId;
                clientRole = parsed.role;

                if (!sessions[sessionId]) {
                    sessions[sessionId] = {};
                }
                sessions[sessionId][clientRole] = ws;
                console.log(`Client joined session ${sessionId} as ${clientRole}`);

                if (clientRole === 'spectator') {
                    // ✅ create Deepgram live connection
                    deepgramLive = deepgram.listen.live({
                        model: 'nova-2',
                        language: 'en-US',
                        punctuate: true,
                        interimResults: true,
                    });

                    deepgramLive.on('open', () => console.log('✅ Deepgram connection opened'));
                    deepgramLive.on('close', () => console.log('❌ Deepgram connection closed'));
                    deepgramLive.on('error', (error) => console.error('Deepgram Error:', error));

                    // ✅ Listen only for final transcripts
                    deepgramLive.on('transcript', (dgResponse) => {
                        const transcript = dgResponse.channel.alternatives[0].transcript.trim();
                        const isFinal = dgResponse.is_final;

                        if (transcript && isFinal) {
                            console.log(`[Spectator ${sessionId}]: ${transcript}`);

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

    ws.on('close', () => {
        console.log('Client disconnected');
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
            }
        }
        if (deepgramLive) {
            deepgramLive.finish(); // ✅ correct close method
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🔮 AI Magic Server is listening on port ${PORT}`);
});
