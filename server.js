require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenAI } = require('@google/genai');

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
const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const sessions = {};
const speechHistory = {};

// Function to extract topics using Gemini
async function extractTopicsWithGemini(text = "Default sample text") {
    try {
        const model = 'gemini-flash-latest';
        const contents = [
            {
                role: 'user',
                parts: [
                    { text: `Extract 2-3 concise topics from this text and return a JSON array only: ${text}` }
                ]
            }
        ];

        const response = await ai.models.generateContent({ model, contents });

        const candidates = response?.candidates || [];
        if (candidates.length === 0) return [];

        // Flatten all text from all parts of all candidates
        let allText = candidates
            .flatMap(candidate => candidate?.content || [])
            .flatMap(content => content?.parts || [])
            .map(part => part.text)
            .filter(Boolean)
            .join(' ');

        if (!allText) return [];

        // Remove markdown ```json ``` and newlines
        allText = allText.replace(/```json/i, "")
            .replace(/```/g, "")
            .replace(/\n/g, "")
            .trim();

        // Try parsing JSON
        let topics;
        try {
            topics = JSON.parse(allText);
        } catch {
            // fallback: split by comma
            topics = allText.split(',').map(t => t.trim()).filter(Boolean);
        }
        console.log(topics);

        return topics;

    } catch (err) {
        console.error("Gemini API error:", err);
        return [];
    }
}

// Function to summarize text with Deepgram
async function summarizeTextWithDeepgram(text) {
    // console.log("Summarizing with Deepgram + extracting topics with Gemini ::", text);

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

    ws.on('message', async (message, isBinary) => {
        try {
            // Only handle text messages (no binary audio processing needed anymore)
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

                    if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                        sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                        sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                        console.log(`Both magician and spectator are connected in ${sessionId}`);
                    }
                }
                else if (data.type === 'test') {
                    // This now handles magician's speech being sent to spectator
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
                        console.log(`Forwarded magician's speech to spectator: "${data.message}"`);
                    }

                    // Send confirmation back to magician
                    ws.send(JSON.stringify({
                        type: 'test_result',
                        success: true,
                        message: `Speech "${data.message}" forwarded to spectator`
                    }));
                }
                else if (data.type === 'summarize') {
                    console.log("Summarization request received from magician");

                    const textToSummarize = data.text || '';

                    if (!textToSummarize.trim()) {
                        // If no text provided, try to use accumulated speech history
                        const sessionSpeech = speechHistory[sessionId]?.join(' ') || '';

                        if (!sessionSpeech.trim()) {
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
                    }

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

                    // Also send confirmation to magician
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
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});



const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 AI Magic Server is listening on port ${PORT}`);
});



// require('dotenv').config();
// const express = require('express');
// const http = require('http');
// const { WebSocketServer } = require('ws');
// const multer = require('multer');
// const fs = require('fs');
// const path = require('path');
// const { createClient } = require('@deepgram/sdk');
// const { GoogleGenAI } = require('@google/genai');
// const cors = require('cors')

// const app = express();
// const server = http.createServer(app);
// const wss = new WebSocketServer({ server });

// const PORT = process.env.PORT || 3001;
// const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// // Sessions & speech history
// const sessions = {};
// const speechHistory = {};

// // Multer setup for audio uploads
// const uploadDir = path.join(__dirname, 'uploads');
// if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// const storage = multer.diskStorage({
//     destination: (req, file, cb) => {
//         cb(null, uploadDir);
//     },
//     filename: (req, file, cb) => {
//         // Keep original extension or enforce .wav
//         const ext = path.extname(file.originalname) || '.wav';
//         const name = `audio_${Date.now()}${ext}`;
//         cb(null, name);
//     }
// });

// const upload = multer({ storage });


// app.use(express.json());
// app.use(cors())

// // Upload audio endpoint
// app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
//     try {
//         if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

//         const filePath = path.join(uploadDir, req.file.filename);
//         const audioBuffer = fs.readFileSync(filePath);

//         console.log(`Received audio file: ${req.file.originalname}, size: ${audioBuffer.length} bytes`);

//         // 🔹 Process audio with diarization and log speaker results
//         const speakerTranscripts = await processAudioWithDiarization(audioBuffer, req.body.sessionId || 'unknown');

//         const { result } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
//             model: 'nova-3',
//             punctuate: true,
//             diarize: true,
//             smart_format: true
//         });

//         // fs.unlinkSync(filePath); // clean temp file

//         res.json({ message: 'Audio processed successfully', transcription: result });
//     } catch (err) {
//         console.error('Error processing audio:', err);
//         res.status(500).json({ error: err.message });
//     }
// });



// wss.on('connection', (ws) => {
//     console.log('New WebSocket client connected');
//     let sessionId, clientRole;

//     ws.on('message', async (message, isBinary) => {
//         if (isBinary) return; // all audio handled via REST

//         try {
//             const data = JSON.parse(message.toString());

//             // ---------------- Join ----------------
//             if (data.type === 'join') {
//                 sessionId = data.sessionId;
//                 clientRole = data.role;
//                 if (!sessions[sessionId]) sessions[sessionId] = {};
//                 sessions[sessionId][clientRole] = ws;

//                 ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole }));

//                 // Notify both ready
//                 if (sessions[sessionId].magician && sessions[sessionId].spectator) {
//                     sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
//                     sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
//                 }
//             }

//             // ---------------- Live Speech ----------------
//             else if (data.type === 'test') {
//                 if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
//                 speechHistory[sessionId].push(data.message);

//                 if (sessionId && sessions[sessionId]?.spectator) {
//                     sessions[sessionId].spectator.send(JSON.stringify({
//                         type: 'transcript',
//                         word: data.message,
//                         timestamp: Date.now()
//                     }));
//                 }
//             }

//             // ---------------- Summarize ----------------
//             else if (data.type === 'summarize') {
//                 const textToSummarize = data.text || '';
//                 const finalText = textToSummarize.trim() || speechHistory[sessionId]?.join(' ') || '';

//                 const { summary, topics } = await summarizeTextWithDeepgram(finalText);

//                 if (sessions[sessionId]?.spectator) {
//                     sessions[sessionId].spectator.send(JSON.stringify({ type: 'summary', summary, topics, timestamp: Date.now() }));
//                 }

//                 if (sessions[sessionId]?.magician) {
//                     sessions[sessionId].magician.send(JSON.stringify({ type: 'summarize_complete', summary, topics, timestamp: Date.now() }));
//                 }

//                 speechHistory[sessionId] = [];
//             }

//         } catch (err) {
//             console.error('WebSocket message error:', err);
//         }
//     });

//     ws.on('close', () => {
//         if (sessionId && clientRole && sessions[sessionId]) {
//             delete sessions[sessionId][clientRole];
//             if (Object.keys(sessions[sessionId]).length === 0) {
//                 delete sessions[sessionId];
//                 delete speechHistory[sessionId];
//             }
//         }
//     });

//     ws.on('error', (err) => console.error('WebSocket error:', err));
// });

// async function summarizeTextWithDeepgram(text) {
//     try {
//         const response = await deepgram.read.analyzeText({ text }, { language: 'en', summarize: 'v2', topics: true, });
//         const summary = response.result.results.summary?.text || "No summary available.";
//         console.log("deepgram summary", summary);
//         console.log("deepgram topic", response.result.results.topics || "NO TOPIC FOUND");
//         const topics = await extractTopicsWithGemini(text);
//         return { summary, topics };
//     } catch (err) {
//         console.error('Error summarizing text:', err);
//         return { summary: "Error summarizing text.", topics: [] };
//     }
// }

// async function extractTopicsWithGemini(text = "Default sample text") {
//     try {
//         const model = 'gemini-flash-latest';
//         const contents = [
//             {
//                 role: 'user',
//                 parts: [
//                     { text: `Extract 2-3 concise topics from this text and return a JSON array only: ${text}` }
//                 ]
//             }
//         ];

//         const response = await ai.models.generateContent({ model, contents });

//         const candidates = response?.candidates || [];
//         if (candidates.length === 0) return [];

//         // Flatten all text from all parts of all candidates
//         let allText = candidates
//             .flatMap(candidate => candidate?.content || [])
//             .flatMap(content => content?.parts || [])
//             .map(part => part.text)
//             .filter(Boolean)
//             .join(' ');

//         if (!allText) return [];

//         // Remove markdown ```json ``` and newlines
//         allText = allText.replace(/```json/i, "")
//             .replace(/```/g, "")
//             .replace(/\n/g, "")
//             .trim();

//         // Try parsing JSON
//         let topics;
//         try {
//             topics = JSON.parse(allText);
//         } catch {
//             // fallback: split by comma
//             topics = allText.split(',').map(t => t.trim()).filter(Boolean);
//         }
//         console.log(topics);

//         return topics;

//     } catch (err) {
//         console.error("Gemini API error:", err);
//         return [];
//     }
// }

// async function processAudioWithDiarization(audioBuffer, sessionId) {
//     try {
//         console.log(`Processing audio for session ${sessionId}, size: ${audioBuffer.length} bytes`);

//         // 🔹 Save buffer to temp file (optional, but useful for debugging)
//         const tempDir = path.join(__dirname, 'temp');
//         if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

//         const tempFilePath = path.join(tempDir, `audio_${sessionId}_${Date.now()}.wav`);
//         fs.writeFileSync(tempFilePath, audioBuffer);
//         console.log(`Temporary audio file saved: ${tempFilePath}`);

//         // 🔹 Call Deepgram SDK
//         const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
//             fs.readFileSync(tempFilePath), // send buffer directly
//             {
//                 model: "nova-3",
//                 punctuate: true,
//                 diarize: true,
//                 smart_format: true,
//                 timeout: 120000
//                 // language: "en",   // optional
//             }
//         );
//         fs.unlinkSync(tempFilePath); // clean temp file

//         if (error) {
//             console.error("Deepgram SDK error:", error);
//             return [];
//         }

//         if (!result.results || !result.results.channels) {
//             console.log("No channels found in diarization result");
//             return [];
//         }

//         const channels = result.results.channels;
//         console.log(`Diarization completed. Found ${channels.length} channel(s)`);

//         let speakers = {};

//         channels.forEach((channel, channelIndex) => {
//             channel.alternatives.forEach((alt) => {
//                 if (alt.words && alt.words.length > 0) {
//                     console.log(`Channel ${channelIndex} has ${alt.words.length} words`);

//                     alt.words.forEach((word) => {
//                         const speaker = word.speaker || 0;
//                         if (!speakers[speaker]) {
//                             speakers[speaker] = {
//                                 transcript: '',
//                                 words: []
//                             };
//                         }
//                         speakers[speaker].transcript += (word.punctuated_word || word.word) + ' ';
//                         speakers[speaker].words.push({
//                             word: word.punctuated_word || word.word,
//                             confidence: word.confidence,
//                             start: word.start,
//                             end: word.end
//                         });
//                     });
//                 }
//             });
//         });

//         const speakerTranscripts = Object.keys(speakers).map(speaker => ({
//             speaker: parseInt(speaker),
//             transcript: speakers[speaker].transcript.trim(),
//             wordCount: speakers[speaker].words.length,
//             words: speakers[speaker].words,
//             duration: speakers[speaker].words.length > 0
//                 ? speakers[speaker].words[speakers[speaker].words.length - 1].end -
//                 speakers[speaker].words[0].start
//                 : 0
//         }));

//         console.log("Speaker diarization results:");
//         speakerTranscripts.forEach(speaker => {
//             console.log(`Speaker ${speaker.speaker}: ${speaker.wordCount} words, ${speaker.duration.toFixed(2)}s`);
//             console.log(`Transcript: "${speaker.transcript}"`);
//         });

//         return speakerTranscripts;

//     } catch (error) {
//         console.error("Error processing audio with diarization:", error);
//         return [];
//     }
// }


// server.listen(PORT, () => console.log(`🚀 AI Magic Server running on port ${PORT}`));
