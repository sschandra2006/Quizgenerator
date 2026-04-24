/* ============================================================
   Auth Service — JWT + bcrypt
   ============================================================ */

const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const SECRET  = process.env.JWT_SECRET || 'quizai_fallback_secret';
const EXPIRES = '7d';

class AuthService {
  // ── Password ───────────────────────────────────────────────
  async hashPassword(plain) {
    return bcrypt.hash(plain, 12);
  }

  async comparePassword(plain, hash) {
    return bcrypt.compare(plain, hash);
  }

  // ── JWT ────────────────────────────────────────────────────
  signToken(userId, username) {
    return jwt.sign({ userId, username }, SECRET, { expiresIn: EXPIRES });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, SECRET);
    } catch (e) {
      return null;
    }
  }

  // ── Express middleware: require valid JWT ──────────────────
  middleware() {
    return (req, res, next) => {
      const header = req.headers['authorization'] || '';
      const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
      const payload = this.verifyToken(token);
      if (!payload) return res.status(401).json({ error: 'Session expired. Please log in again.' });
      req.userId   = payload.userId;
      req.username = payload.username;
      next();
    };
  }

  // ── Optional auth: attach user if token present ───────────
  optionalMiddleware() {
    return (req, res, next) => {
      const header = req.headers['authorization'] || '';
      const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) {
        const payload = this.verifyToken(token);
        if (payload) { req.userId = payload.userId; req.username = payload.username; }
      }
      next();
    };
  }
}

module.exports = new AuthService();
