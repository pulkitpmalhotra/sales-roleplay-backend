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
const corsOptions = {
  origin: [
    'https://sales-roleplay-frontend.vercel.app',
    'http://localhost:3000',
    'https://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));

// Add explicit OPTIONS handler
app.options('*', cors(corsOptions));
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
// Open AI Chat
app.post('/api/ai/chat', authenticateToken, async (req, res) => {
  try {
    const { sessionId, userMessage, scenarioId, conversationHistory = [] } = req.body;
    
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    const rows = await scenariosSheet.getRows();
    const scenario = rows.find(row => 
      row.get('scenario_id') === scenarioId || 
      row.get('id') === scenarioId
    );
    
    if (!scenario) {
      return res.status(404).json({ error: 'Scenario not found' });
    }
    
    // Use the detailed AI prompts from the sheet
    const systemPrompt = scenario.get('ai_prompts') || 
      `You are ${scenario.get('ai_character_name')}, a ${scenario.get('ai_character_role')}.
       Personality: ${scenario.get('ai_character_personality')}
       Background: ${scenario.get('ai_character_background')}
       
       Respond naturally as this character would. Keep responses 1-2 sentences.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-6).map(msg => ({
        role: msg.speaker === 'user' ? 'user' : 'assistant',
        content: msg.message
      })),
      { role: "user", content: userMessage }
    ];
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      max_tokens: 120,
      temperature: 0.8
    });
    
    const aiResponse = completion.choices[0].message.content;
    
    res.json({
      response: aiResponse,
      character: scenario.get('ai_character_name')
    });
    
  } catch (error) {
    console.error('Error in /api/ai/chat:', error);
    res.json({
      response: "I'm sorry, could you repeat that?",
      character: "AI Assistant"
    });
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
    console.log('🔍 Scenarios endpoint called by user:', req.user.uid);
    
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    if (!scenariosSheet) {
      console.error('❌ Scenarios sheet not found');
      return res.status(500).json({ error: 'Scenarios sheet not found' });
    }
    
    const rows = await scenariosSheet.getRows();
    console.log('📊 Found rows:', rows.length);
    
    const scenarios = [];
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      try {
        // Check if row has basic required data
        const title = row.get('title');
        if (!title) {
          console.log('⚠️ Skipping row without title:', row.rowNumber);
          continue;
        }
        
        // Parse key_objections safely
        let keyObjections = [];
        try {
          const objectionsValue = row.get('key_objections');
          if (objectionsValue) {
            // Try to parse as JSON, with multiple fallback methods
            let cleanValue = objectionsValue;
            if (typeof cleanValue === 'string') {
              // Replace single quotes with double quotes
              cleanValue = cleanValue.replace(/'/g, '"');
              // Remove any extra brackets
              cleanValue = cleanValue.replace(/^\[|\]$/g, '');
              // Split by comma if it's not proper JSON
              if (!cleanValue.startsWith('[')) {
                cleanValue = `[${cleanValue}]`;
              }
            }
            keyObjections = JSON.parse(cleanValue);
          }
        } catch (parseError) {
          console.log('⚠️ Could not parse key_objections for row', row.rowNumber, ':', row.get('key_objections'));
          keyObjections = []; // Default to empty array
        }
        
        const scenario = {
          // Basic info (safe with fallbacks)
          scenario_id: row.get('scenario_id') || row.get('id') || `scenario_${row.rowNumber}`,
          id: row.get('id') || row.get('scenario_id') || row.rowNumber.toString(),
          title: title,
          description: row.get('description') || 'No description provided',
          difficulty: row.get('difficulty') || 'Medium',
          category: row.get('category') || 'General',
          
          // AI Character details (safe with fallbacks)
          ai_character_name: row.get('ai_character_name') || 'Sarah Mitchell',
          ai_character_role: row.get('ai_character_role') || 'Business Professional',
          ai_character_personality: row.get('ai_character_personality') || 'Professional, helpful',
          ai_character_background: row.get('ai_character_background') || 'Works in business',
          
          // Google Ads specific (safe with fallbacks)
          sales_skill_area: row.get('sales_skill_area') || 'General Sales',
          buyer_persona: row.get('buyer_persona') || 'Business Professional',
          google_ads_focus: row.get('google_ads_focus') || 'General Marketing',
          business_vertical: row.get('business_vertical') || 'General Business',
          campaign_complexity: row.get('campaign_complexity') || 'Beginner',
          
                   // Training details (safe with fallbacks)
          key_objections: keyObjections,
          success_metrics: row.get('success_metrics') || 'Complete the conversation successfully',
          coaching_focus: row.get('coaching_focus') || 'General communication skills',
          scenario_objectives: row.get('scenario_objectives') || 'Practice sales conversation',
          estimated_duration: parseInt(row.get('estimated_duration')) || 10,
          ai_prompts: row.get('ai_prompts') || `You are a professional business person having a conversation.`,
          usage_count: parseInt(row.get('usage_count')) || 0,
          is_active: row.get('is_active') !== 'FALSE' // Default to active unless explicitly FALSE
        };
        
        scenarios.push(scenario);
        console.log('✅ Successfully processed scenario:', scenario.title);
        
      } catch (rowError) {
        console.error('❌ Error processing row', row.rowNumber, ':', rowError.message);
        // Continue to next row instead of failing completely
        continue;
      }
    }
    
    console.log('📊 Final scenarios count:', scenarios.length);
    res.json(scenarios);
    
  } catch (error) {
    console.error('❌ Fatal error in scenarios endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to fetch scenarios', 
      details: error.message 
    });
  }
});
// Add this test endpoint to debug Google Sheets
app.get('/api/test-sheets', authenticateToken, async (req, res) => {
  try {
    console.log('🧪 Testing Google Sheets connection...');
    
    // Test sheet access
    const sheets = doc.sheetsByTitle;
    console.log('📊 Available sheets:', Object.keys(sheets));
    
    // Test Scenarios sheet specifically
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    if (!scenariosSheet) {
      return res.json({ error: 'Scenarios sheet not found', availableSheets: Object.keys(sheets) });
    }
    
    const rows = await scenariosSheet.getRows();
    console.log('📊 Raw rows count:', rows.length);
    
    // Show raw data for first few rows
    const rawData = rows.slice(0, 3).map(row => ({
      rowNumber: row.rowNumber,
      rawData: row._rawData,
      values: {
        id: row.get('id'),
        scenario_id: row.get('scenario_id'),
        title: row.get('title'),
        description: row.get('description')
      }
    }));
    
    res.json({
      success: true,
      sheetsFound: Object.keys(sheets),
      rowsCount: rows.length,
      sampleData: rawData
    });
    
  } catch (error) {
    console.error('❌ Sheets test error:', error);
    res.status(500).json({ error: error.message });
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
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    const scenarioRows = await scenariosSheet.getRows();
    const scenario = scenarioRows.find(row => 
      row.get('scenario_id') === scenarioId || 
      row.get('id') === scenarioId
    );
    
    res.json({
      analysis: {
        ...analysis,
        aiFeedback: aiFeedback,
        skillArea: scenario?.get('sales_skill_area') || 'Sales Skills', // Add this
        scenarioTitle: scenario?.get('title') || 'Practice Session'
      }
    });
    
  } catch (error) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});
// Google Ads-specific session analysis
app.post('/api/sessions/analyze-google-ads', authenticateToken, async (req, res) => {
  try {
    const { sessionId, transcript, conversationHistory, scenarioId } = req.body;
    
    // Get scenario context
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    const rows = await scenariosSheet.getRows();
    const scenario = rows.find(row => row.get('scenario_id') === scenarioId);
    
    // Google Ads specific analysis
    const googleAdsAnalysis = analyzeGoogleAdsPerformance(transcript, conversationHistory, scenario);
    
    // Enhanced AI feedback with Google Ads coaching
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{
        role: "system",
        content: `You are a Google Ads sales coach. Analyze this roleplay performance and provide specific feedback on:
        
        1. Google Ads product knowledge accuracy
        2. Objection handling for digital advertising concerns  
        3. Discovery questions for understanding client needs
        4. Explanation clarity of technical concepts
        5. Business value demonstration
        
        Be specific about what they did well and what to improve. Focus on Google Ads selling skills.
        
        Scenario: ${scenario?.get('title')}
        Skill Area: ${scenario?.get('sales_skill_area')}
        Buyer Persona: ${scenario?.get('buyer_persona')}`
      }, {
        role: "user",
        content: `Analyze this Google Ads sales conversation:\n\n${conversationHistory.map(msg => 
          `${msg.speaker === 'user' ? 'Seller' : 'Buyer'}: ${msg.message}`
        ).join('\n')}`
      }],
      max_tokens: 400
    });
    
    const aiFeedback = completion.choices[0].message.content;
    
    res.json({
      analysis: {
        ...googleAdsAnalysis,
        aiFeedback,
        skillArea: scenario?.get('sales_skill_area'),
        coachingRecommendations: generateCoachingRecommendations(googleAdsAnalysis)
      }
    });
    
  } catch (error) {
    console.error('Error analyzing Google Ads performance:', error);
    res.status(500).json({ error: 'Failed to analyze performance' });
  }
});

// Google Ads performance analysis function
function analyzeGoogleAdsPerformance(transcript, conversationHistory, scenario) {
  const userMessages = conversationHistory.filter(msg => msg.speaker === 'user');
  const allUserText = userMessages.map(msg => msg.message).join(' ').toLowerCase();
  
  // Google Ads concept recognition
  const googleAdsConcepts = [
    'quality score', 'cpc', 'ctr', 'roas', 'performance max', 'smart campaigns',
    'search campaigns', 'display network', 'youtube ads', 'shopping campaigns',
    'keyword research', 'negative keywords', 'bidding strategy', 'ad extensions',
    'conversion tracking', 'remarketing', 'audience targeting', 'budget optimization'
  ];
  
  const conceptsUsed = googleAdsConcepts.filter(concept => 
    allUserText.includes(concept.toLowerCase())
  );
  
  // Discovery questions analysis
  const discoveryQuestions = userMessages.filter(msg => 
    msg.message.includes('?') && (
      msg.message.toLowerCase().includes('goal') ||
      msg.message.toLowerCase().includes('currently') ||
      msg.message.toLowerCase().includes('budget') ||
      msg.message.toLowerCase().includes('target') ||
      msg.message.toLowerCase().includes('competition')
    )
  ).length;
  
  // Objection handling detection
  const objectionHandling = userMessages.filter(msg =>
    msg.message.toLowerCase().includes('understand') ||
    msg.message.toLowerCase().includes('let me explain') ||
    msg.message.toLowerCase().includes('for example') ||
    msg.message.toLowerCase().includes('actually')
  ).length;
  
  // Calculate scores (1-5 scale)
  return {
    discovery_score: Math.min(5, Math.max(1, Math.ceil(discoveryQuestions / 2))),
    product_knowledge_score: Math.min(5, Math.max(1, conceptsUsed.length)),
    objection_handling_score: Math.min(5, Math.max(1, objectionHandling)),
    solution_fit_score: Math.min(5, Math.max(1, conceptsUsed.includes('performance max') || conceptsUsed.includes('smart campaigns') ? 4 : 2)),
    clarity_confidence_score: Math.min(5, Math.max(1, Math.ceil(userMessages.length / 3))),
    overall_effectiveness_score: Math.min(5, Math.max(1, Math.ceil((discoveryQuestions + conceptsUsed.length + objectionHandling) / 3))),
    google_ads_concepts_used: conceptsUsed,
    conversation_length: conversationHistory.length,
    user_message_count: userMessages.length
  };
}

function generateCoachingRecommendations(analysis) {
  const recommendations = [];
  
  if (analysis.discovery_score < 3) {
    recommendations.push("Practice asking more discovery questions about client goals and current marketing");
  }
  
  if (analysis.product_knowledge_score < 3) {
    recommendations.push("Study Google Ads products: Performance Max, Smart Campaigns, and Search Campaigns");
  }
  
  if (analysis.objection_handling_score < 3) {
    recommendations.push("Work on addressing budget and ROI concerns with examples and case studies");
  }
  
  return recommendations;
}
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
app.get('/api/sessions/:sessionId/details', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const sessionsSheet = doc.sheetsByTitle['Sessions'];
    const feedbackSheet = doc.sheetsByTitle['Feedback'];
    const scenariosSheet = doc.sheetsByTitle['Scenarios'];
    
    const [sessionRows, feedbackRows, scenarioRows] = await Promise.all([
      sessionsSheet.getRows(),
      feedbackSheet.getRows(),
      scenariosSheet.getRows()
    ]);
    
    const session = sessionRows.find(row => 
      row.get('id') === sessionId && row.get('userId') === req.user.uid
    );
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const feedback = feedbackRows.filter(f => f.get('sessionId') === sessionId);
    const scenarioData = scenarioRows.find(s => 
      s.get('id') === session.get('scenarioId') || 
      s.rowNumber.toString() === session.get('scenarioId')
    );
    
    // Get conversation history from feedback
    const conversationHistory = feedback
      .filter(f => f.get('userMessage') && f.get('aiResponse'))
      .map(f => ({
        userMessage: f.get('userMessage'),
        aiResponse: f.get('aiResponse'),
        timestamp: f.get('timestamp')
      }))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.json({
      session: {
        id: session.get('id'),
        startTime: session.get('startTime'),
        endTime: session.get('endTime'),
        duration: parseInt(session.get('duration')) || 0,
        transcript: session.get('transcript'),
        status: session.get('status')
      },
      scenario: scenarioData ? {
        title: scenarioData.get('title'),
        description: scenarioData.get('description'),
        category: scenarioData.get('category'),
        difficulty: scenarioData.get('difficulty'),
        objectives: scenarioData.get('scenario_objectives')
      } : null,
      feedback: feedback.length > 0 ? {
        talkTimeRatio: parseInt(feedback[0].get('talkTimeRatio')) || 0,
        confidenceScore: parseInt(feedback[0].get('confidenceScore')) || 0,
        fillerWordCount: parseInt(feedback[0].get('fillerWordCount')) || 0,
        conversationLength: parseInt(feedback[0].get('conversationLength')) || 0,
        aiFeedback: feedback[0].get('aiFeedback')
      } : null,
      conversationHistory
    });
  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json({ error: 'Failed to fetch session details' });
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
