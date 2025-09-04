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

// A simple way to manage sessions/rooms
const sessions = {};

wss.on('connection', async (ws) => {
    console.log('Client connected');

    let deepgramLive;
    let sessionId;
    let clientRole;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                sessionId = data.sessionId;
                clientRole = data.role;

                if (!sessions[sessionId]) {
                    sessions[sessionId] = {};
                }
                sessions[sessionId][clientRole] = ws;
                console.log(`Client joined session ${sessionId} as ${clientRole}`);

                if (clientRole === 'spectator') {
                    // ✅ v3 live transcription
                    deepgramLive = deepgram.listen.live({
                        model: 'nova-2',
                        language: 'en-US',
                        punctuate: true,
                        interimResults: true, // ✅ camelCase in v3
                    });

                    deepgramLive.on('open', () => console.log('✅ Deepgram connection opened'));
                    deepgramLive.on('close', () => console.log('❌ Deepgram connection closed'));
                    deepgramLive.on('error', (error) => console.error('Deepgram Error:', error));

                    // ✅ v3 event is "transcript"
                    deepgramLive.on('transcript', (dgResponse) => {
                        const transcript = dgResponse.channel.alternatives[0]?.transcript.trim();
                        if (transcript && sessions[sessionId] && sessions[sessionId].magician) {
                            console.log(`Sending transcript: "${transcript}" to magician.`);
                            sessions[sessionId].magician.send(JSON.stringify({
                                type: 'transcript',
                                word: transcript,
                            }));
                        }
                    });
                }
            }
        } catch (e) {
            // If message is not JSON, it's likely audio data
            if (clientRole === 'spectator' && deepgramLive && Buffer.isBuffer(message)) {
                deepgramLive.send(message);
            }
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
            deepgramLive.finish();
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`🔮 AI Magic Server is listening on port ${PORT}`);
});
