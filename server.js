const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK);
} catch (error) {
  console.error('Error parsing Firebase credentials:', error);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Google Sheets
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
let doc;

async function initializeSheet() {
  try {
    const jwt = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    doc = new GoogleSpreadsheet(SHEET_ID, jwt);
    await doc.loadInfo();
    
    // Create sheets if they don't exist
    const sheetNames = ['Users', 'Sessions', 'Scenarios', 'Feedback'];
    for (const name of sheetNames) {
      try {
        await doc.sheetsByTitle[name];
      } catch {
        await doc.addSheet({ title: name });
      }
    }
    
    console.log('Google Sheets initialized successfully');
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
  }
}

// PII Redaction Function
function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Email addresses
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]');
  
  // Phone numbers (various formats)
  text = text.replace(/\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g, '[PHONE_REDACTED]');
  
  // Social Security Numbers
  text = text.replace(/\b\d{3}-?\d{2}-?\d{4}\b/g, '[SSN_REDACTED]');
  
  // Credit Card Numbers (basic pattern)
  text = text.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CARD_REDACTED]');
  
  // Names (common patterns - this is basic)
  text = text.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[NAME_REDACTED]');
  
  return text;
}

// Authentication Middleware
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(403).json({ error: 'Invalid token' });
  }
}

// Routes
// Add after your existing routes
app.post('/api/ai/chat', authenticateToken, async (req, res) => {
  try {
    const { sessionId, userMessage, scenarioId, conversationHistory = [] } = req.body;
    
    // Get scenario details
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    const rows = await scenariosSheet.getRows();
    const scenario = rows.find(row => row.get('id') === scenarioId);
    
    if (!scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }
    
    // Build conversation context
    const systemPrompt = `You are ${scenario.get('title')} roleplay scenario. 
    
Character Details:
- Name: Sarah Mitchell (Busy IT Director)
- Company: Mid-size tech company (200 employees)
- Personality: Skeptical, budget-conscious, time-pressed, results-oriented
- Background: Had bad experiences with previous vendors, values efficiency
- Current Situation: Evaluating new solutions but very busy
- Pain Points: Current system is outdated, team productivity issues, budget constraints

Instructions:
- Respond as Sarah would in a real sales call
- Be naturally skeptical but not hostile
- Ask realistic business questions
- Bring up common objections (budget, timing, current solutions)
- Keep responses conversational and realistic (2-3 sentences max)
- Show interest if the salesperson addresses your concerns well
- Be more receptive if they demonstrate value and understanding

Remember: You're in the middle of a busy workday and this is an unscheduled sales call.`;

    // Build conversation history for context
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map(msg => ({
        role: msg.speaker === 'user' ? 'user' : 'assistant',
        content: msg.message
      })),
      { role: "user", content: userMessage }
    ];
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      max_tokens: 150,
      temperature: 0.8 // Add some personality variation
    });
    
    const aiResponse = completion.choices[0].message.content;
    
    // Log conversation for analysis
    const feedbackSheet = doc.sheetsByTitle['Feedback'];
    await feedbackSheet.addRow({
      sessionId: sessionId,
      userId: req.user.uid,
      timestamp: new Date().toISOString(),
      userMessage: userMessage,
      aiResponse: aiResponse,
      scenario: scenarioId
    });
    
    res.json({
      response: aiResponse,
      character: "Sarah Mitchell",
      emotion: "neutral" // Can be enhanced later
    });
    
  } catch (error) {
    console.error('Error generating AI response:', error);
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
});
// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const usersSheet = doc.sheetsByTitle['Users'];
    const rows = await usersSheet.getRows();
    
    let user = rows.find(row => row.get('uid') === req.user.uid);
    
    if (!user) {
      // Create new user
      user = await usersSheet.addRow({
        uid: req.user.uid,
        email: req.user.email,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString()
      });
    } else {
      // Update last active
      user.set('lastActive', new Date().toISOString());
      await user.save();
    }
    
    res.json({
      uid: user.get('uid'),
      email: user.get('email'),
      createdAt: user.get('createdAt')
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Get scenarios
app.get('/api/scenarios', authenticateToken, async (req, res) => {
  try {
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    const rows = await scenariosSheet.getRows();
    
    const scenarios = rows.map(row => ({
      id: row.get('id') || row.rowNumber,
      title: row.get('title'),
      description: row.get('description'),
      difficulty: row.get('difficulty') || 'Medium',
      category: row.get('category') || 'General'
    }));
    
    res.json(scenarios);
  } catch (error) {
    console.error('Error fetching scenarios:', error);
    res.status(500).json({ error: 'Failed to fetch scenarios' });
  }
});

// Create Daily.co room
app.post('/api/video/create-room', authenticateToken, async (req, res) => {
  try {
    console.log('Creating Daily.co room for user:', req.user.uid); // Debug log
    
    const roomData = {
      name: `roleplay-${req.user.uid}-${Date.now()}`,
      privacy: 'public', // Changed from 'private' to 'public'
      properties: {
        max_participants: 10, // Increased from 2
        enable_recording: false,
        enable_transcription: false, // Disabled transcription
        start_video_off: false,
        start_audio_off: false,
        enable_prejoin_ui: false
      }
    };

    console.log('Room data being sent to Daily.co:', roomData); // Debug log

    const response = await axios.post('https://api.daily.co/v1/rooms', roomData, {
      headers: {
        'Authorization': `Bearer ${process.env.DAILY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Daily.co API response:', response.data); // Debug log
    
    res.json({
      roomUrl: response.data.url,
      roomName: response.data.name
    });
  } catch (error) {
    console.error('Error creating Daily.co room:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create video room',
      details: error.response?.data || error.message 
    });
  }
});

// Start session
app.post('/api/sessions/start', authenticateToken, async (req, res) => {
  try {
    const { scenarioId, roomUrl } = req.body;
    
    const sessionsSheet = doc.sheetsByTitle['Sessions'];
    const session = await sessionsSheet.addRow({
      id: `session_${Date.now()}`,
      userId: req.user.uid,
      scenarioId: scenarioId,
      roomUrl: roomUrl,
      startTime: new Date().toISOString(),
      status: 'active'
    });
    
    res.json({
      sessionId: session.get('id'),
      status: 'started'
    });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// End session and analyze
// In your server.js, update the /api/sessions/end endpoint:
app.post('/api/sessions/end', authenticateToken, async (req, res) => {
  try {
    const { sessionId, transcript, duration, conversationHistory = [] } = req.body;
    
    console.log('Ending session:', sessionId); // Debug log
    
    // Redact PII from transcript
    const redactedTranscript = redactPII(transcript);
    
    // Basic analysis
    const analysis = analyzeSession(redactedTranscript);
    
    // Enhanced analysis with conversation data
    if (conversationHistory.length > 0) {
      analysis.conversationLength = conversationHistory.length;
      analysis.userMessages = conversationHistory.filter(msg => msg.speaker === 'user').length;
      analysis.aiMessages = conversationHistory.filter(msg => msg.speaker === 'ai').length;
    }
    
    // Get AI feedback
    let aiFeedback = '';
    try {
      const conversationText = conversationHistory
        .map(msg => `${msg.speaker === 'user' ? 'Salesperson' : 'Customer'}: ${msg.message}`)
        .join('\n');
      
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{
          role: "system",
          content: "You are a sales coach. Analyze this sales roleplay conversation and provide constructive feedback on communication skills, persuasion techniques, and areas for improvement. Keep it concise and actionable."
        }, {
          role: "user",
          content: `Please analyze this sales conversation:\n\n${conversationText.substring(0, 2000)}`
        }],
        max_tokens: 300
      });
      
      aiFeedback = completion.choices[0].message.content;
    } catch (error) {
      console.error('OpenAI API error:', error);
      aiFeedback = 'AI analysis temporarily unavailable. Please try again later.';
    }
    
    // Update session
    const sessionsSheet = doc.sheetsByTitle['Sessions'];
    const rows = await sessionsSheet.getRows();
    const session = rows.find(row => row.get('id') === sessionId);
    
    if (session) {
      session.set('endTime', new Date().toISOString());
      session.set('duration', duration);
      session.set('status', 'completed');
      session.set('transcript', redactedTranscript);
      await session.save();
      console.log('Session updated successfully'); // Debug
    } else {
      console.log('Session not found in sheets:', sessionId); // Debug
    }
    
    // Save feedback
    const feedbackSheet = doc.sheetsByTitle['Feedback'];
    await feedbackSheet.addRow({
      sessionId: sessionId,
      userId: req.user.uid,
      createdAt: new Date().toISOString(),
      talkTimeRatio: analysis.talkTimeRatio,
      fillerWordCount: analysis.fillerWordCount,
      confidenceScore: analysis.confidenceScore,
      aiFeedback: aiFeedback,
      conversationLength: analysis.conversationLength || 0,
      keyMetrics: JSON.stringify(analysis)
    });
    
    console.log('Feedback saved successfully'); // Debug
    
    res.json({
      analysis: {
        ...analysis,
        aiFeedback: aiFeedback
      }
    });
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session', details: error.message });
  }
});
// Get user sessions
app.get('/api/sessions/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 10, offset = 0, scenario, dateFrom, dateTo } = req.query;
    
    const sessionsSheet = doc.sheetsByTitle['Sessions'];
    const feedbackSheet = doc.sheetsByTitle['Feedback'];
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    
    const [sessionRows, feedbackRows, scenarioRows] = await Promise.all([
      sessionsSheet.getRows(),
      feedbackSheet.getRows(),
      scenariosSheet.getRows()
    ]);
    
    // Get user sessions with enhanced data
    let userSessions = sessionRows
      .filter(row => row.get('userId') === req.user.uid)
      .map(session => {
        const feedback = feedbackRows.find(f => f.get('sessionId') === session.get('id'));
        const scenarioData = scenarioRows.find(s => 
          s.get('id') === session.get('scenarioId') || 
          s.rowNumber.toString() === session.get('scenarioId')
        );
        
        return {
          id: session.get('id'),
          scenarioId: session.get('scenarioId'),
          scenarioTitle: scenarioData?.get('title') || 'Unknown Scenario',
          scenarioCategory: scenarioData?.get('category') || 'General',
          scenarioDifficulty: scenarioData?.get('difficulty') || 'Medium',
          startTime: session.get('startTime'),
          endTime: session.get('endTime'),
          duration: parseInt(session.get('duration')) || 0,
          status: session.get('status'),
          feedback: feedback ? {
            talkTimeRatio: parseInt(feedback.get('talkTimeRatio')) || 0,
            fillerWordCount: parseInt(feedback.get('fillerWordCount')) || 0,
            confidenceScore: parseInt(feedback.get('confidenceScore')) || 0,
            conversationLength: parseInt(feedback.get('conversationLength')) || 0,
            aiFeedback: feedback.get('aiFeedback')
          } : null
        };
      })
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime)); // Most recent first
    
    // Apply filters
    if (scenario && scenario !== 'all') {
      userSessions = userSessions.filter(s => s.scenarioId === scenario);
    }
    
    if (dateFrom) {
      userSessions = userSessions.filter(s => new Date(s.startTime) >= new Date(dateFrom));
    }
    
    if (dateTo) {
      userSessions = userSessions.filter(s => new Date(s.startTime) <= new Date(dateTo));
    }
    
    // Pagination
    const total = userSessions.length;
    const paginatedSessions = userSessions.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    // Calculate summary stats
    const completedSessions = userSessions.filter(s => s.status === 'completed');
    const avgConfidence = completedSessions.length > 0 
      ? Math.round(completedSessions.reduce((sum, s) => sum + (s.feedback?.confidenceScore || 0), 0) / completedSessions.length)
      : 0;
    
    const avgDuration = completedSessions.length > 0
      ? Math.round(completedSessions.reduce((sum, s) => sum + s.duration, 0) / completedSessions.length / 60000) // minutes
      : 0;
    
    res.json({
      sessions: paginatedSessions,
      pagination: {
        total,
        offset: parseInt(offset),
        limit: parseInt(limit),
        hasMore: total > (parseInt(offset) + parseInt(limit))
      },
      summary: {
        totalSessions: total,
        completedSessions: completedSessions.length,
        avgConfidenceScore: avgConfidence,
        avgDurationMinutes: avgDuration
      }
    });
  } catch (error) {
    console.error('Error fetching session history:', error);
    res.status(500).json({ error: 'Failed to fetch session history' });
  }
});
// Session Analysis Function
function analyzeSession(transcript) {
  if (!transcript) {
    return {
      talkTimeRatio: 0,
      fillerWordCount: 0,
      confidenceScore: 50,
      wordCount: 0,
      averageSentenceLength: 0
    };
  }
  
  const words = transcript.toLowerCase().split(/\s+/);
  const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  // Count filler words
  const fillerWords = ['um', 'uh', 'like', 'you know', 'basically', 'literally', 'actually'];
  const fillerWordCount = words.filter(word => 
    fillerWords.some(filler => word.includes(filler))
  ).length;
  
  // Calculate confidence score (inverse relationship with filler words)
  const fillerRatio = fillerWordCount / words.length;
  const confidenceScore = Math.max(20, Math.min(100, 100 - (fillerRatio * 200)));
  
  // Calculate average sentence length
  const averageSentenceLength = sentences.length > 0 ? 
    words.length / sentences.length : 0;
  
  // Simple talk time estimation (this would be more accurate with audio analysis)
  const estimatedTalkTime = Math.min(80, Math.max(20, words.length / 10));
  
  return {
    talkTimeRatio: Math.round(estimatedTalkTime),
    fillerWordCount: fillerWordCount,
    confidenceScore: Math.round(confidenceScore),
    wordCount: words.length,
    averageSentenceLength: Math.round(averageSentenceLength * 10) / 10
  };
}

// Initialize and start server
async function startServer() {
  try {
    if (serviceAccount) {
      await initializeSheet();
    }
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
