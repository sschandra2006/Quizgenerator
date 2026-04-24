/* ============================================================
   AI Service v11 — Groq (primary, free+fast) + Gemini (fallback)
   Forces IPv4 to avoid IPv6 connection hangs on Windows
   ============================================================ */

const https = require('https');
const dns   = require('dns');

class AIService {
  constructor() {
    this.groqKey   = process.env.GROQ_API_KEY;
    this.geminiKey = process.env.GEMINI_API_KEY;
    this.timeout   = 30000; // 30s

    // Groq models in priority order (all free tier)
    this.groqModels = [
      'llama-3.3-70b-versatile',
      'llama3-70b-8192',
      'mixtral-8x7b-32768',
      'llama3-8b-8192',
    ];

    // Gemini models in priority order
    this.geminiModels = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-flash-preview-04-17',
      'gemini-1.5-flash-latest',
    ];

    // IPv4 cache — pre-resolve at startup to avoid IPv6 hangs
    this.groqIp   = null;
    this.geminiIp = null;
    this._resolveIPs();
  }

  _resolveIPs() {
    dns.resolve4('api.groq.com', (err, addrs) => {
      if (!err && addrs.length) { this.groqIp = addrs[0]; console.log(`📡 Groq IPv4: ${this.groqIp}`); }
      else console.warn('⚠️  Could not resolve Groq IPv4:', err?.message);
    });
    dns.resolve4('generativelanguage.googleapis.com', (err, addrs) => {
      if (!err && addrs.length) { this.geminiIp = addrs[0]; console.log(`📡 Gemini IPv4: ${this.geminiIp}`); }
      else console.warn('⚠️  Could not resolve Gemini IPv4:', err?.message);
    });
  }

  async generateQuiz(content, difficulty = 'medium', count = 5, instructions = '', personality = 'standard') {
    const prompt = this._buildPrompt(content, difficulty, count, instructions, personality);

    // ── 1. Try Groq (fast, free, reliable) ───────────────────
    if (this.groqKey && this.groqKey.startsWith('gsk_')) {
      for (const model of this.groqModels) {
        try {
          console.log(`⚡ Trying Groq model: ${model}`);
          const result = await this._callGroq(prompt, count, model);
          if (result.questions.length > 0) {
            console.log(`✅ Groq/${model}: ${result.questions.length} questions`);
            return result;
          }
        } catch (e) {
          console.warn(`⚠️  Groq/${model}: ${e.message}`);
        }
      }
      console.warn('⚠️  All Groq models failed — trying Gemini...');
    } else {
      console.log('ℹ️  No Groq key set — trying Gemini...');
    }

    // ── 2. Try Gemini ─────────────────────────────────────────
    if (this.geminiKey && this.geminiKey !== 'your_gemini_api_key_here') {
      for (const model of this.geminiModels) {
        try {
          console.log(`🤖 Trying Gemini model: ${model}`);
          const result = await this._callGemini(prompt, count, model);
          if (result.questions.length > 0) {
            console.log(`✅ Gemini/${model}: ${result.questions.length} questions`);
            return result;
          }
        } catch (e) {
          const msg = e.message || '';
          if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
            console.warn(`⚠️  Gemini/${model}: quota exceeded, trying next...`);
          } else if (msg.includes('404') || msg.includes('not found')) {
            console.warn(`⚠️  Gemini/${model}: not available, trying next...`);
          } else {
            console.warn(`⚠️  Gemini/${model}: ${msg}`);
          }
        }
      }
    }

    // ── 3. Last resort: generate simple fallback questions ────
    console.warn('❌ All AI providers failed — returning error');
    throw new Error(
      'All AI providers are currently unavailable. ' +
      'Please add a free Groq API key (GROQ_API_KEY) to your .env file. ' +
      'Get one free at https://console.groq.com'
    );
  }

  // ── Groq API Call ────────────────────────────────────────
  async _callGroq(prompt, count, model) {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a quiz generation expert. You ONLY output valid JSON arrays. Never include markdown, code fences, or explanatory text — ONLY the raw JSON array.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    });

    // Use IPv4 directly if resolved, otherwise fallback to hostname
    const host = this.groqIp || 'api.groq.com';
    const useIp = !!this.groqIp;
    return new Promise((resolve, reject) => {
      const req = https.request({
        host,
        port: 443,
        path: '/openai/v1/chat/completions',
        method: 'POST',
        ...(useIp ? { servername: 'api.groq.com' } : { family: 4 }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqKey}`,
          'Host': 'api.groq.com',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            if (res.statusCode === 429) throw new Error('429 Groq rate limit');
            if (res.statusCode === 401) throw new Error('401 Invalid Groq API key');
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
            const resp = JSON.parse(data);
            const text = resp?.choices?.[0]?.message?.content;
            if (!text) throw new Error('No content in Groq response');
            console.log(`📥 Groq preview: ${text.substring(0, 100)}`);
            const parsed = this._parse(text);
            if (parsed.questions.length === 0) throw new Error('Parsed 0 questions from Groq response');
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error(`Groq timeout after ${this.timeout / 1000}s`)); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Gemini API Call ──────────────────────────────────────
  async _callGemini(prompt, count, model) {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const gHost = this.geminiIp || 'generativelanguage.googleapis.com';
    const gUseIp = !!this.geminiIp;
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: gHost,
        port: 443,
        path: `/v1beta/models/${model}:generateContent?key=${this.geminiKey}`,
        method: 'POST',
        ...(gUseIp ? { servername: 'generativelanguage.googleapis.com' } : { family: 4 }),
        headers: {
          'Content-Type': 'application/json',
          'Host': 'generativelanguage.googleapis.com',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            if (res.statusCode === 429) throw new Error(`429 quota exceeded for ${model}`);
            if (res.statusCode === 404) throw new Error(`404 model not found: ${model}`);
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
            const resp = JSON.parse(data);
            const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('No text in Gemini response');
            console.log(`📥 Gemini preview: ${text.substring(0, 100)}`);
            const parsed = this._parse(text);
            if (parsed.questions.length === 0) throw new Error('Parsed 0 questions from Gemini');
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error(`Gemini timeout after ${this.timeout / 1000}s`)); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Prompt Builder ───────────────────────────────────────
  _buildPrompt(content, difficulty, count, instructions, personality = 'standard') {
    const levels = {
      easy:   'EASY — focus on recall of key facts and basic definitions.',
      medium: 'MEDIUM — require applying knowledge and analyzing concepts.',
      hard:   'HARD — require critical evaluation and multi-step reasoning.',
    };

    const personalities = {
      standard:    'Professional and educational.',
      snarky:      'A bit sarcastic, witty, and slightly mocking the player. Use humor.',
      genz:        'Use heavy Gen-Z slang (no cap, fr fr, glow up, bussin, lowkey, etc.). Be very informal and hype.',
      pirate:      'Talk like a pirate. Ahoy, matey! Shiver me timbers! Use pirate vocabulary throughout.',
      academic:    'Highly formal, sophisticated, and slightly pretentious. Use complex vocabulary.',
      shakespeare: 'Write in Early Modern English like Shakespeare. Use thee, thou, dost, forsooth, hath, verily, prithee, etc.',
      coach:       'Be an intensely enthusiastic motivational coach. Every question is a chance to CRUSH IT! Use energy and exclamation points!',
      conspiracy:  'Everything is connected. Drop subtle hints that the answers are part of a larger cover-up. Be dramatically suspicious.',
      ramsay:      'Channel Gordon Ramsay. Be brutally critical, passionate, use cooking metaphors, and dramatically express disbelief at wrong answers.',
      zen:         'Speak with calm, measured wisdom. Use peaceful metaphors, brief meditative observations, and gentle philosophical insight.',
      drill:       'You are a military drill sergeant. Be intense, demanding, use military jargon, and treat every question like a mission-critical test.',
    };

    const pTone = personalities[personality] || personalities.standard;

    return `Generate EXACTLY ${count} multiple-choice quiz questions about the SUBJECT MATTER AND CONTENT of the following text.

⚠️ CRITICAL: You are generating questions about the CONTENT/TOPIC discussed in the text. DO NOT ask questions about:
- Document format or file properties
- Page numbers, metadata, or document structure
- Author information or publication details
- Any properties of HOW the content is presented

Focus ONLY on the actual concepts, facts, ideas, and information discussed in the content.

CONTENT:
"""
${content.substring(0, 8000)}
"""

DIFFICULTY: ${levels[difficulty?.toLowerCase()] || levels.medium}
PERSONALITY TONE: ${pTone}
${instructions ? `SPECIAL INSTRUCTIONS: ${instructions}` : ''}

STRICT RULES:
- Output EXACTLY ${count} questions
- Each question has exactly 4 options: A, B, C, D
- Exactly ONE correct answer per question
- Include a clear brief explanation and a subtle hint for the player
- ADDITIONALLY: You MUST add a "roast" object at the very end of the JSON.
- The "roast" should be a hilarious, personality-consistent comment about someone who scores poorly versus someone who scores perfectly.
- Output ONLY a valid JSON object.

Format (return ONLY this, no extra text):
{
  "questions": [{"id":1,"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correctAnswer":"B","explanation":"...","hint":"..."}],
  "roast": {
    "low": "Brief hilarious roast for 0-40% score in ${personality} tone.",
    "high": "Brief epic praise for 80-100% score in ${personality} tone."
  }
}`;
  }

  // ── JSON Parsers ─────────────────────────────────────────
  _parse(raw) {
    let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // Helper to ensure roast metadata exists
    const ensureRoast = (obj, personality = 'standard') => {
      const defaults = {
        standard:    { low: "You have room to grow. Keep practicing!",                                       high: "Excellent work! You've mastered this topic." },
        snarky:      { low: "Is your brain on airplane mode? Try again.",                                   high: "Wow, you actually know things. I'm impressed." },
        genz:        { low: "L choice, fr fr. You need to lock in.",                                        high: "Major W. You're literally the main character." },
        pirate:      { low: "Ye be a scallywag! Walk the plank and study more!",                           high: "Ahoy! Ye be the finest captain on the seven seas!" },
        academic:    { low: "Your performance was suboptimal. Further study is required.",                  high: "Your intellectual prowess is truly remarkable." },
        shakespeare: { low: "Forsooth, thou hast stumbled most grievously. Return to thy studies!",         high: "Verily, thy brilliance doth shine like the morning star!" },
        coach:       { low: "That score is NOT acceptable! Get up and TRAIN HARDER! You got this!",         high: "INCREDIBLE! You crushed it! That's the CHAMPION mentality!" },
        conspiracy:  { low: "They don't want you to know the answers. But now you must dig deeper...",      high: "You know too much. They will be watching you now. Well done." },
        ramsay:      { low: "This score is RAW! It's bloody awful! Get back in that kitchen and study!",    high: "Finally, someone who actually knows what they're doing. STUNNING!" },
        zen:         { low: "The path to knowledge is long. Breathe, reflect, and begin again.",            high: "Still waters run deep. Your mind is a tranquil lake of wisdom." },
        drill:       { low: "PATHETIC, RECRUIT! DROP AND GIVE ME 20 STUDY SESSIONS! DISMISSED!",            high: "Outstanding performance, soldier! You are an asset to this unit!" },
      };
      const def = defaults[personality] || defaults.standard;
      return obj && obj.low && obj.high ? obj : def;
    };

    try {
      const top = JSON.parse(text);
      if (top && typeof top === 'object' && !Array.isArray(top)) {
        const questions = this._sanitizeAll(top.questions || []);
        const roast = ensureRoast(top.roast);
        return { questions, metadata: { roast } };
      }
      if (Array.isArray(top) && top.length > 0) {
        return { questions: this._sanitizeAll(top), metadata: { roast: ensureRoast(null) } };
      }
    } catch (_) {}

    // Fallback extraction: try to find an object { ... }
    const fiObj = text.indexOf('{'), liObj = text.lastIndexOf('}');
    if (fiObj !== -1 && liObj > fiObj) {
      try {
        const p = JSON.parse(text.substring(fiObj, liObj + 1));
        if (p && typeof p === 'object' && p.questions) {
          return { questions: this._sanitizeAll(p.questions), metadata: { roast: ensureRoast(p.roast) } };
        }
      } catch (_) {}
    }

    // Fallback extraction: try to find an array [ ... ]
    const fiArr = text.indexOf('['), liArr = text.lastIndexOf(']');
    if (fiArr !== -1 && liArr > fiArr) {
      try {
        const p = JSON.parse(text.substring(fiArr, liArr + 1));
        if (Array.isArray(p) && p.length > 0) {
          return { questions: this._sanitizeAll(p), metadata: { roast: ensureRoast(null) } };
        }
      } catch (_) {}
    }

    return { questions: [], metadata: { roast: ensureRoast(null) } };
  }

  _sanitize(q) {
    let opts = q.options || {};
    if (Array.isArray(opts)) {
      const keys = ['A', 'B', 'C', 'D'];
      const o = {};
      opts.forEach((v, i) => { if (i < 4) o[keys[i]] = String(v); });
      opts = o;
    }
    ['A', 'B', 'C', 'D'].forEach(k => { if (!opts[k]) opts[k] = `Option ${k}`; });
    const raw = String(q.correctAnswer || q.correct_answer || q.answer || 'A').trim().toUpperCase();
    const ca = ['A', 'B', 'C', 'D'].includes(raw) ? raw : 'A';
    return {
      id: 1,
      question: String(q.question || q.text || 'Question').trim(),
      options: opts,
      correctAnswer: ca,
      explanation: String(q.explanation || q.reason || 'No explanation provided.').trim(),
      hint: String(q.hint || 'Think carefully! Read the options again.').trim(),
    };
  }

  _sanitizeAll(arr) {
    return arr
      .filter(q => q && typeof q === 'object')
      .map((q, i) => ({ ...this._sanitize(q), id: i + 1 }));
  }
}

module.exports = new AIService();
