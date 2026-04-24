const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const dbService = require('../services/dbService');

/**
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    // Check if user exists
    const existingEmail = await dbService.findUserByEmail(email);
    if (existingEmail) return res.status(400).json({ error: 'Email already in use.' });

    const existingUsername = await dbService.findUserByUsername(username);
    if (existingUsername) return res.status(400).json({ error: 'Username already taken.' });

    const passwordHash = await authService.hashPassword(password);
    const user = await dbService.createUser({ username, email, passwordHash });

    const token = authService.signToken(user._id, user.username);
    res.json({ success: true, token, user: { id: user._id, username: user.username, xp: user.xp, level: user.level, levelTitle: user.levelTitle } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await dbService.findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const isMatch = await authService.comparePassword(password, user.passwordHash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = authService.signToken(user._id, user.username);
    const levelInfo = dbService.calcLevel(user.xp);
    
    res.json({ success: true, token, user: { id: user._id, username: user.username, xp: user.xp, level: levelInfo.level, levelTitle: levelInfo.title, streak: user.streak } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

/**
 * GET /api/auth/me
 * Protected
 */
router.get('/me', authService.middleware(), async (req, res) => {
  try {
    const user = await dbService.getUserStats(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found. Session invalid.' });

    const rankInfo = await dbService.getUserRank(req.userId);
    res.json({ success: true, user: { ...user, rank: rankInfo?.rank, totalPlayers: rankInfo?.total } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

/**
 * GET /api/auth/leaderboard
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await dbService.getLeaderboard(20);
    res.json({ success: true, leaderboard });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

module.exports = router;
