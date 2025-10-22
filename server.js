require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const { translate } = require('@vitalets/google-translate-api');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

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

        console.log(`Deepgram Summary: "${summary}"`);
        console.log(`Topic via Deepgram: "${topic}"`);
        return { summary, topic };
    } catch (err) {
        console.error('Summarization error:', err);
        return { summary: "Error summarizing.", topic: null };
    }
}

async function translateText(text, targetLanguage) {
    try {
        if (!text || text.trim().length === 0) return text;

        console.log(`Translating to ${targetLanguage}: "${text.substring(0, 100)}..."`);
        const result = await translate(text, { to: targetLanguage });
        return result.text;
    } catch (error) {
        console.error('Translation error:', error);
        return text; // Return original text if translation fails
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
        fs.unlinkSync(tempFilePath)


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

        // Process first person (magician) voice only
        const speaker0 = speakers[0];
        if (speaker0 && speaker0.transcript) {
            let summary = speaker0.transcript;
            let topic = null;

            if (typeof language === 'string' && language.toLowerCase().startsWith('en')) {
                // Use Deepgram directly for English
                const dgResult = await summarizeTextWithDeepgram(speaker0.transcript, language);
                summary = dgResult.summary;
                topic = dgResult.topic || summary; // Use summary as fallback if topic is null
            } else {
                // For non-English: Translate → Deepgram → Translate back
                try {
                    // Translate transcript to English for Deepgram processing
                    const translatedTranscript = await translateText(speaker0.transcript, 'en');

                    // Get summary and topic from Deepgram (in English)
                    const dgResult = await summarizeTextWithDeepgram(translatedTranscript, 'en');

                    // Translate results back to original language
                    summary = await translateText(dgResult.summary, language);
                    topic = await translateText(dgResult.topic || dgResult.summary, language);

                } catch (translationError) {
                    console.error('Translation process failed, using fallback:', translationError);
                    // Fallback: use original transcript with simple topic extraction
                    summary = speaker0.transcript;
                    topic = speaker0.transcript.split(' ').slice(0, 4).join(' ');
                }
            }

            // Final fallback: ensure topic is never null
            if (!topic || topic === "null" || topic.trim().length === 0) {
                topic = summary;
            }

            console.log("Final summary:", summary);
            console.log("Final topic:", topic);

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
        } else {
            console.log('No speaker 0 transcript found');

            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'diarization_error',
                    error: 'no_speaker_detected',
                    message: 'No speech detected. Please try again.',
                    timestamp: Date.now()
                }));
                console.log('Error notification sent to magician');
            }
        }

    } catch (error) {
        console.error("Diarization error:", error);
    }
}

//  to normalize text for keyword matching
function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '') // remove punctuation
        .replace(/\s{2,}/g, ' ') // normalize spaces
        .trim();
}


app.post('/api/process-audio-chunk', upload.single('audio'), async (req, res) => {
    const { sessionId, startKeyword, endKeyword, isMagicActive, chunkNumber, language = 'en' } = req.body;

    console.log(`\n Chunk ${chunkNumber} | Session: ${sessionId} | Magic: ${isMagicActive} | Language: ${language}`);

    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const filePath = req.file.path;

    try {
        const audioBuffer = fs.readFileSync(filePath);
        console.log(`Size: ${audioBuffer.length} bytes`);

        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-3',
            // punctuate: true,
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
        console.log(`Transcript: "${transcript}"`);

        if (!audioChunks[sessionId]) {
            audioChunks[sessionId] = { chunks: [], isRecording: false };
        }

        // Send live transcript to magician
        if (sessions[sessionId]?.magician?.readyState === 1) {
            sessions[sessionId].magician.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                timestamp: Date.now()
            }));
        }

        // Normalize transcript and keywords to handle punctuation
        const normalizedTranscript = normalizeText(transcript);
        const normalizedStartKeyword = startKeyword ? normalizeText(startKeyword) : '';
        const normalizedEndKeyword = endKeyword ? normalizeText(endKeyword) : '';

        const hasStartKeyword = normalizedStartKeyword && normalizedTranscript.includes(normalizedStartKeyword);
        const hasEndKeyword = normalizedEndKeyword && normalizedTranscript.includes(normalizedEndKeyword);

        // Start recording
        if (hasStartKeyword && isMagicActive === 'false') {
            console.log('START DETECTED - Begin storing chunks');
            audioChunks[sessionId].chunks = [];
            audioChunks[sessionId].isRecording = true;

            if (sessions[sessionId]?.magician?.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'keyword_detected',
                    keyword: 'start',
                    transcript,
                    timestamp: Date.now()
                }));
            }

            return res.json({ success: true, transcript, keywordDetected: true, keyword: 'start' });
        }

        // Store chunk if recording
        if (audioChunks[sessionId].isRecording && !hasEndKeyword) {
            audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(` Stored chunk ${audioChunks[sessionId].chunks.length} (${audioBuffer.length} bytes)`);
        }

        // End keyword detected
        if (hasEndKeyword && isMagicActive === 'true') {
            console.log('END DETECTED - Processing stored audio');

            audioChunks[sessionId].isRecording = false;

            // Notify magician to stop mic
            if (sessions[sessionId]?.magician?.readyState === 1) {
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
                if (sessions[sessionId]?.magician?.readyState === 1) {
                    sessions[sessionId].magician.send(JSON.stringify({
                        type: 'no_recording_error',
                        error: 'no_chunks_captured',
                        message: 'No audio captured during magic. Recording was too short or silent.',
                        timestamp: Date.now()
                    }));
                    console.log('No chunks error sent to magician');
                }
            }

            return res.json({ success: true, transcript, keywordDetected: true, keyword: 'end' });
        }

        // Send transcript to spectator if magic active
        if (isMagicActive === 'true' && transcript) {
            if (sessions[sessionId]?.spectator?.readyState === 1) {
                sessions[sessionId].spectator.send(JSON.stringify({
                    type: 'transcript',
                    text: transcript,
                    timestamp: Date.now()
                }));
            }
        }

        res.json({ success: true, transcript, keywordDetected: false });

    } catch (err) {
        console.error('Error:', err);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
        res.status(500).json({ error: 'Processing failed', message: err.message });
    }
});


// WebSocket 
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
                const { sessionId, language = 'en' } = data;
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
                    const wasRecording = audioChunks[sessionId]?.isRecording;
                    const errorReason = wasRecording ? 'no_chunks_captured' : 'magic_not_started';

                    console.log(`Manual stop but ${wasRecording ? 'no chunks captured' : 'magic never started'}`);

                    if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                        sessions[sessionId].magician.send(JSON.stringify({
                            type: 'no_recording_error',
                            error: errorReason,
                            message: 'No audio captured during magic. Recording was too short or silent.',
                            timestamp: Date.now()
                        }));
                    }
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