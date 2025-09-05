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

// Function to setup Deepgram connection
function setupDeepgramConnection(sessionId, spectatorWs) {
    console.log(`🎧 Setting up Deepgram for session ${sessionId}`);

    let deepgramLive;
    let isConnected = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;

    const connect = () => {
        try {
            deepgramLive = deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                punctuate: true,
                interim_results: true, // Enable interim for better debugging
                encoding: 'opus',
                sample_rate: 48000,
            });

            deepgramLive.on('open', () => {
                console.log('🔗 Deepgram connection opened');
                isConnected = true;
                reconnectAttempts = 0;
                spectatorWs.send(JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' }));
            });

            deepgramLive.on('close', () => {
                console.log('❌ Deepgram connection closed');
                isConnected = false;

                // Try to reconnect if not exceeded max attempts
                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    console.log(`🔄 Attempting reconnect ${reconnectAttempts}/${maxReconnectAttempts}`);
                    setTimeout(connect, 2000);
                }
            });

            deepgramLive.on('error', (error) => {
                console.error('❌ Deepgram Error:', error);
                isConnected = false;
                spectatorWs.send(JSON.stringify({ type: 'error', message: 'Speech recognition error' }));
            });

            deepgramLive.on('transcriptReceived', (dgData) => {
                try {
                    console.log("📋 Raw Deepgram data:", JSON.stringify(dgData));

                    if (dgData.is_final && dgData.channel && dgData.channel.alternatives && dgData.channel.alternatives[0]) {
                        const transcript = dgData.channel.alternatives[0].transcript.trim();
                        if (transcript) {
                            console.log("✅ Final transcript received:", transcript);

                            // Send to magician
                            if (sessions[sessionId]?.magician) {
                                sessions[sessionId].magician.send(
                                    JSON.stringify({ type: 'transcript', word: transcript })
                                );
                                console.log(`📤 Sent transcript to magician: "${transcript}"`);
                            }

                            // Send confirmation to spectator
                            if (sessions[sessionId]?.spectator) {
                                sessions[sessionId].spectator.send(
                                    JSON.stringify({ type: 'transcript_sent', word: transcript })
                                );
                                console.log(`📩 Sent confirmation to spectator: "${transcript}"`);
                            }
                        }
                    } else if (dgData.channel && dgData.channel.alternatives && dgData.channel.alternatives[0]) {
                        // Log interim results for debugging
                        const interimTranscript = dgData.channel.alternatives[0].transcript.trim();
                        if (interimTranscript) {
                            console.log("🔊 Interim transcript:", interimTranscript);
                        }
                    }
                } catch (error) {
                    console.error('Error processing transcript:', error);
                }
            });

            return deepgramLive;
        } catch (error) {
            console.error('❌ Failed to create Deepgram connection:', error);
            spectatorWs.send(JSON.stringify({ type: 'error', message: 'Failed to initialize speech recognition' }));
            return null;
        }
    };

    return connect();
}

wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');

    let deepgramLive = null;
    let sessionId;
    let clientRole;

    wss.on('connection', (ws) => {
        console.log('🟢 New WebSocket client connected');

        let deepgramLive = null;
        let sessionId;
        let clientRole;

        ws.on('message', async (message, isBinary) => {
            try {
                if (!isBinary) {
                    const data = JSON.parse(message.toString());
                    console.log("📩 Control message received:", data);

                    if (data.type === 'join') {
                        sessionId = data.sessionId;
                        clientRole = data.role;

                        if (!sessions[sessionId]) sessions[sessionId] = {};
                        sessions[sessionId][clientRole] = ws;
                        console.log(`✅ Client joined session ${sessionId} as ${clientRole}`);

                        // Send confirmation to client
                        ws.send(JSON.stringify({
                            type: 'joined',
                            sessionId,
                            role: clientRole,
                            message: `Successfully joined as ${clientRole}`
                        }));

                        if (clientRole === 'spectator') {
                            // Setup Deepgram for spectator
                            deepgramLive = setupDeepgramConnection(sessionId, ws);
                        }
                    }
                    // ADD THIS SECTION TO HANDLE TEST MESSAGES
                    else if (data.type === 'test') {
                        console.log("🧪 Test message received from", clientRole, ":", data.word);

                        // Forward test messages to the magician in the same session
                        if (sessionId && sessions[sessionId]?.magician) {
                            sessions[sessionId].magician.send(
                                JSON.stringify({
                                    type: 'transcript',
                                    word: `${data.message}`,
                                    isTest: true,
                                    timestamp: data.timestamp || Date.now()
                                })
                            );
                            console.log(`📤 Forwarded test message to magician: "${data.message}"`);
                        }

                        // Also send confirmation back to the sender
                        ws.send(JSON.stringify({
                            type: 'test_result',
                            success: true,
                            message: `Test message "${data.message}" forwarded to magician`
                        }));
                    }
                } else {
                    // Audio chunks from spectator
                    if (clientRole === 'spectator' && deepgramLive) {
                        try {
                            // Convert to Uint8Array if needed
                            const audioData = message instanceof Buffer ? new Uint8Array(message) : message;

                            // Send to Deepgram
                            deepgramLive.send(audioData);
                            console.log('🎵 Audio chunk sent to Deepgram:', audioData.byteLength, 'bytes');
                        } catch (error) {
                            console.error('❌ Error sending to Deepgram:', error);
                        }
                    }
                }
            } catch (err) {
                console.error("⚠️ Message handling error:", err);

                // Send error response back to client
                try {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Failed to process message',
                        error: err.message
                    }));
                } catch (e) {
                    console.error('Could not send error response:', e);
                }
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 AI Magic Server is listening on port ${PORT}`);
    console.log(`🔑 Deepgram API Key: ${deepgramApiKey ? 'Loaded' : 'Missing'}`);
});