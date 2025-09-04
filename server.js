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

const deepgram = createClient(deepgramApiKey);
const sessions = {};

wss.on('connection', (ws) => {
    console.log('Client connected');

    let deepgramLive;
    let sessionId;
    let clientRole;

    ws.on('message', async (message, isBinary) => {
        try {
            if (!isBinary) {
                // handle JSON messages
                const data = JSON.parse(message.toString());

                if (data.type === 'join') {
                    sessionId = data.sessionId;
                    clientRole = data.role;

                    if (!sessions[sessionId]) sessions[sessionId] = {};
                    sessions[sessionId][clientRole] = ws;
                    console.log(`Client joined session ${sessionId} as ${clientRole}`);

                    if (clientRole === 'spectator') {
                        deepgramLive = deepgram.listen.live({
                            model: 'nova-2',
                            language: 'en-US',
                            punctuate: true,
                            interim_results: true,
                        });

                        deepgramLive.on('open', () => console.log('✅ Deepgram connection opened'));
                        deepgramLive.on('close', () => console.log('❌ Deepgram connection closed'));
                        deepgramLive.on('error', (error) => console.error('Deepgram Error:', error));

                        // ✅ event is 'transcript'
                        deepgramLive.on('transcript', (dgData) => {
                            const transcript = dgData.channel.alternatives[0].transcript.trim();
                            if (transcript && sessions[sessionId]?.magician) {
                                sessions[sessionId].magician.send(
                                    JSON.stringify({ type: 'transcript', word: transcript })
                                );
                            }
                        });
                    }
                }
            } else {
                // handle binary audio chunks
                if (clientRole === 'spectator' && deepgramLive) {
                    deepgramLive.send(message);
                }
            }
        } catch (err) {
            console.error("Message handling error:", err);
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
        if (deepgramLive) deepgramLive.finish();
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🔮 AI Magic Server is listening on port ${PORT}`);
});
