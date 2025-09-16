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

// Store speech history for each session
const speechHistory = {};

// Function to summarize text using Deepgram's API
async function summarizeTextWithDeepgram(text) {
    // console.log(typeof text);

    // console.log("text_to _get_topics:: ", text);

    try {
        const response = await deepgram.read.analyzeText(
            { text },
            {
                language: 'en',
                summarize: 'v2',
                topics: true,
            }
        );

        const { results } = response.result;
        console.log("Deepgram Results:", JSON.stringify(results, null, 2));

        // Extract summary
        const summary = results.summary?.text || "No summary available.";

        // Extract topics safely
        let topics = [];
        if (results.topics?.segments?.length > 0) {
            topics = results.topics.segments.flatMap(seg =>
                (seg.topics || []).map(t => t.topic)
            );
        }

        return { summary, topics };
    } catch (error) {
        console.error('Error summarizing text with Deepgram:', error);
        return { summary: "Sorry, I couldn't summarize the text at this time.", topics: [] };
    }
}


// Function to setup Deepgram connection for real-time transcription
function setupDeepgramConnection(sessionId, spectatorWs) {
    // console.log(`🎧 Setting up Deepgram for session ${sessionId}`);

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
                interim_results: true,
                encoding: 'opus',
                sample_rate: 48000,
            });

            deepgramLive.on('open', () => {
                // console.log('🔗 Deepgram connection opened');
                isConnected = true;
                reconnectAttempts = 0;
                spectatorWs.send(JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' }));
            });

            deepgramLive.on('close', () => {
                // console.log('Deepgram connection closed');
                isConnected = false;

                if (reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    // console.log(`🔄 Attempting reconnect ${reconnectAttempts}/${maxReconnectAttempts}`);
                    setTimeout(connect, 2000);
                }
            });

            deepgramLive.on('error', (error) => {
                console.error('Deepgram Error:', error);
                isConnected = false;
                spectatorWs.send(JSON.stringify({ type: 'error', message: 'Speech recognition error' }));
            });

            deepgramLive.on('transcriptReceived', (dgData) => {
                try {
                    if (dgData.is_final && dgData.channel && dgData.channel.alternatives && dgData.channel.alternatives[0]) {
                        const transcript = dgData.channel.alternatives[0].transcript.trim();
                        if (transcript) {
                            // console.log("✅ Final transcript received:", transcript);

                            // Store the transcript in speech history
                            if (!speechHistory[sessionId]) {
                                speechHistory[sessionId] = [];
                            }
                            speechHistory[sessionId].push(transcript);

                            if (sessions[sessionId]?.magician) {
                                sessions[sessionId].magician.send(
                                    JSON.stringify({ type: 'transcript', word: transcript })
                                );
                                // console.log(`📤 Sent transcript to magician: "${transcript}"`);
                            }

                            if (sessions[sessionId]?.spectator) {
                                sessions[sessionId].spectator.send(
                                    JSON.stringify({ type: 'transcript_sent', word: transcript })
                                );
                            }
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

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');

    let deepgramLive = null;
    let sessionId;
    let clientRole;

    ws.on('message', async (message, isBinary) => {
        try {
            if (!isBinary) {
                const data = JSON.parse(message.toString());
                console.log("Control message received:", data);

                if (data.type === 'join') {
                    sessionId = data.sessionId;
                    clientRole = data.role;

                    if (!sessions[sessionId]) sessions[sessionId] = {};
                    sessions[sessionId][clientRole] = ws;
                    console.log(`Client joined session ${sessionId} as ${clientRole}`);

                    ws.send(JSON.stringify({
                        type: 'joined',
                        sessionId,
                        role: clientRole,
                        message: `Successfully joined as ${clientRole}`
                    }));

                    if (clientRole === 'spectator') {
                        deepgramLive = setupDeepgramConnection(sessionId, ws);
                    }
                }
                else if (data.type === 'test') {
                    console.log("Test message received from", clientRole, ":", data.message);

                    if (sessionId && sessions[sessionId]?.magician) {
                        sessions[sessionId].magician.send(
                            JSON.stringify({
                                type: 'transcript',
                                word: `${data.message}`,
                                isTest: true,
                                timestamp: data.timestamp || Date.now()
                            })
                        );
                        console.log(`Forwarded test message to magician: "${data.message}"`);
                    }

                    ws.send(JSON.stringify({
                        type: 'test_result',
                        success: true,
                        message: `Test message "${data.message}" forwarded to magician`
                    }));
                }
                else if (data.type === 'summarize') {
                    console.log("Summarization request received");

                    const textToSummarize = data.text || '';

                    if (!textToSummarize.trim()) {
                        if (sessions[sessionId]?.spectator) {
                            sessions[sessionId].spectator.send(
                                JSON.stringify({
                                    type: 'summary',
                                    summary: "No speech content to summarize yet.",
                                    timestamp: Date.now()
                                })
                            );
                        }
                        return;
                    }

                    const { summary, topics } = await summarizeTextWithDeepgram(textToSummarize);
                    console.log("Generated summary:", summary);
                    console.log("Generated topics:", topics);

                    // Send both back to spectator
                    if (sessions[sessionId]?.spectator) {
                        sessions[sessionId].spectator.send(
                            JSON.stringify({
                                type: 'summary',
                                summary,
                                topics,
                                timestamp: Date.now()
                            })
                        );
                        console.log(`Sent summary & topics to spectator`);
                    }

                }
            } else {
                if (clientRole === 'spectator' && deepgramLive) {
                    try {
                        const audioData = message instanceof Buffer ? new Uint8Array(message) : message;
                        deepgramLive.send(audioData);
                        console.log('Audio chunk sent to Deepgram:', audioData.byteLength, 'bytes');
                    } catch (error) {
                        console.error('Error sending to Deepgram:', error);
                    }
                }
            }
        } catch (err) {
            console.error("Message handling error:", err);
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
        console.log('Client disconnected');
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
                // Clean up speech history when session ends
                delete speechHistory[sessionId];
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
});