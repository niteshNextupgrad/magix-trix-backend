require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const { GoogleGenAI } = require('@google/genai');
const cors = require('cors')

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Sessions & speech history
const sessions = {};
const speechHistory = {};

// Multer setup for audio uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Keep original extension or enforce .wav
        const ext = path.extname(file.originalname) || '.wav';
        const name = `audio_${Date.now()}${ext}`;
        cb(null, name);
    }
});

const upload = multer({ storage });


app.use(express.json());
app.use(cors())

// Upload audio endpoint
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

        const filePath = path.join(uploadDir, req.file.filename);
        const audioBuffer = fs.readFileSync(filePath);

        console.log(`Received audio file: ${req.file.originalname}, size: ${audioBuffer.length} bytes`);

        // Process audio with diarization and log speaker results
        const speakerTranscripts = await processAudioWithDiarization(audioBuffer, req.body.sessionId || 'unknown');

        const { result } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-3',
            punctuate: true,
            diarize: true,
            smart_format: true
        });

        fs.unlinkSync(filePath); // clean temp file

        res.json({ message: 'Audio processed successfully', transcription: result });
    } catch (err) {
        console.error('Error processing audio:', err);
        res.status(500).json({ error: err.message });
    }
});



wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    let sessionId, clientRole;

    ws.on('message', async (message, isBinary) => {
        if (isBinary) return; // all audio handled via REST

        try {
            const data = JSON.parse(message.toString());

            // ---------------- Join ----------------
            if (data.type === 'join') {
                sessionId = data.sessionId;
                clientRole = data.role;
                if (!sessions[sessionId]) sessions[sessionId] = {};
                sessions[sessionId][clientRole] = ws;

                ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole }));

                // Notify both ready
                if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                    sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                    sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                }
            }

            // ---------------- Live Speech ----------------
            else if (data.type === 'test') {
                if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
                speechHistory[sessionId].push(data.message);

                if (sessionId && sessions[sessionId]?.spectator) {
                    sessions[sessionId].spectator.send(JSON.stringify({
                        type: 'transcript',
                        word: data.message,
                        timestamp: Date.now()
                    }));
                }
            }

            // ---------------- Summarize ----------------
            // else if (data.type === 'summarize') {
            //     const textToSummarize = data.text || '';
            //     const finalText = textToSummarize.trim() || speechHistory[sessionId]?.join(' ') || '';

            //     const { summary, topics } = await summarizeTextWithDeepgram(finalText);

            //     if (sessions[sessionId]?.spectator) {
            //         sessions[sessionId].spectator.send(JSON.stringify({ type: 'summary', summary, topics, timestamp: Date.now() }));
            //     }

            //     if (sessions[sessionId]?.magician) {
            //         sessions[sessionId].magician.send(JSON.stringify({ type: 'summarize_complete', summary, topics, timestamp: Date.now() }));
            //     }

            //     speechHistory[sessionId] = [];
            // }

        } catch (err) {
            console.error('WebSocket message error:', err);
        }
    });

    ws.on('close', () => {
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
                delete speechHistory[sessionId];
            }
        }
    });

    ws.on('error', (err) => console.error('WebSocket error:', err));
});

async function summarizeTextWithDeepgram(text) {
    try {
        const response = await deepgram.read.analyzeText({ text }, { language: 'en', summarize: 'v2', topics: true });

        const summary = response.result.results?.summary?.text || "No summary available.";
        const deepgramTopics = response.result.results.topics.segments[0]?.topics[0]?.topic;
        console.log("deepgram Topics:", deepgramTopics);

        console.log("deepgram summary:", summary)
        const topics = await extractTopicsWithGemini(text);
        return { summary, topics };
    } catch (err) {
        console.error('Error summarizing text:', err);
        return { summary: "Error summarizing text.", topics: [] };
    }
}

async function extractTopicsWithGemini(text) {
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

async function processAudioWithDiarization(audioBuffer, sessionId) {
    try {
        console.log(`Processing audio for session ${sessionId}, size: ${audioBuffer.length} bytes`);

        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const tempFilePath = path.join(tempDir, `audio_${sessionId}_${Date.now()}.wav`);
        fs.writeFileSync(tempFilePath, audioBuffer);

        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
            fs.readFileSync(tempFilePath),
            {
                model: "nova-3",
                punctuate: true,
                diarize: true,
                smart_format: true,
                timeout: 120000
            }
        );
        fs.unlinkSync(tempFilePath);

        if (error) {
            console.error("Deepgram SDK error:", error);
            return [];
        }

        if (!result.results || !result.results.channels) {
            console.log("No channels found in diarization result");
            return [];
        }

        const channels = result.results.channels;
        let speakers = {};

        channels.forEach((channel) => {
            channel.alternatives.forEach((alt) => {
                if (alt.words && alt.words.length > 0) {
                    alt.words.forEach((word) => {
                        const speaker = word.speaker || 0;
                        if (!speakers[speaker]) {
                            speakers[speaker] = { transcript: '', words: [] };
                        }
                        speakers[speaker].transcript += (word.punctuated_word || word.word) + ' ';
                        speakers[speaker].words.push(word);
                    });
                }
            });
        });

        const speakerTranscripts = Object.keys(speakers).map(speaker => ({
            speaker: parseInt(speaker),
            transcript: speakers[speaker].transcript.trim(),
            wordCount: speakers[speaker].words.length
        }));
        speakerTranscripts.forEach( (speaker) => {
            console.log(`Speaker ${ speaker.speaker }: ${ speaker.wordCount } words`);
            // console.log("transcript:",speaker.transcript);
        });

    // Summarize only speaker 0
    const speaker0 = speakerTranscripts.find(s => s.speaker === 0);
    if (speaker0 && speaker0.transcript) {
        console.log("Speaker 0 transcript:", speaker0.transcript);

        const { summary, topics } = await summarizeTextWithDeepgram(speaker0.transcript);

        // Send to frontend 
        if (sessions[sessionId]?.spectator) {
            sessions[sessionId].spectator.send(JSON.stringify({
                type: 'summary',
                summary,
                topics,
                timestamp: Date.now()
            }));
        }
        if (sessions[sessionId]?.magician) {
            sessions[sessionId].magician.send(JSON.stringify({
                type: 'summarize_complete',
                summary,
                topics,
                timestamp: Date.now()
            }));
        }
    }

    return speakerTranscripts;

} catch (error) {
    console.error("Error processing audio with diarization:", error);
    return [];
}
}

server.listen(PORT, () => console.log(`🚀 AI Magic Server running on port ${PORT}`));
