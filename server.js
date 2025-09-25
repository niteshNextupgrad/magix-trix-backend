// require('dotenv').config();
// const express = require('express');
// const http = require('http');
// const { WebSocketServer } = require('ws');
// const { createClient } = require('@deepgram/sdk');
// const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini

// const app = express();
// const server = http.createServer(app);
// const wss = new WebSocketServer({ server });

// const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
// const geminiApiKey = process.env.GEMINI_API_KEY;

// if (!deepgramApiKey) {
//     console.error("Deepgram API Key is missing. Please check your .env file.");
//     process.exit(1);
// }
// if (!geminiApiKey) {
//     console.error("Gemini API Key is missing. Please check your .env file.");
//     process.exit(1);
// }

// const deepgram = createClient(deepgramApiKey);
// const genAI = new GoogleGenerativeAI(geminiApiKey); // Gemini client
// const sessions = {};
// const speechHistory = {};

// // Function to extract topics using Gemini
// async function extractTopicsWithGemini(text) {
//     const maxRetries = 3;

//     for (let attempt = 1; attempt <= maxRetries; attempt++) {
//         try {
//             const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//             const prompt = `Extract 2-3 concise and general topics from the following text. 
//             The text may be a conversation or a single person's statement. 
//             Focus only on the main themes, ignore filler words. 
//             Return only a JSON array of strings, nothing else.
//             Example: ["Education", "Technology", "Creativity"]
                
//             Text: ${text}`;

//             const result = await model.generateContent(prompt);
//             let responseText = result.response.text().trim();

//             // Remove markdown fences if present
//             responseText = responseText
//                 .replace(/```json/i, "")
//                 .replace(/```/g, "")
//                 .trim();

//             let topics;
//             try {
//                 topics = JSON.parse(responseText);
//             } catch {
//                 topics = responseText
//                     .replace(/[\[\]"]/g, "")
//                     .split(",")
//                     .map(t => t.trim())
//                     .filter(Boolean);
//             }

//             return topics;

//         } catch (error) {
//             console.error(`Gemini API attempt ${attempt} failed:`, error.message);

//             if (error.status === 503 && attempt < maxRetries) {
//                 const delay = 2000 * attempt; // 2s, 4s, 6s delays
//                 console.log(`Retrying in ${delay}ms...`);
//                 await new Promise(resolve => setTimeout(resolve, delay));
//             } else if (attempt === maxRetries) {
//                 console.log("All Gemini attempts failed, returning empty array");
//                 return [];
//             }
//         }
//     }
// }

// // Function to summarize text with Deepgram
// async function summarizeTextWithDeepgram(text) {
//     // console.log("Summarizing with Deepgram + extracting topics with Gemini ::", text);

//     try {
//         const response = await deepgram.read.analyzeText(
//             { text },
//             {
//                 language: 'en',
//                 summarize: 'v2', //Only summarization here
//             }
//         );

//         const { results } = response.result;
//         console.log("Deepgram Results:", JSON.stringify(results, null, 2));

//         const summary = results.summary?.text || "No summary available.";

//         // Call Gemini for topics
//         const topics = await extractTopicsWithGemini(text);

//         return { summary, topics };
//     } catch (error) {
//         console.error('Error summarizing text with Deepgram:', error);
//         return { summary: "Sorry, I couldn't summarize the text at this time.", topics: [] };
//     }
// }

// // 🔹 WebSocket connection handler
// wss.on('connection', (ws) => {
//     console.log('New WebSocket client connected');

//     let sessionId;
//     let clientRole;

//     ws.on('message', async (message, isBinary) => {
//         try {
//             // Only handle text messages (no binary audio processing needed anymore)
//             if (!isBinary) {
//                 const data = JSON.parse(message.toString());
//                 console.log("Control message received:", data);

//                 if (data.type === 'join') {
//                     sessionId = data.sessionId;
//                     clientRole = data.role;

//                     if (!sessions[sessionId]) sessions[sessionId] = {};
//                     sessions[sessionId][clientRole] = ws;
//                     console.log(`Client joined session ${sessionId} as ${clientRole}`);

//                     ws.send(JSON.stringify({
//                         type: 'joined',
//                         sessionId,
//                         role: clientRole,
//                         message: `Successfully joined as ${clientRole}`
//                     }));

//                     if (sessions[sessionId].magician && sessions[sessionId].spectator) {
//                         sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
//                         sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
//                         console.log(`Both magician and spectator are connected in ${sessionId}`);
//                     }
//                 }
//                 else if (data.type === 'test') {
//                     // This now handles magician's speech being sent to spectator
//                     console.log("Speech message received from magician:", data.message);

//                     // Store magician's speech in history for this session
//                     if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
//                     speechHistory[sessionId].push(data.message);

//                     // Forward magician's speech to spectator
//                     if (sessionId && sessions[sessionId]?.spectator) {
//                         sessions[sessionId].spectator.send(
//                             JSON.stringify({
//                                 type: 'transcript',
//                                 word: data.message,
//                                 timestamp: data.timestamp || Date.now()
//                             })
//                         );
//                         console.log(`Forwarded magician's speech to spectator: "${data.message}"`);
//                     }

//                     // Send confirmation back to magician
//                     ws.send(JSON.stringify({
//                         type: 'test_result',
//                         success: true,
//                         message: `Speech "${data.message}" forwarded to spectator`
//                     }));
//                 }
//                 else if (data.type === 'summarize') {
//                     console.log("Summarization request received from magician");

//                     const textToSummarize = data.text || '';

//                     if (!textToSummarize.trim()) {
//                         // If no text provided, try to use accumulated speech history
//                         const sessionSpeech = speechHistory[sessionId]?.join(' ') || '';

//                         if (!sessionSpeech.trim()) {
//                             if (sessions[sessionId]?.spectator) {
//                                 sessions[sessionId].spectator.send(
//                                     JSON.stringify({
//                                         type: 'summary',
//                                         summary: "No speech content to summarize yet.",
//                                         topics: [],
//                                         timestamp: Date.now()
//                                     })
//                                 );
//                             }
//                             return;
//                         }
//                     }

//                     const finalTextToSummarize = textToSummarize.trim() || speechHistory[sessionId]?.join(' ') || '';
//                     console.log("Final text to summarize:", finalTextToSummarize);

//                     const { summary, topics } = await summarizeTextWithDeepgram(finalTextToSummarize);
//                     console.log("Generated summary:", summary);
//                     console.log("Generated topics:", topics);

//                     // Send summary and topics to spectator (this will trigger Google search)
//                     if (sessions[sessionId]?.spectator) {
//                         sessions[sessionId].spectator.send(
//                             JSON.stringify({
//                                 type: 'summary',
//                                 summary,
//                                 topics,
//                                 timestamp: Date.now()
//                             })
//                         );
//                         console.log("Summary and topics sent to spectator for Google search");
//                     }

//                     // Also send confirmation to magician
//                     if (sessions[sessionId]?.magician) {
//                         sessions[sessionId].magician.send(
//                             JSON.stringify({
//                                 type: 'summarize_complete',
//                                 summary,
//                                 topics,
//                                 message: "Speech analyzed and sent to spectator",
//                                 timestamp: Date.now()
//                             })
//                         );
//                     }

//                     // Clear speech history for this session after processing
//                     speechHistory[sessionId] = [];
//                 }
//             }
//         } catch (err) {
//             console.error("Message handling error:", err);
//             try {
//                 ws.send(JSON.stringify({
//                     type: 'error',
//                     message: 'Failed to process message',
//                     error: err.message
//                 }));
//             } catch (e) {
//                 console.error('Could not send error response:', e);
//             }
//         }
//     });

//     ws.on('close', () => {
//         console.log(`Client disconnected - Role: ${clientRole}, Session: ${sessionId}`);
//         if (sessionId && clientRole && sessions[sessionId]) {
//             delete sessions[sessionId][clientRole];
//             console.log(`Removed ${clientRole} from session ${sessionId}`);

//             // Clean up session if empty
//             if (Object.keys(sessions[sessionId]).length === 0) {
//                 delete sessions[sessionId];
//                 delete speechHistory[sessionId];
//                 console.log(`Session ${sessionId} cleaned up completely`);
//             }
//         }
//     });

//     ws.on('error', (error) => {
//         console.error('WebSocket error:', error);
//     });
// });



// const PORT = process.env.PORT || 3001;
// server.listen(PORT, () => {
//     console.log(`🚀 AI Magic Server is listening on port ${PORT}`);
// });



require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
const genAI = new GoogleGenerativeAI(geminiApiKey);
const sessions = {};
const speechHistory = {};

async function processAudioWithDiarization(audioBuffer, sessionId) {
    try {
        console.log(`Processing audio for session ${sessionId}, size: ${audioBuffer.length} bytes`);

        // 🔹 Save buffer to temp file (optional, but useful for debugging)
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const tempFilePath = path.join(tempDir, `audio_${sessionId}_${Date.now()}.wav`);
        fs.writeFileSync(tempFilePath, audioBuffer);
        console.log(`Temporary audio file saved: ${tempFilePath}`);

        // 🔹 Call Deepgram SDK
        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
            fs.readFileSync(tempFilePath), // send buffer directly
            {
                model: "nova-3",
                punctuate: true,
                diarize: true,
                smart_format: true,
                // language: "en",   // optional
            }
        );

        if (error) {
            console.error("Deepgram SDK error:", error);
            return [];
        }

        if (!result.results || !result.results.channels) {
            console.log("No channels found in diarization result");
            return [];
        }

        const channels = result.results.channels;
        console.log(`Diarization completed. Found ${channels.length} channel(s)`);

        let speakers = {};

        channels.forEach((channel, channelIndex) => {
            channel.alternatives.forEach((alt) => {
                if (alt.words && alt.words.length > 0) {
                    console.log(`Channel ${channelIndex} has ${alt.words.length} words`);

                    alt.words.forEach((word) => {
                        const speaker = word.speaker || 0;
                        if (!speakers[speaker]) {
                            speakers[speaker] = {
                                transcript: '',
                                words: []
                            };
                        }
                        speakers[speaker].transcript += (word.punctuated_word || word.word) + ' ';
                        speakers[speaker].words.push({
                            word: word.punctuated_word || word.word,
                            confidence: word.confidence,
                            start: word.start,
                            end: word.end
                        });
                    });
                }
            });
        });

        const speakerTranscripts = Object.keys(speakers).map(speaker => ({
            speaker: parseInt(speaker),
            transcript: speakers[speaker].transcript.trim(),
            wordCount: speakers[speaker].words.length,
            words: speakers[speaker].words,
            duration: speakers[speaker].words.length > 0
                ? speakers[speaker].words[speakers[speaker].words.length - 1].end -
                  speakers[speaker].words[0].start
                : 0
        }));

        console.log("Speaker diarization results:");
        speakerTranscripts.forEach(speaker => {
            console.log(`Speaker ${speaker.speaker}: ${speaker.wordCount} words, ${speaker.duration.toFixed(2)}s`);
            console.log(`Transcript: "${speaker.transcript}"`);
        });

        return speakerTranscripts;

    } catch (error) {
        console.error("Error processing audio with diarization:", error);
        return [];
    }
}


async function extractTopicsWithGemini(text) {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
            console.error(`Gemini API attempt ${attempt} failed:`, error.message);

            if (error.status === 503 && attempt < maxRetries) {
                const delay = 2000 * attempt; // 2s, 4s, 6s delays
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else if (attempt === maxRetries) {
                console.log("All Gemini attempts failed, returning empty array");
                return [];
            }
        }
    }
}

// Function to summarize text with Deepgram
async function summarizeTextWithDeepgram(text) {
    try {
        const response = await deepgram.read.analyzeText(
            { text },
            {
                language: 'en',
                summarize: 'v2',
            }
        );

        const { results } = response.result;
        const summary = results.summary?.text || "No summary available.";

        // Call Gemini for topics
        const topics = await extractTopicsWithGemini(text);

        return { summary, topics };
    } catch (error) {
        console.error('Error summarizing text with Deepgram:', error);
        return { summary: "Sorry, I couldn't summarize the text at this time.", topics: [] };
    }
}

// 🔹 WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');

    let sessionId;
    let clientRole;
    let currentAudioBuffer = null;

    ws.on('message', async (message, isBinary) => {
        try {
            if (isBinary) {
                // Handle binary audio data
                console.log(`Received binary audio data, size: ${message.length} bytes`);

                if (sessionId && clientRole === 'magician') {
                    // Store the audio buffer
                    currentAudioBuffer = message;

                    // Process audio with speaker diarization immediately
                    const speakerTranscripts = await processAudioWithDiarization(message, sessionId);

                    // Send detailed diarization results to magician
                    if (speakerTranscripts.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'diarization_result',
                            speakers: speakerTranscripts,
                            sessionId: sessionId,
                            timestamp: Date.now(),
                            message: `Found ${speakerTranscripts.length} speaker(s) in the conversation`
                        }));

                        console.log(`Sent diarization results for ${speakerTranscripts.length} speakers to magician`);

                        // Log detailed speaker information
                        speakerTranscripts.forEach(speaker => {
                            console.log(`\n=== SPEAKER ${speaker.speaker} ===`);
                            console.log(`Words: ${speaker.wordCount}`);
                            console.log(`Duration: ${speaker.duration.toFixed(2)} seconds`);
                            console.log(`Transcript: "${speaker.transcript}"`);
                            console.log('Individual words:', speaker.words.map(w => w.word).join(', '));
                        });
                    } else {
                        ws.send(JSON.stringify({
                            type: 'diarization_result',
                            speakers: [],
                            sessionId: sessionId,
                            timestamp: Date.now(),
                            message: 'No speakers detected in the audio'
                        }));
                    }
                }
            } else {
                // Handle text messages
                const data = JSON.parse(message.toString());
                console.log("Control message received:", data.type);

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

                    if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                        sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                        sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                        console.log(`Both magician and spectator are connected in ${sessionId}`);
                    }
                }
                else if (data.type === 'test') {
                    console.log("Speech message received from magician:", data.message);

                    // Store magician's speech in history for this session
                    if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
                    speechHistory[sessionId].push(data.message);

                    // Forward magician's speech to spectator
                    if (sessionId && sessions[sessionId]?.spectator) {
                        sessions[sessionId].spectator.send(
                            JSON.stringify({
                                type: 'transcript',
                                word: data.message,
                                timestamp: data.timestamp || Date.now()
                            })
                        );
                    }

                    // Send confirmation back to magician
                    ws.send(JSON.stringify({
                        type: 'test_result',
                        success: true,
                        message: `Speech forwarded to spectator`
                    }));
                }
                else if (data.type === 'summarize') {
                    console.log("Summarization request received from magician");

                    const textToSummarize = data.text || '';
                    const finalTextToSummarize = textToSummarize.trim() || speechHistory[sessionId]?.join(' ') || '';

                    console.log("Final text to summarize:", finalTextToSummarize);

                    const { summary, topics } = await summarizeTextWithDeepgram(finalTextToSummarize);
                    console.log("Generated summary:", summary);
                    console.log("Generated topics:", topics);

                    // Send summary and topics to spectator (this will trigger Google search)
                    if (sessions[sessionId]?.spectator) {
                        sessions[sessionId].spectator.send(
                            JSON.stringify({
                                type: 'summary',
                                summary,
                                topics,
                                timestamp: Date.now()
                            })
                        );
                        console.log("Summary and topics sent to spectator for Google search");
                    }

                    // Also send confirmation to magician with both summary and diarization info
                    if (sessions[sessionId]?.magician) {
                        sessions[sessionId].magician.send(
                            JSON.stringify({
                                type: 'summarize_complete',
                                summary,
                                topics,
                                message: "Speech analyzed and sent to spectator",
                                timestamp: Date.now()
                            })
                        );
                    }

                    // Clear speech history for this session after processing
                    speechHistory[sessionId] = [];
                }
                else if (data.type === 'audio_metadata') {
                    console.log(`Audio metadata: session ${data.sessionId}, size: ${data.size} bytes`);
                    // Audio processing is handled in the binary message part
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
        console.log(`Client disconnected - Role: ${clientRole}, Session: ${sessionId}`);
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            console.log(`Removed ${clientRole} from session ${sessionId}`);

            // Clean up session if empty
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
                delete speechHistory[sessionId];
                console.log(`Session ${sessionId} cleaned up completely`);
            }
        }

        // Clean up audio buffer
        currentAudioBuffer = null;
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Clean up temp directory on startup
const tempDir = path.join(__dirname, 'temp');
if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
fs.mkdirSync(tempDir, { recursive: true });

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 AI Magic Server with Speaker Diarization is listening on port ${PORT}`);
});