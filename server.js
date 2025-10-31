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

    console.log(`🔗 Combining ${wavBuffers.length} WAV files...`);

    const WAV_HEADER_SIZE = 44;
    const pcmDataBuffers = wavBuffers.map((buffer, index) => {
        if (buffer.length <= WAV_HEADER_SIZE) {
            console.warn(`⚠️ Chunk ${index + 1} too small (${buffer.length} bytes), skipping`);
            return Buffer.alloc(0);
        }
        return buffer.slice(WAV_HEADER_SIZE);
    });

    const combinedPCM = Buffer.concat(pcmDataBuffers.filter(b => b.length > 0));
    console.log(`📊 Total PCM data: ${combinedPCM.length} bytes`);

    const firstBuffer = wavBuffers[0];
    const numChannels = firstBuffer.readUInt16LE(22);
    const sampleRate = firstBuffer.readUInt32LE(24);
    const bitsPerSample = firstBuffer.readUInt16LE(34);

    console.log(`🎵 Format: ${sampleRate}Hz, ${numChannels}ch, ${bitsPerSample}bit`);

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
    console.log('Summarizing with Deepgram...');
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

// Helper function to normalize text for keyword matching
function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '') // remove punctuation
        .replace(/\s{2,}/g, ' ') // normalize spaces
        .trim();
}

function extractTextBetweenKeywords(fullText, startKeyword, endKeyword) {
    if (!fullText || fullText.trim().length === 0) return "";

    const normalizedText = normalizeText(fullText);
    const normalizedStart = normalizeText(startKeyword || "");
    const normalizedEnd = normalizeText(endKeyword || "");

    console.log(`Searching between "${startKeyword}" and "${endKeyword}"`);
    console.log(`Full text: "${normalizedText.substring(0, 200)}..."`);

    const startIndex = normalizedStart
        ? normalizedText.indexOf(normalizedStart)
        : -1;
    const endIndex = normalizedEnd
        ? normalizedText.lastIndexOf(normalizedEnd)
        : -1;

    let extracted = "";

    // Both keywords exist but nothing between → return empty
    if (
        startIndex !== -1 &&
        endIndex !== -1 &&
        endIndex > startIndex &&
        endIndex <= startIndex + normalizedStart.length + 1
    ) {
        console.log("Only keywords found, no text between");
        return "";
    }

    // Start keyword found, but no (or invalid) end keyword
    if (startIndex !== -1 && (endIndex === -1 || endIndex <= startIndex)) {
        extracted = fullText.substring(startIndex + startKeyword.length).trim();
        console.log(`Extracted after start keyword: "${extracted}"`);
        return extracted;
    }

    // End keyword found but no start keyword
    if (endIndex !== -1 && startIndex === -1) {
        extracted = fullText.substring(0, endIndex).trim();
        console.log(`Extracted before end keyword: "${extracted}"`);
        return extracted;
    }

    // Both keywords found and valid → normal extraction
    if (startIndex !== -1 && endIndex > startIndex) {
        extracted = fullText.substring(
            startIndex + startKeyword.length,
            endIndex
        ).trim();
        console.log(`Extracted between start & end: "${extracted}"`);
        return extracted;
    }

    // Default fallback
    console.log("No keywords detected, returning full text");
    return fullText.trim();
}


// DIARIZATION & PROCESSING

async function processDiarization(audioBuffer, sessionId, language, startKeyword, endKeyword) {
    console.log(`\n ========== DIARIZATION START ==========`);
    console.log(`Session: ${sessionId} | Audio: ${audioBuffer.length} bytes`);
    console.log(`Language: ${language}`);
    console.log(`Keywords - Start: "${startKeyword}", End: "${endKeyword}"`);

    try {
        const tempFilePath = path.join(tempDir, `magic_${sessionId}_${Date.now()}.wav`);
        fs.writeFileSync(tempFilePath, audioBuffer);

        console.log(`Sending to Deepgram for transcription...`);
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

        console.log(`Deepgram response received`);

        if (error) {
            console.error("Diarization error:", error);
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'diarization_error',
                    error: 'deepgram_error',
                    message: 'Transcription failed. Please try again.',
                    timestamp: Date.now()
                }));
            }
            return;
        }

        const speakers = {};
        const channels = result.results?.channels || [];

        console.log(`Channels received: ${channels.length}`);

        // Also check for non-diarized transcript as fallback
        let fullTranscript = '';

        channels.forEach((channel, channelIndex) => {
            console.log(`Channel ${channelIndex}: ${channel.alternatives?.length || 0} alternatives`);

            channel.alternatives.forEach((alt, altIndex) => {
                const transcriptPreview = alt.transcript?.substring(0, 100) || 'empty';
                console.log(`Alternative ${altIndex}: "${transcriptPreview}${alt.transcript?.length > 100 ? '...' : ''}"`);

                // Store full transcript as backup
                if (alt.transcript) {
                    fullTranscript += alt.transcript + ' ';
                }

                if (alt.words && alt.words.length > 0) {
                    console.log(`  Words count: ${alt.words.length}`);
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

        console.log(`Found ${Object.keys(speakers).length} speaker(s) via diarization`);
        console.log(`Full transcript (non-diarized): "${fullTranscript.trim().substring(0, 200)}..."`);

        Object.keys(speakers).forEach(speakerId => {
            const speaker = speakers[speakerId];
            const preview = speaker.transcript.substring(0, 200);
            console.log(`Speaker ${speakerId}: ${speaker.transcript.length} chars`);
            console.log(`Text: "${preview}${speaker.transcript.length > 200 ? '...' : ''}"`);
        });

        // Use speaker 0 if available, otherwise fall back to full transcript
        let transcriptToProcess = '';

        if (speakers[0] && speakers[0].transcript && speakers[0].transcript.trim().length > 0) {
            transcriptToProcess = speakers[0].transcript.trim();
            console.log(`Using Speaker 0 transcript (${transcriptToProcess.length} chars)`);
        } else if (fullTranscript.trim().length > 0) {
            transcriptToProcess = fullTranscript.trim();
            console.log(`No speaker 0 found, using full transcript as fallback (${transcriptToProcess.length} chars)`);
        } else {
            console.log('No transcript found at all');

            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'diarization_error',
                    error: 'no_speaker_detected',
                    message: 'No speech detected. Please speak louder or try again.',
                    timestamp: Date.now()
                }));
                console.log('Error notification sent to magician');
            }
            return;
        }

        if (transcriptToProcess) {
            console.log(`\n ========== TEXT FILTERING ==========`);
            // Send transcriptToProcess directly to magician
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: "magic_transcript",
                    text: transcriptToProcess.trim(),
                    timestamp: Date.now()
                }));
                // console.log("Sent magic_transcript to magician");
            }

            // Extract text between keywords
            const filteredText = extractTextBetweenKeywords(transcriptToProcess, startKeyword, endKeyword);

            const cleanFilteredText = filteredText.replace(/[^\w\s]/g, '').trim(); // remove punctuation

            if (!cleanFilteredText || cleanFilteredText.length < 2) {
                console.log(`Filtered text too short or invalid: "${filteredText}"`);
                if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                    sessions[sessionId].magician.send(JSON.stringify({
                        type: 'no_recording_error',
                        error: 'text_too_short',
                        message: 'No meaningful speech detected. Please speak at least 2 characters of text.',
                        timestamp: Date.now()
                    }));
                }
                return; // stop further processing
            }
            console.log(`Original transcript: ${transcriptToProcess.length} chars`);
            console.log(`Filtered transcript: ${filteredText.length} chars`);
            console.log(`Filtered text: "${filteredText.substring(0, 200)}..."`);

            let summary = filteredText;
            let topic = null;

            console.log(`\n ========== SUMMARIZATION ==========`);

            if (typeof language === 'string' && language.toLowerCase().startsWith('en')) {
                // Use Deepgram directly for English
                console.log('Processing in English directly');
                const dgResult = await summarizeTextWithDeepgram(filteredText, language);
                summary = dgResult.summary;
                topic = dgResult.topic || (summary.split(/\s+/).length > 6 ? summary.split(/\s+/).slice(0, 6).join(' ') + '...' : summary);
            } else {
                // For non-English: Translate → Deepgram → Translate back
                console.log(`Processing non-English (${language})`);
                try {
                    console.log('Translating to English...');
                    const translatedTranscript = await translateText(filteredText, 'en');
                    console.log(`Translated: "${translatedTranscript.substring(0, 100)}..."`);

                    console.log('Getting summary/topic in English...');
                    const dgResult = await summarizeTextWithDeepgram(translatedTranscript, 'en');

                    console.log('Translating back to original language...');
                    summary = await translateText(dgResult.summary, language);
                    topic = await translateText(dgResult.topic || dgResult.summary, language);

                    console.log(`Final summary: "${summary}"`);
                    console.log(`Final topic: "${topic}"`);

                } catch (translationError) {
                    console.error('Translation process failed, using fallback:', translationError);
                    summary = filteredText;
                    topic = filteredText.split(' ').slice(0, 4).join(' ');
                }
            }

            // Final fallback: ensure topic is never null
            if (!topic || topic === "null" || topic.trim().length === 0) {
                console.log('Topic empty, using summary as topic');
                topic = summary;
            }

            console.log(`\n ========== FINAL RESULTS ==========`);
            console.log(`Summary: "${summary}"`);
            console.log(`Topic: "${topic}"`);

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

            console.log(` ========== DIARIZATION END ==========\n`);
        }

    } catch (error) {
        console.error("Diarization error:", error);
        if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
            sessions[sessionId].magician.send(JSON.stringify({
                type: 'diarization_error',
                error: 'processing_error',
                message: 'Error processing audio. Please try again.',
                timestamp: Date.now()
            }));
        }
    }
}


app.post('/api/process-audio-chunk', upload.single('audio'), async (req, res) => {
    const { sessionId, startKeyword, endKeyword, isMagicActive, chunkNumber, language = 'en' } = req.body;

    console.log(`\n ========== CHUNK ${chunkNumber} ==========`);
    // console.log(`Session: ${sessionId}`);
    console.log(`Magic Active: ${isMagicActive}`);
    // console.log(`Language: ${language}`);
    // console.log(`Keywords - Start: "${startKeyword}", End: "${endKeyword}"`);

    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const filePath = req.file.path;

    try {
        const audioBuffer = fs.readFileSync(filePath);
        // console.log(`Size: ${audioBuffer.length} bytes`);

        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-3',
            smart_format: true,
            endpointing: 500,
            language: language,
            timeout: 15000
        });

        fs.unlinkSync(filePath);

        if (error) {
            console.error('Deepgram error:', error);
            return res.status(500).json({ error: 'Transcription failed' });
        }

        const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        console.log(`Transcript: "${transcript}"`);

        if (!audioChunks[sessionId]) {
            audioChunks[sessionId] = {
                chunks: [],
                isRecording: false,
                startKeyword: startKeyword,
                endKeyword: endKeyword,
                language: language
            };
        }

        // Update keywords and language for the session - ALWAYS update with latest values
        audioChunks[sessionId].startKeyword = startKeyword || audioChunks[sessionId].startKeyword;
        audioChunks[sessionId].endKeyword = endKeyword || audioChunks[sessionId].endKeyword;
        audioChunks[sessionId].language = language || audioChunks[sessionId].language;

        console.log(`Session keywords - Start: "${audioChunks[sessionId].startKeyword}", End: "${audioChunks[sessionId].endKeyword}"`);

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
            console.log('START KEYWORD DETECTED - Begin storing chunks');
            console.log(`Start keyword: "${startKeyword}" found in: "${transcript}"`);
            audioChunks[sessionId].chunks = [];
            audioChunks[sessionId].isRecording = true;

            // IMPORTANT: Store the chunk that contains the start keyword
            audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(` Stored chunk ${audioChunks[sessionId].chunks.length} (${audioBuffer.length} bytes) - Contains start keyword`);
            console.log(` Transcript: "${transcript}"`);

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

        // Store chunk if recording (but not if it contains end keyword)
        if (audioChunks[sessionId].isRecording && !hasEndKeyword) {
            audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(`Stored chunk ${audioChunks[sessionId].chunks.length} (${audioBuffer.length} bytes)`);
            console.log(` Transcript: "${transcript}"`);
        }

        // End keyword detected
        if (hasEndKeyword && isMagicActive === 'true') {
            console.log('END KEYWORD DETECTED - Processing stored audio');
            console.log(`End keyword: "${endKeyword}" found in: "${transcript}"`);

            audioChunks[sessionId].isRecording = false;

            // IMPORTANT: Store the chunk that contains the end keyword
            audioChunks[sessionId].chunks.push(audioBuffer);
            console.log(`Stored chunk ${audioChunks[sessionId].chunks.length} (${audioBuffer.length} bytes) - Contains end keyword`);
            console.log(`Transcript: "${transcript}"`);

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
                console.log(`🎬 Processing ${audioChunks[sessionId].chunks.length} stored chunks`);
                const combinedAudio = combineWavBuffers(audioChunks[sessionId].chunks);
                console.log(`Combined audio size: ${combinedAudio.length} bytes`);

                processDiarization(
                    combinedAudio,
                    sessionId,
                    audioChunks[sessionId].language || language,
                    audioChunks[sessionId].startKeyword,
                    audioChunks[sessionId].endKeyword
                ).catch(err =>
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


wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
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
                console.log(`✅ ${clientRole} joined session: ${sessionId}`);

                ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole }));

                if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                    console.log(`🎉 Both users ready in session: ${sessionId}`);
                    if (sessions[sessionId].magician.readyState === 1) {
                        sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                    }
                    if (sessions[sessionId].spectator.readyState === 1) {
                        sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                    }
                }
            }

            if (data.type === 'manual_start') {
                const { sessionId, startKeyword, endKeyword, language = 'en' } = data;
                console.log(`\n ========== MANUAL START ==========`);
                console.log(`Session: ${sessionId}`);
                console.log(`Keywords - Start: "${startKeyword}", End: "${endKeyword}"`);
                console.log(`Language: ${language}`);

                // Initialize audio chunks storage
                if (!audioChunks[sessionId]) {
                    audioChunks[sessionId] = {
                        chunks: [],
                        isRecording: false,
                        startKeyword: startKeyword,
                        endKeyword: endKeyword,
                        language: language
                    };
                } else {
                    audioChunks[sessionId].startKeyword = startKeyword;
                    audioChunks[sessionId].endKeyword = endKeyword;
                    audioChunks[sessionId].language = language;
                }

                // Start recording
                audioChunks[sessionId].chunks = [];
                audioChunks[sessionId].isRecording = true;
                console.log('Manual start - Recording activated');

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
                console.log(`\n========== MANUAL STOP ==========`);
                console.log(`Session: ${sessionId}`);

                if (audioChunks[sessionId] && audioChunks[sessionId].chunks.length > 0) {
                    audioChunks[sessionId].isRecording = false;

                    const combinedAudio = combineWavBuffers(audioChunks[sessionId].chunks);
                    console.log(`Processing ${audioChunks[sessionId].chunks.length} chunks (${combinedAudio.length} bytes)`);
                    console.log(`Using keywords - Start: "${audioChunks[sessionId].startKeyword}", End: "${audioChunks[sessionId].endKeyword}"`);

                    processDiarization(
                        combinedAudio,
                        sessionId,
                        audioChunks[sessionId].language || language,
                        audioChunks[sessionId].startKeyword,
                        audioChunks[sessionId].endKeyword
                    ).catch(err =>
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
                            message: wasRecording
                                ? 'No audio captured during magic. Recording was too short or silent.'
                                : 'Magic was never started. Please start magic before stopping.',
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
        console.log(`🔌 Connection closed: ${clientRole} in session ${sessionId}`);
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            if (Object.keys(sessions[sessionId]).length === 0) {
                delete sessions[sessionId];
                delete speechHistory[sessionId];
                delete audioChunks[sessionId];
                console.log(`Cleaned up session: ${sessionId}`);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});


server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 Magic Server Running`);
})
