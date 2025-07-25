// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const { AnalyzerEngine, RecognizerRegistry } = require('@microsoft/presidio-analyzer-nodejs');
const { AnonymizerEngine } = require('@microsoft/presidio-anonymizer-nodejs');

// Initialize Firebase Admin
const serviceAccount = require('./config/firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize PII detection
const registry = new RecognizerRegistry();
const analyzer = new AnalyzerEngine(registry);
const anonymizer = new AnonymizerEngine();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Google Sheets setup
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Initialize Google Sheet
let doc;
(async () => {
  doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
})();

// Authentication middleware
const authenticateToken = async (req, res, next) => {
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
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// PII Redaction Service
class PIIRedactionService {
  static async redactText(text) {
    try {
      const results = await analyzer.analyze(text, 'en');
      const anonymizedText = await anonymizer.anonymize(text, results);
      return {
        originalText: text,
        redactedText: anonymizedText.text,
        entitiesFound: results.map(r => ({
          entity: r.entity_type,
          start: r.start,
          end: r.end,
          confidence: r.score
        }))
      };
    } catch (error) {
      console.error('PII redaction error:', error);
      return {
        originalText: text,
        redactedText: text,
        entitiesFound: []
      };
    }
  }
}

// Database Service
class DatabaseService {
  static async addUser(userData) {
    const usersSheet = doc.sheetsByTitle['Users'] || await doc.addSheet({ title: 'Users' });
    await usersSheet.setHeaderRow(['userId', 'email', 'name', 'createdAt', 'lastLogin']);
    await usersSheet.addRow({
      userId: userData.userId,
      email: userData.email,
      name: userData.name,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    });
  }

  static async createSession(sessionData) {
    const sessionsSheet = doc.sheetsByTitle['Sessions'] || await doc.addSheet({ title: 'Sessions' });
    await sessionsSheet.setHeaderRow(['sessionId', 'userId', 'scenario', 'startTime', 'endTime', 'duration', 'meetingId', 'status']);
    await sessionsSheet.addRow({
      sessionId: sessionData.sessionId,
      userId: sessionData.userId,
      scenario: sessionData.scenario,
      startTime: new Date().toISOString(),
      endTime: '',
      duration: '',
      meetingId: sessionData.meetingId,
      status: 'in_progress'
    });
  }

  static async saveAnalysis(analysisData) {
    const analysisSheet = doc.sheetsByTitle['Analysis'] || await doc.addSheet({ title: 'Analysis' });
    await analysisSheet.setHeaderRow([
      'analysisId', 'sessionId', 'userId', 'fillerWordCount', 'talkToListenRatio', 
      'avgPauseLength', 'speakingPace', 'confidence', 'transcript', 'feedback', 'createdAt'
    ]);
    await analysisSheet.addRow({
      analysisId: analysisData.analysisId,
      sessionId: analysisData.sessionId,
      userId: analysisData.userId,
      fillerWordCount: analysisData.metrics.fillerWordCount,
      talkToListenRatio: analysisData.metrics.talkToListenRatio,
      avgPauseLength: analysisData.metrics.avgPauseLength,
      speakingPace: analysisData.metrics.speakingPace,
      confidence: analysisData.metrics.confidence,
      transcript: analysisData.transcript,
      feedback: analysisData.feedback,
      createdAt: new Date().toISOString()
    });
  }

  static async getUserSessions(userId) {
    const sessionsSheet = doc.sheetsByTitle['Sessions'];
    if (!sessionsSheet) return [];
    
    const rows = await sessionsSheet.getRows();
    return rows.filter(row => row.userId === userId).map(row => ({
      sessionId: row.sessionId,
      scenario: row.scenario,
      startTime: row.startTime,
      status: row.status
    }));
  }
}

// Analysis Service
class AnalysisService {
  static analyzeTranscript(transcript) {
    // Filler word detection
    const fillerWords = ['um', 'uh', 'like', 'you know', 'so', 'actually', 'basically'];
    const words = transcript.toLowerCase().split(/\s+/);
    const fillerWordCount = words.filter(word => 
      fillerWords.includes(word.replace(/[.,!?]/g, ''))
    ).length;

    // Speaking pace (rough estimate)
    const wordCount = words.length;
    const speakingPace = wordCount; // This would need actual duration

    // Simple confidence scoring based on filler words and word count
    const confidence = Math.max(0, Math.min(1, 1 - (fillerWordCount / wordCount) * 2));

    return {
      fillerWordCount,
      talkToListenRatio: 0.8, // This would need actual audio analysis
      avgPauseLength: 1.5, // This would need actual audio analysis
      speakingPace,
      confidence: parseFloat(confidence.toFixed(2))
    };
  }

  static async generateFeedback(transcript, metrics) {
    try {
      const prompt = `Analyze this elevator pitch transcript and provide constructive feedback:

Transcript: "${transcript}"

Metrics:
- Filler words: ${metrics.fillerWordCount}
- Speaking pace: ${metrics.speakingPace} words
- Confidence score: ${metrics.confidence}

Provide specific, actionable feedback for improving the pitch in 2-3 sentences.`;

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200
      });

      return response.choices[0].message.content;
    } catch (error) {
      console.error('OpenAI error:', error);
      return "Unable to generate detailed feedback at this time. Focus on reducing filler words and speaking with more confidence.";
    }
  }
}

// Routes

// Authentication
app.post('/api/auth/register', authenticateToken, async (req, res) => {
  try {
    const userData = {
      userId: req.user.uid,
      email: req.user.email,
      name: req.user.name || req.user.email
    };
    
    await DatabaseService.addUser(userData);
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Scenarios
app.get('/api/scenarios', authenticateToken, (req, res) => {
  const scenarios = [
    {
      scenarioId: 'elevator_pitch_google_ads',
      title: '30 Second Elevator Pitch for Google Ads Search',
      description: 'Practice your elevator pitch to a marketing director interested in Google Ads Search campaigns.',
      duration: 30,
      aiPersona: {
        name: 'Sarah Chen',
        role: 'Marketing Director',
        personality: 'Professional, curious, time-conscious',
        background: 'Works at a mid-size e-commerce company looking to improve online visibility'
      },
      evaluationCriteria: ['clarity', 'value_proposition', 'confidence', 'time_management']
    },
    {
      scenarioId: 'cold_call_intro',
      title: 'Cold Call Introduction',
      description: 'Practice introducing yourself and your services in a cold call scenario.',
      duration: 60,
      aiPersona: {
        name: 'Mike Johnson',
        role: 'Business Owner',
        personality: 'Busy, skeptical, results-oriented',
        background: 'Owns a local retail business, gets many sales calls'
      },
      evaluationCriteria: ['engagement', 'value_proposition', 'objection_handling']
    }
  ];
  
  res.json(scenarios);
});

// Sessions
app.post('/api/sessions/create', authenticateToken, async (req, res) => {
  try {
    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const meetingId = 'meet_' + Date.now();
    
    const sessionData = {
      sessionId,
      userId: req.user.uid,
      scenario: req.body.scenario,
      meetingId
    };
    
    await DatabaseService.createSession(sessionData);
    
    res.json({
      sessionId,
      meetingId,
      meetingUrl: `https://meet.google.com/${meetingId}` // This would be actual Google Meet integration
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/sessions/user/:userId', authenticateToken, async (req, res) => {
  try {
    if (req.params.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const sessions = await DatabaseService.getUserSessions(req.params.userId);
    res.json(sessions);
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

// Analysis
app.post('/api/analysis/generate', authenticateToken, async (req, res) => {
  try {
    const { sessionId, transcript } = req.body;
    
    // Redact PII from transcript
    const redactionResult = await PIIRedactionService.redactText(transcript);
    
    // Analyze transcript
    const metrics = AnalysisService.analyzeTranscript(redactionResult.redactedText);
    
    // Generate AI feedback
    const feedback = await AnalysisService.generateFeedback(redactionResult.redactedText, metrics);
    
    const analysisData = {
      analysisId: 'analysis_' + Date.now(),
      sessionId,
      userId: req.user.uid,
      metrics,
      transcript: redactionResult.redactedText,
      feedback
    };
    
    await DatabaseService.saveAnalysis(analysisData);
    
    res.json({
      analysisId: analysisData.analysisId,
      metrics,
      feedback,
      piiDetected: redactionResult.entitiesFound.length > 0
    });
  } catch (error) {
    console.error('Analysis generation error:', error);
    res.status(500).json({ error: 'Failed to generate analysis' });
  }
});

// Google Meet Integration (Mock)
app.post('/api/meet/create-room', authenticateToken, async (req, res) => {
  try {
    // In a real implementation, this would use Google Meet API
    const meetingId = 'meet_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    res.json({
      meetingId,
      meetingUrl: `https://meet.google.com/${meetingId}`,
      joinUrl: `${process.env.FRONTEND_URL}/session/${meetingId}`
    });
  } catch (error) {
    console.error('Meet room creation error:', error);
    res.status(500).json({ error: 'Failed to create meeting room' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;