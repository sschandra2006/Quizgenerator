const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const fileService = require('../services/fileService');
const aiService   = require('../services/aiService');
const urlService  = require('../services/urlService');
const dbService   = require('../services/dbService');
const authService = require('../services/authService');


// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `upload-${suffix}.pdf`);
  },
});
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') cb(null, true);
  else cb(new Error('Only PDF files are allowed'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * POST /api/extract-url
 */
router.post('/extract-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ error: 'URL is required.' });
    }
    console.log(`🌐 Extracting URL: ${url}`);
    const text = await urlService.extractText(url.trim());
    console.log(`✅ Extracted ${text.length} characters from URL`);
    res.json({ success: true, text, url });
  } catch (error) {
    console.error('❌ URL extraction error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to extract URL content.' });
  }
});

/**
 * POST /api/extract
 */
router.post('/extract', (req, res, next) => {
  upload.single('pdf')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(400).json({ error: 'File is too large. Maximum size is 50MB.' });
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }
    console.log(`📄 Extracting PDF: ${req.file.originalname}`)
    const text = await fileService.extractText(req.file.path);
    console.log(`✅ Extracted ${text.length} characters from PDF`);
    res.json({ success: true, text, filename: req.file.originalname });
  } catch (error) {
    console.error('❌ PDF extraction error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to extract PDF text.' });
  }
});

/**
 * POST /api/generate
 */
router.post('/generate', async (req, res) => {
  try {
    const { topic, difficulty, count, extractedText, instructions, source, personality } = req.body;
    console.log('--- GENERATE REQUEST ---');
    console.log('Topic:', topic);
    console.log('Personality:', personality);

    if (!topic && !extractedText) {
      return res.status(400).json({ error: 'Topic or extracted text is required.' });
    }

    const content = extractedText || topic;
    console.log(`🧠 Generating ${count} questions (Level: ${difficulty}, Tone: ${personality})...`);

    const result = await aiService.generateQuiz(content, difficulty, count, instructions, personality);

    res.json({ success: true, quiz: result.questions, metadata: result.metadata });
  } catch (error) {
    console.error('❌ Quiz generation error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to generate quiz.' });
  }
});

/**
 * POST /api/save-session
 * Save a completed quiz session to the database
 */
router.post('/save-session', authService.middleware(), async (req, res) => {
  try {
    const { topic, source, difficulty, questionCount, score, percentage, timeTaken, questions, userAnswers } = req.body;

    if (!topic || questionCount === undefined) {
      return res.status(400).json({ error: 'topic and questionCount are required.' });
    }

    const sessionData = await dbService.saveQuizSession({
      userId: req.userId,
      username: req.username,
      topic, source, difficulty, questionCount, score, percentage, timeTaken, questions, userAnswers,
    });

    if (!sessionData) {
      return res.json({ success: false, message: 'Database not connected — session not saved.' });
    }

    res.json({ success: true, sessionId: sessionData.session._id, xpEarned: sessionData.xpEarned, levelInfo: sessionData.levelInfo });
  } catch (error) {
    console.error('❌ Save session error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history
 * Get recent quiz sessions (for current user)
 */
router.get('/history', authService.middleware(), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const history = await dbService.getHistory(req.userId, limit);
    res.json({ success: true, history });
  } catch (error) {
    console.error('❌ Get history error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/history/:id
 * Get a single quiz session with full question data (protect to user)
 */
router.get('/history/:id', authService.middleware(), async (req, res) => {
  try {
    const session = await dbService.getSessionById(req.params.id, req.userId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    res.json({ success: true, session });
  } catch (error) {
    console.error('❌ Get session error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/history/:id
 */
router.delete('/history/:id', authService.middleware(), async (req, res) => {
  try {
    const ok = await dbService.deleteSession(req.params.id, req.userId);
    res.json({ success: ok });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/stats
 * Return current user's stats
 */
router.get('/stats', authService.middleware(), async (req, res) => {
  try {
    const userStats = await dbService.getUserStats(req.userId);
    res.json({ success: true, stats: userStats || {} });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AI Quiz Generator API is running',
    dbConnected: require('mongoose').connection.readyState === 1,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
