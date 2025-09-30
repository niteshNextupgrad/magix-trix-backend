// require('dotenv').config();
// const express = require('express');
// const http = require('http');
// const { WebSocketServer } = require('ws');
// const multer = require('multer');
// const fs = require('fs');
// const path = require('path');
// const { createClient } = require('@deepgram/sdk');
// const cors = require('cors')

// const app = express();
// const server = http.createServer(app);
// const wss = new WebSocketServer({ server });

// const PORT = process.env.PORT || 3001;
// const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

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

//         // Process audio with diarization and log speaker results
//         const speakerTranscripts = await processAudioWithDiarization(audioBuffer, req.body.sessionId || 'unknown');

//         const { result } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
//             model: 'nova-3',
//             punctuate: true,
//             diarize: true,
//             smart_format: true
//         });

//         fs.unlinkSync(filePath); // clean temp file

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
//         const response = await deepgram.read.analyzeText({ text }, { language: 'en', summarize: 'v2', topics: true });

//         const summary = response.result.results?.summary?.text || "No summary available.";
//         const topic = response.result.results.topics?.segments[0]?.topics[0]?.topic;
//         console.log("deepgram Topics:", topic);

//         console.log("deepgram summary:", summary)
//         return { summary, topic };
//     } catch (err) {
//         console.error('Error summarizing text:', err);
//         return { summary: "Error summarizing text.", topics: [] };
//     }
// }
// async function processAudioWithDiarization(audioBuffer, sessionId) {
//     try {
//         console.log(`Processing audio for session ${sessionId}, size: ${audioBuffer.length} bytes`);

//         const tempDir = path.join(__dirname, 'temp');
//         if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

//         const tempFilePath = path.join(tempDir, `audio_${sessionId}_${Date.now()}.wav`);
//         fs.writeFileSync(tempFilePath, audioBuffer);

//         const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
//             fs.readFileSync(tempFilePath),
//             {
//                 model: "nova-3",
//                 punctuate: true,
//                 diarize: true,
//                 smart_format: true,
//                 timeout: 120000
//             }
//         );
//         fs.unlinkSync(tempFilePath);

//         if (error) {
//             console.error("Deepgram SDK error:", error);
//             return [];
//         }

//         if (!result.results || !result.results.channels) {
//             console.log("No channels found in diarization result");
//             return [];
//         }

//         const channels = result.results.channels;
//         let speakers = {};

//         channels.forEach((channel) => {
//             channel.alternatives.forEach((alt) => {
//                 if (alt.words && alt.words.length > 0) {
//                     alt.words.forEach((word) => {
//                         const speaker = word.speaker || 0;
//                         if (!speakers[speaker]) {
//                             speakers[speaker] = { transcript: '', words: [] };
//                         }
//                         speakers[speaker].transcript += (word.punctuated_word || word.word) + ' ';
//                         speakers[speaker].words.push(word);
//                     });
//                 }
//             });
//         });

//         const speakerTranscripts = Object.keys(speakers).map(speaker => ({
//             speaker: parseInt(speaker),
//             transcript: speakers[speaker].transcript.trim(),
//             wordCount: speakers[speaker].words.length
//         }));
//         speakerTranscripts.forEach( (speaker) => {
//             console.log(`Speaker ${ speaker.speaker }: ${ speaker.wordCount } words`);
//             // console.log("transcript:",speaker.transcript);
//         });

//     // Summarize only speaker 0
//     const speaker0 = speakerTranscripts.find(s => s.speaker === 0);
//     if (speaker0 && speaker0.transcript) {
//         console.log("Speaker 0 transcript:", speaker0.transcript);

//         const { summary, topic } = await summarizeTextWithDeepgram(speaker0.transcript);

//         // Send to frontend 
//         if (sessions[sessionId]?.spectator) {
//             sessions[sessionId].spectator.send(JSON.stringify({
//                 type: 'summary',
//                 summary,
//                 topic,
//                 timestamp: Date.now()
//             }));
//         }
//         if (sessions[sessionId]?.magician) {
//             sessions[sessionId].magician.send(JSON.stringify({
//                 type: 'summarize_complete',
//                 summary,
//                 topic,
//                 timestamp: Date.now()
//             }));
//         }
//     }

//     return speakerTranscripts;

// } catch (error) {
//     console.error("Error processing audio with diarization:", error);
//     return [];
// }
// }

// server.listen(PORT, () => console.log(`🚀 AI Magic Server running on port ${PORT}`));
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Sessions & speech history
const sessions = {};
const speechHistory = {};

// Multer setup for audio uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.webm';
        const name = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
        cb(null, name);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'AI Magic Server is running',
        endpoints: {
            chunkProcessing: '/api/process-audio-chunk',
            fullAudio: '/api/upload-audio'
        }
    });
});

// =============== NEW: Process Audio Chunks for Real-time Keyword Detection ===============
app.post('/api/process-audio-chunk', upload.single('audio'), async (req, res) => {
    const { sessionId, startKeyword, endKeyword, isMagicActive, chunkNumber } = req.body;
    
    console.log(`\n📦 === Processing Chunk ${chunkNumber} ===`);
    console.log(`Session: ${sessionId}`);
    console.log(`Magic Active: ${isMagicActive}`);
    console.log(`Keywords: start="${startKeyword}", end="${endKeyword}"`);
    
    if (!req.file) {
        console.error('❌ No audio file provided');
        return res.status(400).json({ error: 'No audio file provided' });
    }

    const filePath = req.file.path;
    
    try {
        const audioBuffer = fs.readFileSync(filePath);
        console.log(`📁 File size: ${audioBuffer.length} bytes`);
        
        // Transcribe with Deepgram (fast model for real-time)
        const startTime = Date.now();
        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-2',  // Faster model for real-time processing
            punctuate: true,
            smart_format: true,
            language: 'en'
        });
        
        const processingTime = Date.now() - startTime;
        console.log(`⏱️ Transcription time: ${processingTime}ms`);

        // Clean up temp file immediately
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.warn('Warning: Could not delete temp file:', err.message);
        }

        if (error) {
            console.error('❌ Deepgram error:', error);
            return res.status(500).json({ error: 'Transcription failed', details: error });
        }

        const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        const transcriptLower = transcript.toLowerCase().trim();

        console.log(`📝 Transcript: "${transcript}"`);

        if (!transcript) {
            console.log('ℹ️ Empty transcript, skipping');
            return res.json({ success: true, transcript: '', keywordDetected: false });
        }

        // Send transcript to magician for display
        if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
            sessions[sessionId].magician.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                timestamp: Date.now()
            }));
            console.log('📤 Sent transcript to magician');
        }

        // Check for keywords
        const hasStartKeyword = startKeyword && transcriptLower.includes(startKeyword.toLowerCase());
        const hasEndKeyword = endKeyword && transcriptLower.includes(endKeyword.toLowerCase());

        console.log(`🔍 Keyword check: start=${hasStartKeyword}, end=${hasEndKeyword}`);

        // START keyword detection (only when magic is NOT active)
        if (hasStartKeyword && isMagicActive === 'false') {
            console.log('🎬 ✅ START KEYWORD DETECTED!');
            
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'keyword_detected',
                    keyword: 'start',
                    transcript: transcript,
                    timestamp: Date.now()
                }));
                console.log('📤 Sent START signal to magician');
            }

            return res.json({ 
                success: true, 
                transcript,
                keywordDetected: true,
                keyword: 'start'
            });
        }

        // END keyword detection (only when magic IS active)
        if (hasEndKeyword && isMagicActive === 'true') {
            console.log('🛑 ✅ END KEYWORD DETECTED!');
            
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'keyword_detected',
                    keyword: 'end',
                    transcript: transcript,
                    timestamp: Date.now()
                }));
                console.log('📤 Sent END signal to magician');
            }

            return res.json({ 
                success: true, 
                transcript,
                keywordDetected: true,
                keyword: 'end'
            });
        }

        // If magic is active, send transcript to spectator in real-time
        if (isMagicActive === 'true' && transcript) {
            if (sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                sessions[sessionId].spectator.send(JSON.stringify({
                    type: 'transcript',
                    word: transcript,
                    timestamp: Date.now()
                }));
                console.log('📤 Sent transcript to spectator');
            }
        }

        console.log('✅ Chunk processed successfully\n');
        res.json({ 
            success: true, 
            transcript,
            keywordDetected: false,
            processingTime 
        });

    } catch (err) {
        console.error('❌ Chunk processing error:', err);
        
        // Clean up file on error
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (cleanupErr) {
            console.error('Error cleaning up file:', cleanupErr);
        }
        
        res.status(500).json({ 
            error: 'Transcription failed',
            message: err.message 
        });
    }
});

// =============== EXISTING: Full Audio Upload (Desktop or final processing) ===============
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
    console.log('\n🎵 === Processing Full Audio ===');
    
    try {
        if (!req.file) {
            console.error('❌ No audio file provided');
            return res.status(400).json({ error: 'No audio file provided' });
        }

        const filePath = req.file.path;
        const audioBuffer = fs.readFileSync(filePath);
        const sessionId = req.body.sessionId || 'unknown';

        console.log(`📁 File: ${req.file.originalname}`);
        console.log(`📊 Size: ${audioBuffer.length} bytes`);
        console.log(`🔑 Session: ${sessionId}`);

        // Process audio with diarization and summarization
        const speakerTranscripts = await processAudioWithDiarization(audioBuffer, sessionId);

        // Also get full transcription
        const { result } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
            model: 'nova-3',
            punctuate: true,
            diarize: true,
            smart_format: true
        });

        // Clean up temp file
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.warn('Warning: Could not delete temp file:', err.message);
        }

        console.log('✅ Full audio processed successfully\n');
        res.json({ 
            message: 'Audio processed successfully', 
            transcription: result,
            speakers: speakerTranscripts 
        });
    } catch (err) {
        console.error('❌ Error processing full audio:', err);
        
        // Clean up file on error
        try {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        } catch (cleanupErr) {
            console.error('Error cleaning up file:', cleanupErr);
        }
        
        res.status(500).json({ error: err.message });
    }
});

// =============== WebSocket Handling ===============
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');
    let sessionId, clientRole;

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            console.log('⚠️ Received binary message, ignoring (use REST API for audio)');
            return;
        }

        try {
            const data = JSON.parse(message.toString());

            // Join session
            if (data.type === 'join') {
                sessionId = data.sessionId;
                clientRole = data.role;
                
                if (!sessions[sessionId]) {
                    sessions[sessionId] = {};
                    speechHistory[sessionId] = [];
                }
                
                sessions[sessionId][clientRole] = ws;

                console.log(`👤 ${clientRole} joined session: ${sessionId}`);

                ws.send(JSON.stringify({ 
                    type: 'joined', 
                    sessionId, 
                    role: clientRole 
                }));

                // Notify both when ready
                if (sessions[sessionId].magician && sessions[sessionId].spectator) {
                    console.log(`✅ Both users present in session ${sessionId}, sending ready signal`);
                    
                    if (sessions[sessionId].magician.readyState === 1) {
                        sessions[sessionId].magician.send(JSON.stringify({ type: 'ready' }));
                    }
                    if (sessions[sessionId].spectator.readyState === 1) {
                        sessions[sessionId].spectator.send(JSON.stringify({ type: 'ready' }));
                    }
                }
            }

            // Live transcript (desktop mode - direct from Speech Recognition)
            else if (data.type === 'transcript') {
                if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
                speechHistory[sessionId].push(data.word);

                console.log(`📝 Transcript from ${clientRole}: "${data.word}"`);

                // Forward to spectator
                if (sessionId && sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                    sessions[sessionId].spectator.send(JSON.stringify({
                        type: 'transcript',
                        word: data.word,
                        timestamp: Date.now()
                    }));
                }
            }

            // Summarize (when magic ends)
            else if (data.type === 'summarize') {
                console.log(`🔄 Summarize request for session ${sessionId}`);
                
                const textToSummarize = data.text || '';
                const finalText = textToSummarize.trim() || speechHistory[sessionId]?.join(' ') || '';

                console.log(`📄 Text to summarize (${finalText.length} chars): "${finalText.substring(0, 100)}..."`);

                if (finalText) {
                    const { summary, topic } = await summarizeTextWithDeepgram(finalText);

                    // Send to spectator
                    if (sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                        sessions[sessionId].spectator.send(JSON.stringify({ 
                            type: 'summary', 
                            summary, 
                            topic, 
                            timestamp: Date.now() 
                        }));
                        console.log('📤 Summary sent to spectator');
                    }

                    // Notify magician
                    if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                        sessions[sessionId].magician.send(JSON.stringify({ 
                            type: 'summarize_complete', 
                            summary, 
                            topic, 
                            timestamp: Date.now() 
                        }));
                        console.log('📤 Summary complete notification sent to magician');
                    }
                } else {
                    console.log('⚠️ No text to summarize');
                }

                speechHistory[sessionId] = [];
            }

            // Test message (for debugging)
            else if (data.type === 'test') {
                console.log(`🧪 Test message from ${clientRole}: ${data.message}`);
                
                if (!speechHistory[sessionId]) speechHistory[sessionId] = [];
                speechHistory[sessionId].push(data.message);

                if (sessionId && sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                    sessions[sessionId].spectator.send(JSON.stringify({
                        type: 'transcript',
                        word: data.message,
                        timestamp: Date.now()
                    }));
                }
            }

        } catch (err) {
            console.error('❌ WebSocket message error:', err);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 WebSocket closed for ${clientRole} in session ${sessionId}`);
        
        if (sessionId && clientRole && sessions[sessionId]) {
            delete sessions[sessionId][clientRole];
            
            // Clean up empty sessions
            if (Object.keys(sessions[sessionId]).length === 0) {
                console.log(`🧹 Cleaning up empty session: ${sessionId}`);
                delete sessions[sessionId];
                delete speechHistory[sessionId];
            }
        }
    });

    ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err);
    });
});

// =============== Helper Functions ===============

async function summarizeTextWithDeepgram(text) {
    console.log('📊 Summarizing text with Deepgram...');
    
    try {
        const response = await deepgram.read.analyzeText(
            { text }, 
            { language: 'en', summarize: 'v2', topics: true }
        );

        const summary = response.result.results?.summary?.text || "No summary available.";
        const topic = response.result.results?.topics?.segments?.[0]?.topics?.[0]?.topic || null;
        
        console.log(`✅ Summary: "${summary.substring(0, 100)}..."`);
        console.log(`🏷️ Topic: "${topic}"`);

        return { summary, topic };
    } catch (err) {
        console.error('❌ Error summarizing text:', err);
        return { summary: "Error summarizing text.", topic: null };
    }
}

async function processAudioWithDiarization(audioBuffer, sessionId) {
    console.log(`\n🎭 === Processing Diarization for Session ${sessionId} ===`);
    console.log(`📊 Audio size: ${audioBuffer.length} bytes`);
    
    try {
        const tempFilePath = path.join(tempDir, `audio_${sessionId}_${Date.now()}.webm`);
        fs.writeFileSync(tempFilePath, audioBuffer);
        console.log(`💾 Saved temp file: ${tempFilePath}`);

        const startTime = Date.now();
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
        
        const processingTime = Date.now() - startTime;
        console.log(`⏱️ Diarization time: ${processingTime}ms`);
        
        // Clean up temp file
        try {
            fs.unlinkSync(tempFilePath);
        } catch (err) {
            console.warn('Warning: Could not delete temp file:', err.message);
        }

        if (error) {
            console.error("❌ Deepgram SDK error:", error);
            return [];
        }

        if (!result.results || !result.results.channels) {
            console.log("⚠️ No channels found in diarization result");
            return [];
        }

        const channels = result.results.channels;
        let speakers = {};

        // Extract speaker transcripts
        channels.forEach((channel) => {
            channel.alternatives.forEach((alt) => {
                if (alt.words && alt.words.length > 0) {
                    alt.words.forEach((word) => {
                        const speaker = word.speaker !== undefined ? word.speaker : 0;
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
        
        console.log(`👥 Found ${speakerTranscripts.length} speaker(s):`);
        speakerTranscripts.forEach((speaker) => {
            console.log(`   Speaker ${speaker.speaker}: ${speaker.wordCount} words`);
        });

        // Summarize only speaker 0 (the magician)
        const speaker0 = speakerTranscripts.find(s => s.speaker === 0);
        if (speaker0 && speaker0.transcript) {
            console.log(`\n🎤 Speaker 0 transcript (${speaker0.transcript.length} chars):`);
            console.log(`"${speaker0.transcript.substring(0, 200)}..."\n`);

            const { summary, topic } = await summarizeTextWithDeepgram(speaker0.transcript);

            // Send to spectator
            if (sessions[sessionId]?.spectator && sessions[sessionId].spectator.readyState === 1) {
                sessions[sessionId].spectator.send(JSON.stringify({
                    type: 'summary',
                    summary,
                    topic,
                    timestamp: Date.now()
                }));
                console.log('📤 Summary sent to spectator');
            }
            
            // Notify magician
            if (sessions[sessionId]?.magician && sessions[sessionId].magician.readyState === 1) {
                sessions[sessionId].magician.send(JSON.stringify({
                    type: 'summarize_complete',
                    summary,
                    topic,
                    timestamp: Date.now()
                }));
                console.log('📤 Summary complete sent to magician');
            }
        } else {
            console.log('⚠️ No Speaker 0 found or empty transcript');
        }

        console.log('✅ Diarization complete\n');
        return speakerTranscripts;

    } catch (error) {
        console.error("❌ Error processing audio with diarization:", error);
        return [];
    }
}

// =============== Server Startup ===============
server.listen(PORT, () => {
    console.log('\n🚀 ====================================');
    console.log(`🚀 AI Magic Server running on port ${PORT}`);
    console.log('🚀 ====================================');
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🌐 Network: Check your IP address`);
    console.log('🚀 ====================================\n');
    console.log('📡 Endpoints:');
    console.log(`   GET  /                          - Health check`);
    console.log(`   POST /api/process-audio-chunk   - Real-time keyword detection`);
    console.log(`   POST /api/upload-audio          - Full audio processing`);
    console.log('🚀 ====================================\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\nSIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});