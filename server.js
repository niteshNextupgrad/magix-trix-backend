require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // 👈 Gemini

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!deepgramApiKey) {
    console.error("Deepgram API Key is missing. Please check your .env file.");
    process.exit(1);
}
if (!geminiApiKey) {
    console.error("Gemini API Key is missing. Please check your .env file.");
    process.exit(1);
}

const deepgram = createClient(deepgramApiKey);
const genAI = new GoogleGenerativeAI(geminiApiKey); // Gemini client
const sessions = {};
const speechHistory = {};

// 🔹 Function to extract topics using Gemini
async function extractTopicsWithGemini(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `Extract 2-3 concise and general topics from the following text. 
        The text may be a conversation or a single person's statement. 
            Focus only on the main themes, ignore filler words. 
            Return only a JSON array of strings, nothing else.
            Example: ["Education", "Technology", "Creativity"]
                
            Text: ${text}`;


        const result = await model.generateContent(prompt);
        let responseText = result.response.text().trim();

        // Remove markdown fences if present
        responseText = responseText
            .replace(/```json/i, "")
            .replace(/```/g, "")
            .trim();

        let topics;
        try {
            topics = JSON.parse(responseText);
        } catch {
            topics = responseText
                .replace(/[\[\]"]/g, "")
                .split(",")
                .map(t => t.trim())
                .filter(Boolean);
        }

        return topics;
    } catch (error) {
        console.error("Error extracting topics with Gemini:", error);
        return [];
    }
}


// 🔹 Function to summarize text with Deepgram
async function summarizeTextWithDeepgram(text) {
    console.log("Summarizing with Deepgram + extracting topics with Gemini ::", text);

    try {
        const response = await deepgram.read.analyzeText(
            { text },
            {
                language: 'en',
                summarize: 'v2', //Only summarization here
            }
        );

        const { results } = response.result;
        console.log("Deepgram Results:", JSON.stringify(results, null, 2));

        const summary = results.summary?.text || "No summary available.";

        // 👉 Call Gemini for topics
        const topics = await extractTopicsWithGemini(text);

        return { summary, topics };
    } catch (error) {
        console.error('Error summarizing text with Deepgram:', error);
        return { summary: "Sorry, I couldn't summarize the text at this time.", topics: [] };
    }
}

// 🔹 Function to setup Deepgram connection for real-time transcription
function setupDeepgramConnection(sessionId, spectatorWs) {
    let deepgramLive;

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
            spectatorWs.send(JSON.stringify({ type: 'deepgram_ready', message: 'Speech recognition ready' }));
        });

        deepgramLive.on('transcriptReceived', (dgData) => {
            try {
                if (dgData.is_final && dgData.channel?.alternatives?.[0]) {
                    const transcript = dgData.channel.alternatives[0].transcript.trim();
                    if (transcript) {
                        if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
                        speechHistory[sessionId].push(transcript);

                        if (sessions[sessionId]?.magician) {
                            sessions[sessionId].magician.send(
                                JSON.stringify({ type: 'transcript', word: transcript })
                            );
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
}

// 🔹 WebSocket connection handler
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
                                    topics: [],
                                    timestamp: Date.now()
                                })
                            );
                        }
                        return;
                    }

                    const { summary, topics } = await summarizeTextWithDeepgram(textToSummarize);
                    console.log("Generated summary:", summary);
                    console.log("Generated topics:", topics);

                    if (sessions[sessionId]?.spectator) {
                        sessions[sessionId].spectator.send(
                            JSON.stringify({
                                type: 'summary',
                                summary,
                                topics,
                                timestamp: Date.now()
                            })
                        );
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
