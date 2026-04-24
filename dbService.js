/* ============================================================
   DB Service v2 — MongoDB Atlas with User + QuizSession models
   ============================================================ */

const mongoose = require('mongoose');

// ── XP / Level helpers ─────────────────────────────────────
const LEVELS = [
  { level: 1, title: 'Novice',      minXP: 0    },
  { level: 2, title: 'Learner',     minXP: 200  },
  { level: 3, title: 'Scholar',     minXP: 500  },
  { level: 4, title: 'Expert',      minXP: 1000 },
  { level: 5, title: 'Master',      minXP: 2000 },
  { level: 6, title: 'Grandmaster', minXP: 5000 },
];

function calcLevel(xp) {
  let current = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.minXP) current = l; else break; }
  const next = LEVELS.find(l => l.minXP > xp) || null;
  return { ...current, nextXP: next ? next.minXP : null, xpToNext: next ? next.minXP - xp : 0 };
}

function calcXP(score, total, difficulty) {
  const mult = { easy: 1, medium: 1.5, hard: 2 }[difficulty] || 1;
  const base = score * 10 * mult;
  const completionBonus = 50;
  const perfectBonus = score === total ? 100 : 0;
  return Math.round(base + completionBonus + perfectBonus);
}

// ── User Schema ────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 30 },
  email:        { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },

  // Stats
  xp:           { type: Number, default: 0 },
  level:        { type: Number, default: 1 },
  levelTitle:   { type: String, default: 'Novice' },
  streak:       { type: Number, default: 0 },
  bestStreak:   { type: Number, default: 0 },
  lastPlayedDate: { type: String, default: null }, // 'YYYY-MM-DD'

  totalQuizzes:     { type: Number, default: 0 },
  totalQuestions:   { type: Number, default: 0 },
  totalCorrect:     { type: Number, default: 0 },
  avgScore:         { type: Number, default: 0 },
  bestScore:        { type: Number, default: 0 },

  achievements: [{ type: String }],
  dailyQuests: [{
    id: String,
    title: String,
    target: Number,
    progress: { type: Number, default: 0 },
    xpReward: Number,
    completed: { type: Boolean, default: false },
    dateAssigned: String
  }],
  createdAt:    { type: Date, default: Date.now },
});

// ── QuizSession Schema ──────────────────────────────────────
const quizSessionSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:      { type: String },
  topic:         { type: String, required: true },
  source:        { type: String, enum: ['text', 'pdf', 'url'], default: 'text' },
  difficulty:    { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  questionCount: { type: Number, required: true },
  score:         { type: Number, default: 0 },
  percentage:    { type: Number, default: 0 },
  timeTaken:     { type: Number, default: 0 },
  xpEarned:     { type: Number, default: 0 },
  questions:     { type: mongoose.Schema.Types.Mixed, default: [] },
  userAnswers:   { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:     { type: Date, default: Date.now },
});

const User        = mongoose.model('User', userSchema);
const QuizSession = mongoose.model('QuizSession', quizSessionSchema);

// ── DB Service ──────────────────────────────────────────────
class DbService {
  constructor() {
    this.connected  = false;
    this.connecting = false;
  }

  assignDailyQuests(user) {
    const today = new Date().toISOString().split('T')[0];
    if (user.dailyQuests && user.dailyQuests.length > 0 && user.dailyQuests[0].dateAssigned === today) {
      return false; // Already assigned today
    }
    user.dailyQuests = [
      { id: 'play_1', title: 'Play a Quiz today', target: 1, progress: 0, xpReward: 50, completed: false, dateAssigned: today },
      { id: 'score_100', title: 'Get a Perfect Score', target: 1, progress: 0, xpReward: 100, completed: false, dateAssigned: today },
      { id: 'hard_mode', title: 'Complete a Hard Quiz', target: 1, progress: 0, xpReward: 150, completed: false, dateAssigned: today }
    ];
    return true;
  }

  async connect() {
    const uri = process.env.MONGODB_URI;
    if (!uri || uri === 'your_mongodb_connection_string_here') {
      console.warn('⚠️  MONGODB_URI not set.');
      return false;
    }
    if (this.connected) return true;

    // If a connection attempt is already in progress, wait for it to resolve
    if (this.connecting) {
      const start = Date.now();
      while (this.connecting && Date.now() - start < 12000) {
        await new Promise(r => setTimeout(r, 200));
      }
      return this.connected;
    }

    this.connecting = true;
    try {
      console.log('🔌 Connecting to MongoDB Atlas...');
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 20000, family: 4 });
      this.connected  = true;
      this.connecting = false;
      console.log('✅ MongoDB Atlas connected!');
      return true;
    } catch (err) {
      this.connected  = false;
      this.connecting = false;
      console.error('❌ MongoDB connection failed:', err.message);
      return false;
    }
  }

  // ── User CRUD ──────────────────────────────────────────────
  async createUser({ username, email, passwordHash }) {
    if (!await this.connect()) throw new Error('Database not available');
    const user = new User({ username, email, passwordHash });
    await user.save();
    return user;
  }

  async findUserByEmail(email) {
    if (!await this.connect()) return null;
    return User.findOne({ email: email.toLowerCase() });
  }

  async findUserById(id) {
    if (!await this.connect()) return null;
    return User.findById(id).select('-passwordHash');
  }

  async findUserByUsername(username) {
    if (!await this.connect()) return null;
    return User.findOne({ username: new RegExp(`^${username}$`, 'i') }).select('-passwordHash');
  }

  // ── Save quiz session + update user stats ──────────────────
  async saveQuizSession(data) {
    if (!await this.connect()) return null;

    let baseXP = calcXP(data.score, data.questionCount, data.difficulty);
    let totalXPEarned = baseXP;
    let completedQuests = [];

    const user = await User.findById(data.userId);
    if (user) {
      this.assignDailyQuests(user);
      
      for (let q of user.dailyQuests) {
        if (q.completed) continue;
        
        if (q.id === 'play_1') q.progress += 1;
        if (q.id === 'score_100' && data.percentage === 100) q.progress += 1;
        if (q.id === 'hard_mode' && data.difficulty === 'hard') q.progress += 1;

        if (q.progress >= q.target) {
          q.progress = q.target;
          q.completed = true;
          totalXPEarned += q.xpReward;
          completedQuests.push({ title: q.title, xp: q.xpReward });
        }
      }

      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      // Streak logic
      if (user.lastPlayedDate === yesterday) {
        user.streak = (user.streak || 0) + 1;
      } else if (user.lastPlayedDate !== today) {
        user.streak = 1;
      }
      if (user.streak > (user.bestStreak || 0)) user.bestStreak = user.streak;
      user.lastPlayedDate = today;

      // Accumulate stats
      user.xp            = (user.xp || 0) + totalXPEarned;
      user.totalQuizzes  = (user.totalQuizzes || 0) + 1;
      user.totalQuestions= (user.totalQuestions || 0) + (parseInt(data.questionCount) || 0);
      user.totalCorrect  = (user.totalCorrect || 0) + (parseInt(data.score) || 0);
      
      if (user.totalQuestions > 0) {
        user.avgScore = Math.round((user.totalCorrect / user.totalQuestions) * 100);
      }
      if (data.percentage > (user.bestScore || 0)) user.bestScore = data.percentage;

      // Level up
      const levelInfo  = calcLevel(user.xp);
      user.level       = levelInfo.level;
      user.levelTitle  = levelInfo.title;

      // Achievements
      const achievements = new Set(user.achievements || []);
      if (user.totalQuizzes === 1) achievements.add('first_quiz');
      if (user.totalQuizzes === 10) achievements.add('ten_quizzes');
      if (user.totalQuizzes === 50) achievements.add('fifty_quizzes');
      if (data.percentage === 100) achievements.add('perfect_score');
      if (user.streak >= 3) achievements.add('streak_3');
      if (user.streak >= 7) achievements.add('streak_7');
      if (user.bestScore >= 90) achievements.add('high_scorer');
      if (data.difficulty === 'hard' && data.percentage >= 80) achievements.add('hard_master');
      user.achievements = [...achievements];

      await user.save();
    }

    const session = new QuizSession({
      userId: data.userId, username: data.username,
      topic: data.topic, source: data.source, difficulty: data.difficulty,
      questionCount: data.questionCount, score: data.score,
      percentage: data.percentage, timeTaken: data.timeTaken,
      xpEarned: totalXPEarned, questions: data.questions, userAnswers: data.userAnswers,
    });
    await session.save();

    console.log(`💾 Session saved (${totalXPEarned} XP earned) → ${session._id}`);
    return { session, xpEarned: totalXPEarned, levelInfo: calcLevel(user?.xp || 0), completedQuests };
  }

  // ── History (per-user) ─────────────────────────────────────
  async getHistory(userId, limit = 20) {
    if (!await this.connect()) return [];
    return QuizSession.find({ userId }).sort({ createdAt: -1 }).limit(limit)
      .select('-questions -userAnswers').lean();
  }

  async getSessionById(id, userId) {
    if (!await this.connect()) return null;
    const q = { _id: id };
    if (userId) q.userId = userId;
    return QuizSession.findOne(q).lean();
  }

  async deleteSession(id, userId) {
    if (!await this.connect()) return false;
    await QuizSession.findOneAndDelete({ _id: id, userId });
    return true;
  }

  // ── Per-user stats ─────────────────────────────────────────
  async getUserStats(userId) {
    if (!await this.connect()) return null;
    const user = await User.findById(userId).select('-passwordHash');
    if (!user) return null;
    
    if (this.assignDailyQuests(user)) {
      await user.save();
    }
    
    const levelInfo = calcLevel(user.xp || 0);
    return { ...user.toObject(), ...levelInfo };
  }

  // ── Global leaderboard ─────────────────────────────────────
  async getLeaderboard(limit = 20) {
    if (!await this.connect()) return [];
    return User.find({ totalQuizzes: { $gt: 0 } })
      .sort({ xp: -1, avgScore: -1 })
      .limit(limit)
      .select('username xp level levelTitle totalQuizzes avgScore bestScore streak createdAt')
      .lean();
  }

  async getUserRank(userId) {
    if (!await this.connect()) return null;
    const user = await User.findById(userId).lean();
    if (!user) return null;
    const rank = await User.countDocuments({ xp: { $gt: user.xp || 0 } });
    const total = await User.countDocuments({ totalQuizzes: { $gt: 0 } });
    return { rank: rank + 1, total };
  }

  // ── Expose calcXP and calcLevel for routes ─────────────────
  calcXP       = calcXP;
  calcLevel    = calcLevel;
  LEVELS       = LEVELS;
}

module.exports = new DbService();
