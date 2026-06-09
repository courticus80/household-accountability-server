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

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
if (pool) console.log('Database connected');
else console.warn('WARNING: DATABASE_URL not set');

// ======================================================================
// DATABASE INITIALIZATION
// ======================================================================
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
  
  // Create indices
  const indices = [
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_room_sessions_user_id ON room_sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_room_sessions_created ON room_sessions(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_task_completions_session ON task_completions(room_session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage(user_id, usage_date)`,
  ];
  
  for (const idx of indices) {
    await pool.query(idx).catch(() => {});
  }
  
  console.log('Database tables ready');
}

initDb().catch(console.error);

// ======================================================================
// MIDDLEWARE
// ======================================================================
app.use(express.json({ limit: '20mb' }));
app.use(cors());

// JWT verification middleware
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

// Rate limiting
const requestCounts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60000) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  requestCounts.set(ip, entry);
  if (entry.count > 60) return res.status(429).json({ error: 'Too many requests.' });
  next();
}

// ======================================================================
// AUTH ENDPOINTS
// ======================================================================

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
    
    // Create default preferences
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

// ======================================================================
// USER PREFERENCES
// ======================================================================

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

// ======================================================================
// ROOM SESSION ENDPOINTS
// ======================================================================

app.post('/api/room/analyze', authRequired, rateLimit, async (req, res) => {
  const { room_name, before_photo_data, detail_slider, cleanliness_slider } = req.body;
  if (!room_name || !before_photo_data) {
    return res.status(400).json({ error: 'room_name and before_photo_data required' });
  }
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    // Check daily AI cap
    const today = new Date().toISOString().slice(0, 10);
    const usage = await pool.query(
      'SELECT count FROM ai_usage WHERE user_id = $1 AND usage_date = $2',
      [req.userId, today]
    );
    const used = usage.rows[0]?.count || 0;
    if (used >= DAILY_AI_CAP) {
      return res.status(429).json({ error: 'daily_limit_reached' });
    }
    
    // Create room session
    const sessionResult = await pool.query(
      `INSERT INTO room_sessions (user_id, room_name, before_photo_data)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [req.userId, room_name, before_photo_data]
    );
    const sessionId = sessionResult.rows[0].id;
    
    // Call Claude to analyze and generate task list
    const systemPrompt = `You are a helpful AI assistant supporting someone with ADHD/autism managing household tasks. 
    
The user has taken a photo of their room. Your job is to:
1. Describe what you see
2. Generate a task list based on their cleanliness preference (1-10 scale, where 1 is "just functional" and 10 is "spotless")
3. Return JSON format ONLY (no markdown, no other text)

Cleanliness preference: ${cleanliness_slider || 5}/10
Detail level preference: ${detail_slider || 5}/10 (1=simple 3-4 tasks, 10=granular 10+ tasks)

Room: ${room_name}

Return ONLY valid JSON in this exact format:
{
  "observations": "What you see in the room",
  "tasks": [
    { "id": "1", "task": "Wash dishes" },
    { "id": "2", "task": "Wipe counter" }
  ]
}`;

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: before_photo_data.split(',')[1] || before_photo_data
            }
          },
          {
            type: 'text',
            text: 'Please analyze this room and generate a task list.'
          }
        ]
      }
    ];
    
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages
      })
    });
    
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      console.error('Claude error:', claudeData);
      return res.status(500).json({ error: 'AI analysis failed' });
    }
    
    // Extract task list from Claude response
    const responseText = claudeData.content[0]?.text || '{}';
    let taskList;
    try {
      taskList = JSON.parse(responseText);
    } catch (e) {
      // Try to extract JSON if wrapped in markdown
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      taskList = jsonMatch ? JSON.parse(jsonMatch[0]) : { tasks: [] };
    }
    
    // Save task list to session
    await pool.query(
      'UPDATE room_sessions SET ai_task_list = $2 WHERE id = $1',
      [sessionId, JSON.stringify(taskList)]
    );
    
    // Increment AI usage
    await pool.query(
      `INSERT INTO ai_usage (user_id, usage_date, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, usage_date) DO UPDATE SET count = ai_usage.count + 1`,
      [req.userId, today]
    );
    
    res.json({ sessionId, taskList });
