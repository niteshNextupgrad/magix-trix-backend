require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenAI } = require('@google/genai');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
    console.error("Gemini API Key is missing. Please check your .env file.");
    process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

// Sessions & speech history
const sessions = {};
const speechHistory = {};
const audioChunks = {};

// Multer setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.wav';
        const name = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
        cb(null, name);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(express.json());
app.use(cors());

async function extractTopicWithGemini(text = "Magic Session", language = 'english') {
    const model = 'gemini-flash-latest';
    const contents = [
        {
            role: 'user',
            parts: [
                {
                    text: `Analyze the following text and return only the main topic in the same language. Text: "${text}"`
                }
            ]
        }
    ];

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await ai.models.generateContent({ model, contents });
            const candidates = response?.candidates || [];
            if (candidates.length === 0) throw new Error("No response");

            let allText = candidates
                .flatMap(c => c?.content || [])
                .flatMap(c => c?.parts || [])
                .map(p => p.text)
                .filter(Boolean)
                .join(' ')
                .replace(/```/g, "")
                .replace(/\n/g, "")
                .trim();

            return allText || "Magic Session";
        } catch (err) {
            if (err.message?.includes("UNAVAILABLE") || err.message?.includes("503")) {
                console.warn(`Gemini overloaded — retrying in 2s (${retries - 1} left)...`);
                retries--;
                await new Promise(r => setTimeout(r, 2000));
            } else {
                console.error("Gemini API error:", err);
                break;
            }
        }
    }
    return "Magic Session";
}


function combineWavBuffers(wavBuffers) {
    if (wavBuffers.length === 0) return Buffer.alloc(0);
    if (wavBuffers.length === 1) return wavBuffers[0];

    console.log(`Combining ${wavBuffers.length} WAV files...`);

    const WAV_HEADER_SIZE = 44;
    const pcmDataBuffers = wavBuffers.map((buffer, index) => {
        if (buffer.length <= WAV_HEADER_SIZE) {
            console.warn(`Chunk ${index + 1} too small (${buffer.length} bytes), skipping`);
            return Buffer.alloc(0);
        }
        return buffer.slice(WAV_HEADER_SIZE);
    });

    const combinedPCM = Buffer.concat(pcmDataBuffers.filter(b => b.length > 0));
    console.log(`Total PCM data: ${combinedPCM.length} bytes`);

    const firstBuffer = wavBuffers[0];
    const numChannels = firstBuffer.readUInt16LE(22);
    const sampleRate = firstBuffer.readUInt32LE(24);
    const bitsPerSample = firstBuffer.readUInt16LE(34);

    console.log(`Format: ${sampleRate}Hz, ${numChannels}ch, ${bitsPerSample}bit`);

    const newWavBuffer = Buffer.alloc(WAV_HEADER_SIZE + combinedPCM.length);

    newWavBuffer.write('RIFF', 0);
    newWavBuffer.writeUInt32LE(36 + combinedPCM.length, 4);
    newWavBuffer.write('WAVE', 8);
    newWavBuffer.write('fmt ', 12);
    newWavBuffer.writeUInt32LE(16, 16);
    newWavBuffer.writeUInt16LE(1, 20);
    newWavBuffer.writeUInt16LE(numChannels, 22);
    newWavBuffer.writeUInt32LE(sampleRate, 24);
    newWavBuffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
    newWavBuffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
    newWavBuffer.writeUInt16LE(bitsPerSample, 34);
    newWavBuffer.write('data', 36);
    newWavBuffer.writeUInt32LE(combinedPCM.length, 40);

    combinedPCM.copy(newWavBuffer, WAV_HEADER_SIZE);

    console.log(`Combined WAV size: ${newWavBuffer.length} bytes`);
    return newWavBuffer;
}

async function summarizeTextWithDeepgram(text, language = 'en') {
    console.log('Summarizing...');
    try {
        const response = await deepgram.read.analyzeText(
            { text },
            { language: language, summarize: 'v2', topics: true }
        );

        const summary = response.result.results?.summary?.text || "No summary available.";
        const topic = response.result.results?.topics?.segments?.[0]?.topics?.[0]?.topic || null;

        console.log(` Summary: "${summary}"`);
        console.log(` Topic: "${topic}"`);
        return { summary, topic };
    } catch (err) {
        console.error(' Summarization error:', err);
        return { summary: "Error summarizing.", topic: null };
    }
}

async function processDiarization(audioBuffer, sessionId, language) {
    console.log(`\n Diarization for session ${sessionId} (${audioBuffer.length} bytes)`);

    try {
        const tempFilePath = path.join(tempDir, `magic_${sessionId}_${Date.now()}.wav`);
        fs.writeFileSync(tempFilePath, audioBuffer);

        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
            fs.readFileSync(tempFilePath),
            {
                model: "nova-3",
                punctuate: true,
                diarize: true,
                smart_format: true,
                timeout: 120000,
                language: language
            }
        );

        fs.unlinkSync(tempFilePath);

        if (error) {
            console.error("Diarization error:", error);
            return;
        }

        const speakers = {};
        const channels = result.results?.channels || [];

        channels.forEach((channel) => {
            channel.alternatives.forEach((alt) => {
                if (alt.words && alt.words.length > 0) {
                    alt.words.forEach((word) => {
                        const speaker = word.speaker !== undefined ? word.speaker : 0;
                        if (!speakers[speaker]) {
                            speakers[speaker] = { transcript: '', words: [] };
                        }
                        speakers[speaker].transcript += (word.punctuated_word || word.word) + ' ';
                    });
                }
            });
        });

        console.log(`Found ${Object.keys(speakers).length} speaker(s)`);

        Object.keys(speakers).forEach(speakerId => {
            const speaker = speakers[speakerId];
            console.log(`Speaker ${speakerId}: ${speaker.transcript.length} chars`);
            console.log(`Speaker${speakerId} Transcript : ${speaker.transcript}`);

        });

        // process first pserson(magicain) voice only
        const speaker0 = speakers[0];
        if (speaker0 && speaker0.transcript) {
            let summary = speaker0.transcript; // default: full transcript
            let topic = null;

            if (language === "en") {
                // Use Deepgram for English
                const dgResult = await summarizeTextWithDeepgram(speaker0.transcript, language);
                summary = dgResult.summary;
                topic = dgResult.topic;
            } else {
                // Use Gemini for non-English
                topic = await extractTopicWithGemini(speaker0.transcript, language);

            }

            console.log("topic to be send:", topic);
            console.log("summary to be send:", summary);

            // Send to spectator
            if (sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                sessions[sessionId].spectator.send(JSON.stringify({
                    type: 'summary',
                    summary,
                    topic,
                    timestamp: Date.now()
                }));
                console.log('Summary sent to spectator');
            }

            // Send to magician
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'summarize_complete',
                    summary,
                    topic,
                    timestamp: Date.now()
                }));
                console.log('Summary sent to magician');
            }
        }
        else {
            console.log('No speaker 0 transcript found');
        }

    } catch (error) {
        console.error("Diarization error:", error);
    }
}

// API Routes
app.post('/api/process-audio-chunk', upload.single('audio'), async (req, res) => {
    const { sessionId, startKeyword, endKeyword, isMagicActive, chunkNumber, language = 'en' } = req.body;

    console.log(`\n Chunk ${chunkNumber} | Session: ${sessionId} | Magic: ${isMagicActive} | Language: ${language}`);

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
    }

    const filePath = req.file.path;

    try {
        const audioBuffer = fs.readFileSync(filePath);
        console.log(`Size: ${audioBuffer.length} bytes`);

        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-3',
            punctuate: true,
            smart_format: true,
            endpointing: 500,
            language: language
        });

        fs.unlinkSync(filePath);

        if (error) {
            console.error('Deepgram error:', error);
            return res.status(500).json({ error: 'Transcription failed' });
        }

        const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        const transcriptLower = transcript.toLowerCase().trim();

        console.log(`Transcript: "${transcript}"`);

        if (!transcript) {
            return res.json({ success: true, transcript: '', keywordDetected: false });
        }

        if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
            sessions[sessionId].magician.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                timestamp: Date.now()
            }));
        }

        const hasStartKeyword = startKeyword && transcriptLower.includes(startKeyword.toLowerCase());
        const hasEndKeyword = endKeyword && transcriptLower.includes(endKeyword.toLowerCase());

        if (!audioChunks[sessionId]) {
            audioChunks[sessionId] = {
                chunks: [],
                isRecording: false
            };
        }

        if (hasStartKeyword && isMagicActive === 'false') {
            console.log('START DETECTED - Begin storing chunks');
            audioChunks[sessionId].chunks = [];
            audioChunks[sessionId].isRecording = true;

            // audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(`Stored chunk 1 (${audioBuffer.length} bytes)`);

            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'keyword_detected',
                    keyword: 'start',
                    transcript,
                    timestamp: Date.now()
                }));
            }

            return res.json({ success: true, transcript, keywordDetected: true, keyword: 'start' });
        }

        if (audioChunks[sessionId].isRecording && !hasEndKeyword) {
            audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(` Stored chunk ${audioChunks[sessionId].chunks.length} (${audioBuffer.length} bytes)`);
        }

        if (hasEndKeyword && isMagicActive === 'true') {
            console.log('END DETECTED - Processing stored audio');

            // including endKeyword with the recording (storing chunks of endKeyword)

            // if (audioChunks[sessionId].isRecording) {
            //     audioChunks[sessionId].chunks.push(audioBuffer);
            //     console.log(`Stored final chunk ${audioChunks[sessionId].chunks.length}`);
            // }

            audioChunks[sessionId].isRecording = false;

            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'keyword_detected',
                    keyword: 'end',
                    transcript,
                    timestamp: Date.now()
                }));
            }

            if (audioChunks[sessionId].chunks.length > 0) {
                console.log(`Processing ${audioChunks[sessionId].chunks.length} stored chunks`);

                const combinedAudio = combineWavBuffers(audioChunks[sessionId].chunks);
                console.log(`Combined audio size: ${combinedAudio.length} bytes`);

                processDiarization(combinedAudio, sessionId, language).catch(err =>
                    console.error('Error in diarization:', err)
                );

                audioChunks[sessionId].chunks = [];
            } else {
                console.log('No chunks stored to process');
            }

            return res.json({ success: true, transcript, keywordDetected: true, keyword: 'end' });
        }

        if (isMagicActive === 'true' && transcript) {
            if (sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                sessions[sessionId].spectator.send(JSON.stringify({
                    type: 'transcript',
                    word: transcript,
                    timestamp: Date.now()
                }));
            }
        }

        res.json({ success: true, transcript, keywordDetected: false });

    } catch (err) {
        console.error('Error:', err);
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) { }
        res.status(500).json({ error: 'Processing failed', message: err.message });
    }
});

//  WebSocket 
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket connection');
    let sessionId, clientRole;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.type === 'join') {
                sessionId = data.sessionId;
                clientRole = data.role;

                if (!sessions[sessionId]) {
                    sessions[sessionId] = {};
                    speechHistory[sessionId] = [];
                }

                sessions[sessionId][clientRole] = ws;
                console.log(`${clientRole} joined: ${sessionId}`);

                ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole }));

                if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                    console.log(`Both users ready: ${sessionId}`);
                    if (sessions[sessionId].magician.readyState === 1) {
                        sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                    }
                    if (sessions[sessionId].spectator.readyState === 1) {
                        sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                    }
                }
            }
            if (data.type === 'manual_start') {
                const { sessionId } = data;
                console.log(`Manual start received for session: ${sessionId}`);

                // Initialize audio chunks storage
                if (!audioChunks[sessionId]) {
                    audioChunks[sessionId] = {
                        chunks: [],
                        isRecording: false
                    };
                }

                // Start recording
                audioChunks[sessionId].chunks = [];
                audioChunks[sessionId].isRecording = true;
                console.log('Manual start - Begin storing chunks');

                // Notify magician that magic has started
                if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                    sessions[sessionId].magician.send(JSON.stringify({
                        type: 'keyword_detected',
                        keyword: 'start',
                        transcript: '[Manual Start]',
                        timestamp: Date.now()
                    }));
                }
            }
            if (data.type === 'manual_end') {
                const { sessionId, language = 'en' } = data // get the sessionId
                console.log(`Manual stop received for session: ${sessionId}`);

                if (audioChunks[sessionId] && audioChunks[sessionId].chunks.length > 0) {
                    audioChunks[sessionId].isRecording = false;

                    const combinedAudio = combineWavBuffers(audioChunks[sessionId].chunks);
                    console.log(`Processing ${audioChunks[sessionId].chunks.length} chunks (${combinedAudio.length} bytes)`);

                    processDiarization(combinedAudio, sessionId, language).catch(err =>
                        console.error('Error in diarization:', err)
                    );

                    // Clear chunks after processing
                    audioChunks[sessionId].chunks = [];
                } else {
                    console.log('No audio chunks found for this session');
                }
            }

        } catch (err) {
            console.error('WebSocket error:', err);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Closed: ${clientRole} in ${sessionId}`);
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
                delete speechHistory[sessionId];
                delete audioChunks[sessionId];
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}\n`);
});