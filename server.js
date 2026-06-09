require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword, verifyPassword, generateJWT, verifyJWT } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DAILY_AI_CAP = parseInt(process.env.DAILY_AI_CAP || '100', 10);

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pool) console.log('Database connected');
else console.warn('WARNING: DATABASE_URL not set');

// ----------------------------------------------------------------------
// Database setup
// ----------------------------------------------------------------------
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      detail_slider INT DEFAULT 5,
      cleanliness_slider INT DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS room_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL,
      before_photo_data TEXT,
      ai_task_list JSONB,
      after_photo_data TEXT,
      ai_verification JSONB,
      user_verified BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_completions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_session_id UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE NOT NULL,
      count INT DEFAULT 0,
      PRIMARY KEY (user_id, usage_date)
    );
  `);

  const indices = [
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_room_sessions_user_id ON room_sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_room_sessions_created ON room_sessions(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_task_completions_session ON task_completions(room_session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage(user_id, usage_date)`
  ];
  for (const idx of indices) {
    await pool.query(idx).catch(() => {});
  }

  console.log('Database tables ready');
}

initDb().catch(console.error);

// ----------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------
app.use(express.json({ limit: '20mb' }));
app.use(cors());

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = auth.slice(7);
  const decoded = verifyJWT(token, JWT_SECRET);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.userId = decoded.userId;
  next();
}

const requestCounts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  requestCounts.set(ip, entry);
  if (entry.count > 60) {
    return res.status(429).json({ error: 'Too many requests.' });
  }
  next();
}

// ----------------------------------------------------------------------
// Helper: call Claude and parse JSON response
// ----------------------------------------------------------------------
async function callClaude({ systemPrompt, photoData, userText, maxTokens }) {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: photoData.split(',')[1] || photoData
          }
        },
        { type: 'text', text: userText }
      ]
    }
  ];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 1000,
      system: systemPrompt,
      messages
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Claude error:', data);
    throw new Error('AI request failed');
  }

  const text = data.content[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

async function bumpUsage(userId) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO ai_usage (user_id, usage_date, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, usage_date) DO UPDATE SET count = ai_usage.count + 1`,
    [userId, today]
  );
}

// ----------------------------------------------------------------------
// Auth endpoints
// ----------------------------------------------------------------------
app.post('/api/auth/register', rateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Account already exists' });
    }
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email.toLowerCase(), passwordHash]
    );
    const userId = result.rows[0].id;
    await pool.query(
      `INSERT INTO user_preferences (user_id, detail_slider, cleanliness_slider) VALUES ($1, $2, $3)`,
      [userId, 5, 5]
    );
    const token = generateJWT(userId, JWT_SECRET);
    console.log(`SIGNUP | User: ${email} | ${new Date().toISOString()}`);
    res.json({ ok: true, token, userId });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', rateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  try {
    const result = await pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = generateJWT(user.id, JWT_SECRET);
    console.log(`LOGIN | User: ${email} | ${new Date().toISOString()}`);
    res.json({ ok: true, token, userId: user.id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Preferences endpoints
// ----------------------------------------------------------------------
app.get('/api/user/preferences', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query(
      'SELECT detail_slider, cleanliness_slider FROM user_preferences WHERE user_id = $1',
      [req.userId]
    );
    if (!result.rows.length) {
      return res.json({ detail_slider: 5, cleanliness_slider: 5 });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/user/preferences', authRequired, async (req, res) => {
  const { detail_slider, cleanliness_slider } = req.body;
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    await pool.query(
      `INSERT INTO user_preferences (user_id, detail_slider, cleanliness_slider, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET detail_slider = $2, cleanliness_slider = $3, updated_at = NOW()`,
      [req.userId, detail_slider || 5, cleanliness_slider || 5]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Room session endpoints
// ----------------------------------------------------------------------
app.post('/api/room/analyze', authRequired, rateLimit, async (req, res) => {
  const { room_name, before_photo_data, detail_slider, cleanliness_slider } = req.body;
  if (!room_name || !before_photo_data) {
    return res.status(400).json({ error: 'room_name and before_photo_data required' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const usage = await pool.query(
      'SELECT count FROM ai_usage WHERE user_id = $1 AND usage_date = $2',
      [req.userId, today]
    );
    const used = usage.rows[0]?.count || 0;
    if (used >= DAILY_AI_CAP) {
      return res.status(429).json({ error: 'daily_limit_reached' });
    }

    const sessionResult = await pool.query(
      `INSERT INTO room_sessions (user_id, room_name, before_photo_data) VALUES ($1, $2, $3) RETURNING id`,
      [req.userId, room_name, before_photo_data]
    );
    const sessionId = sessionResult.rows[0].id;

    const systemPrompt = `You are a helpful AI assistant supporting someone with ADHD/autism managing household tasks. The user has taken a photo of their room. Generate a task list based on their preferences.

Cleanliness preference: ${cleanliness_slider || 5}/10 (1 = just functional, 10 = spotless)
Detail level: ${detail_slider || 5}/10 (1 = simple 3-4 big tasks, 10 = granular 10+ small steps)
Room: ${room_name}

Return ONLY valid JSON in this exact format, no markdown:
{ "observations": "What you see in the room", "tasks": [ { "id": "1", "task": "Wash dishes" } ] }`;

    const taskList = await callClaude({
      systemPrompt,
      photoData: before_photo_data,
      userText: 'Please analyze this room and generate a task list.',
      maxTokens: 1000
    });

    await pool.query('UPDATE room_sessions SET ai_task_list = $2 WHERE id = $1', [
      sessionId,
      JSON.stringify(taskList)
    ]);
    await bumpUsage(req.userId);

    res.json({ sessionId, taskList });
  } catch (err) {
    console.error('Room analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/room/complete', authRequired, async (req, res) => {
  const { session_id, after_photo_data, completed_tasks } = req.body;
  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  try {
    const session = await pool.query(
      'SELECT id, ai_task_list FROM room_sessions WHERE id = $1 AND user_id = $2',
      [session_id, req.userId]
    );
    if (!session.rows.length) {
      return res.status(404).json({ error: 'Session not found' });
    }

    let aiVerification = null;
    if (after_photo_data) {
      const systemPrompt = `You are a supportive AI looking at a photo of a room someone just cleaned. Be gentle and non-judgmental. If they want to call it "good enough," that's valid.

Return ONLY valid JSON in this exact format, no markdown:
{ "observations": "What you see", "suggestions": "Any gentle suggestions, or empty string if it looks good" }`;

      aiVerification = await callClaude({
        systemPrompt,
        photoData: after_photo_data,
        userText: 'Please review this cleaned room.',
        maxTokens: 500
      });
      await bumpUsage(req.userId);
    }

    await pool.query(
      `UPDATE room_sessions
       SET after_photo_data = $2, ai_verification = $3, user_verified = true, completed_at = NOW()
       WHERE id = $1`,
      [session_id, after_photo_data || null, JSON.stringify(aiVerification || {})]
    );

    if (Array.isArray(completed_tasks)) {
      for (const taskId of completed_tasks) {
        await pool.query(
          `INSERT INTO task_completions (room_session_id, task_id, task_name)
           SELECT $1, task->>'id', task->>'task'
           FROM (SELECT jsonb_array_elements(ai_task_list) AS task FROM room_sessions WHERE id = $1) sub
           WHERE task->>'id' = $2`,
          [session_id, taskId]
        );
      }
    }

    res.json({ ok: true, aiVerification });
  } catch (err) {
    console.error('Room complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// History endpoint
// ----------------------------------------------------------------------
app.get('/api/user/history', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query(
      `SELECT id, room_name, completed_at, jsonb_array_length(ai_task_list) AS task_count
       FROM room_sessions
       WHERE user_id = $1 AND completed_at IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Serve the app
// ----------------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Household Accountability App running on port ${PORT}`));
