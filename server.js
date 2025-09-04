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

// Session cleanup interval (optional)
setInterval(() => {
    const now = Date.now();
    for (const sessionId in sessions) {
        if (sessions[sessionId].lastActivity && now - sessions[sessionId].lastActivity > 3600000) {
            console.log(`🧹 Cleaning up expired session: ${sessionId}`);
            delete sessions[sessionId];
        }
    }
}, 60000);

// Helper: small async sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

wss.on('connection', (ws) => {
    console.log('🟢 New WebSocket client connected');

    let deepgramLive = null;
    let deepgramReady = false;
    let sessionId = null;
    let clientRole = null;
    let audioChunksCount = 0;

    // queue for audio chunks that couldn't be sent immediately
    const audioQueue = [];

    // flush queue: try to send queued chunks until empty or send() indicates failure
    const flushQueue = async () => {
        if (!deepgramLive || !deepgramReady) return;
        while (audioQueue.length > 0) {
            const chunk = audioQueue[0];
            try {
                const ok = deepgramLive.send(chunk);
                if (!ok) {
                    // backpressure: stop flushing and retry later
                    // wait a bit then try again
                    await sleep(50);
                    continue;
                } else {
                    // sent -> remove from queue
                    audioQueue.shift();
                }
            } catch (err) {
                console.error('❌ Error while flushing audio queue to Deepgram:', err);
                // if fatal, break to avoid tight loop
                await sleep(100);
            }
        }
    };

    ws.on('message', async (message, isBinary) => {
        try {
            if (!isBinary) {
                // Control message
                const data = JSON.parse(message.toString());
                console.log("📩 Control message received:", data);

                if (!data.type || !data.sessionId || !data.role) {
                    ws.send(JSON.stringify({ error: "Invalid message format" }));
                    return;
                }

                // only allow simple session id pattern
                if (!/^[a-z0-9]{6}$/i.test(data.sessionId)) {
                    ws.send(JSON.stringify({ error: "Invalid session ID" }));
                    return;
                }
                if (!['magician', 'spectator'].includes(data.role)) {
                    ws.send(JSON.stringify({ error: "Invalid role" }));
                    return;
                }

                sessionId = data.sessionId;
                clientRole = data.role;

                if (!sessions[sessionId]) {
                    sessions[sessionId] = { lastActivity: Date.now() };
                    console.log(`🆕 New session created: ${sessionId}`);
                }
                sessions[sessionId][clientRole] = ws;
                sessions[sessionId].lastActivity = Date.now();

                console.log(`✅ Client joined session ${sessionId} as ${clientRole}`);
                ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole, message: `Joined as ${clientRole}` }));

                if (clientRole === 'spectator') {
                    console.log(`🎧 Setting up Deepgram listen.live() for session ${sessionId}`);

                    // create deepgram live connection for this spectator
                    deepgramLive = deepgram.listen.live({
                        model: 'nova-2',
                        language: 'en-US',
                        punctuate: true,
                        // interimResults can be true/false depending on whether you want partials
                        interimResults: false,
                        // If your frontend records WebM/Opus (MediaRecorder), this is appropriate:
                        encoding: 'opus',      // using 'opus' works for WebM/Opus chunks in many setups
                        sample_rate: 48000,    // typical for browser Opus/WebM
                    });

                    deepgramReady = false;

                    deepgramLive.on('open', () => {
                        console.log('🔗 Deepgram connection opened for session', sessionId);
                        deepgramReady = true;
                        ws.send(JSON.stringify({ type: 'deepgram_ready', message: 'Deepgram ready' }));
                        // flush any queued chunks
                        void flushQueue();
                    });

                    deepgramLive.on('close', () => {
                        console.log('❌ Deepgram connection closed for session', sessionId);
                        deepgramReady = false;
                    });

                    deepgramLive.on('error', (error) => {
                        console.error('❌ Deepgram Error for session', sessionId, error);
                        deepgramReady = false;
                        // inform spectator
                        if (sessions[sessionId]?.spectator) {
                            sessions[sessionId].spectator.send(
                                JSON.stringify({ type: 'error', message: 'Speech recognition service error' })
                            );
                        }
                    });

                    // transcriptReceived contains recognized text
                    deepgramLive.on('transcriptReceived', (dgData) => {
                        try {
                            const alt = dgData?.channel?.alternatives?.[0];
                            const transcript = alt?.transcript?.trim();
                            if (transcript) {
                                console.log('📝 Deepgram transcript for session', sessionId, ':', transcript);
                                // send to magician if connected
                                if (sessions[sessionId]?.magician) {
                                    sessions[sessionId].magician.send(JSON.stringify({ type: 'transcript', word: transcript }));
                                }
                                // optional: notify spectator that transcript was captured
                                if (sessions[sessionId]?.spectator) {
                                    sessions[sessionId].spectator.send(JSON.stringify({ type: 'transcript_sent', word: transcript }));
                                }
                            } else {
                                // we can ignore empty transcripts
                            }
                        } catch (err) {
                            console.error('Error processing Deepgram transcript:', err);
                        }
                    });

                    // optional: metadata/processing events for debugging
                    deepgramLive.on('metadata', (m) => console.log('🔊 Deepgram metadata:', m));
                    deepgramLive.on('processing', (p) => console.log('🔊 Deepgram processing:', p));
                }
            } else {
                // Binary audio chunk from spectator
                // message is a Buffer (Node WebSocket) when isBinary === true
                audioChunksCount++;
                sessions[sessionId] && (sessions[sessionId].lastActivity = Date.now());
                console.log(`🎵 Audio chunk #${audioChunksCount} received (${message.byteLength || message.length} bytes)`);

                if (clientRole === 'spectator' && deepgramLive) {
                    // if not ready, push to queue
                    if (!deepgramReady) {
                        audioQueue.push(message);
                        // also attempt to flush after short delay in case open happens quickly
                        setTimeout(() => void flushQueue(), 50);
                    }
                    else {
                        // Binary audio chunk from spectator
                        audioChunksCount++;
                        sessions[sessionId] && (sessions[sessionId].lastActivity = Date.now());
                        console.log(`🎵 Audio chunk #${audioChunksCount} received (${message.byteLength || message.length} bytes)`);

                        if (clientRole === 'spectator' && deepgramLive) {
                            // if not ready, push to queue
                            if (!deepgramReady) {
                                audioQueue.push(message);
                                // also attempt to flush after short delay in case open happens quickly
                                setTimeout(() => void flushQueue(), 50);
                                return;   // ✅ instead of "continue"
                            }

                            // try to send immediately; if send returns false, queue it
                            try {
                                const sentOk = deepgramLive.send(message);
                                if (!sentOk) {
                                    console.warn('⚠️ deepgramLive.send returned false -> queuing chunk for retry');
                                    audioQueue.push(message);
                                    // schedule a flush attempt
                                    setTimeout(() => void flushQueue(), 50);
                                }
                            } catch (err) {
                                console.error('❌ Exception when sending audio to Deepgram:', err);
                                audioQueue.push(message);
                                setTimeout(() => void flushQueue(), 100);
                            }
                        } else {
                            // Not the right role or deepgram not set up yet -> buffer
                            if (!deepgramLive) {
                                console.warn('⚠️ Received audio but Deepgram not initialized yet — buffering');
                                audioQueue.push(message);
                                setTimeout(() => void flushQueue(), 50);
                            }
                        }
                    }


                    // try to send immediately; if send returns false, queue it
                    try {
                        const sentOk = deepgramLive.send(message);
                        if (!sentOk) {
                            console.warn('⚠️ deepgramLive.send returned false -> queuing chunk for retry');
                            audioQueue.push(message);
                            // schedule a flush attempt
                            setTimeout(() => void flushQueue(), 50);
                        }
                    } catch (err) {
                        console.error('❌ Exception when sending audio to Deepgram:', err);
                        // queue so we can retry later (unless connection closed)
                        audioQueue.push(message);
                        setTimeout(() => void flushQueue(), 100);
                    }
                } else {
                    // Not the right role or deepgram not set up yet -> drop or queue
                    if (!deepgramLive) {
                        console.warn('⚠️ Received audio but Deepgram not initialized yet — buffering');
                        audioQueue.push(message);
                        setTimeout(() => void flushQueue(), 50);
                    }
                }
            }
        } catch (err) {
            console.error("⚠️ Message handling error:", err);
            try { ws.send(JSON.stringify({ error: "Message processing failed" })); } catch (e) {/*ignore*/ }
        }
    });

    ws.on('close', () => {
        console.log(`🔴 Client disconnected from session ${sessionId} (role: ${clientRole})`);
        console.log(`📊 Total audio chunks received this connection: ${audioChunksCount}`);

        // cleanup session role
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            // keep lastActivity entry for monitoring or cleanup
        }

        // finish Deepgram stream so it processes remaining queued audio
        if (deepgramLive) {
            try {
                deepgramLive.finish();
                console.log('🎤 Called deepgramLive.finish() for session', sessionId);
            } catch (err) {
                console.error('❌ Error calling deepgramLive.finish():', err);
            }
        }
    });

    ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err);
    });
});

// simple endpoints for health
app.get('/health', (_, res) => res.json({ status: 'OK', sessions: Object.keys(sessions).length }));
app.get('/sessions', (_, res) => res.json(Object.keys(sessions)));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 AI Magic Server listening on port ${PORT}`);
});
