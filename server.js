require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { hashPassword, verifyPassword, generateJWT, verifyJWT } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (pool) console.log('Database connected');
else console.warn('WARNING: DATABASE_URL not set');

// ----------------------------------------------------------------------
// Shared-space categories. This list is the source of truth for both the
// onboarding standards-negotiation flow and the task dashboard.
// ----------------------------------------------------------------------
const CATEGORIES = [
  {
    key: 'kitchen', label: 'Kitchen',
    needsStandard: true, appliesIf: null,
    prompt: "How quickly should the kitchen get reset after it's used?",
    levels: [
      'Dishes get washed and put away right after eating.',
      'Dishes get rinsed and sit in the sink until the end of the day.',
      'Dishes pile up for a day or two before someone catches up.',
      'Countertop clutter is normal until a weekend reset.',
      'A deep clean happens about once a week — mess in between is fine.'
    ],
    starterTasks: [
      { title: 'Wash and put away dishes', frequency: 'Daily' },
      { title: 'Wipe down counters and stovetop', frequency: 'Daily' },
      { title: 'Take out kitchen trash', frequency: 'Weekly' },
      { title: 'Sweep or mop the floor', frequency: 'Weekly' },
      { title: 'Clean out the fridge', frequency: 'Flexible' }
    ]
  },
  {
    key: 'bathroom', label: 'Bathroom',
    needsStandard: true, appliesIf: null,
    prompt: 'How often should the bathroom get tidied?',
    levels: [
      'Wiped down after every use.',
      'Tidied once a day.',
      'Tidied every few days.',
      'Cleaned on a weekly schedule.',
      'Cleaned whenever someone notices it needs it.'
    ],
    starterTasks: [
      { title: 'Clean toilet', frequency: 'Weekly' },
      { title: 'Clean shower/tub', frequency: 'Weekly' },
      { title: 'Wipe down sink and counter', frequency: 'Weekly' },
      { title: 'Restock toilet paper and soap', frequency: 'Flexible' },
      { title: 'Take out bathroom trash', frequency: 'Weekly' }
    ]
  },
  {
    key: 'living', label: 'Common Areas',
    needsStandard: true, appliesIf: null,
    prompt: 'How tidy should shared living spaces stay day-to-day?',
    levels: [
      "Everything goes back in its place as soon as you're done with it.",
      'Tidied up each evening.',
      'Tidied every couple of days.',
      'Tidied once a week.',
      'A lived-in look is fine most of the time.'
    ],
    starterTasks: [
      { title: 'Tidy shared living space', frequency: 'Daily' },
      { title: 'Vacuum or sweep common areas', frequency: 'Weekly' },
      { title: 'Take out household trash/recycling', frequency: 'Weekly' },
      { title: 'Water the plants', frequency: 'Weekly' },
      { title: 'Dust shelves and surfaces', frequency: 'Flexible' }
    ]
  },
  {
    key: 'laundry', label: 'Laundry',
    needsStandard: true, appliesIf: null,
    prompt: 'How should laundry get handled?',
    levels: [
      'Washed and put away within a day of getting dirty.',
      'Washed every few days, folded promptly.',
      "The basket builds up for about a week before it's dealt with.",
      "The basket builds up until it's full or someone's out of something.",
      'A clean-pile/dirty-pile system works fine indefinitely.'
    ],
    starterTasks: [
      { title: 'Wash a load of laundry', frequency: 'Weekly' },
      { title: 'Fold and put away clean laundry', frequency: 'Weekly' },
      { title: 'Change and wash bed sheets', frequency: 'Flexible' },
      { title: 'Wash bath towels', frequency: 'Weekly' }
    ]
  },
  // ------------------------------------------------------------------
  // The categories below were added after incorporating ideas from a
  // household's own "Complete Homekeeping Master List" reference sheet.
  // Two kinds of categories now exist:
  //   - needsStandard: true  -> same as the four above: privately rated,
  //     locks a negotiated household standard. Used where "how tidy/how
  //     often" is genuinely a matter of taste.
  //   - needsStandard: false -> maintenance/admin categories where there's
  //     no meaningful comfort scale to negotiate (nobody has a "vibe" about
  //     smoke-detector testing) — these just carry starter tasks with
  //     realistic cadences, no rating step, no locked standard.
  // appliesIf ties a category to a household-profile flag (see the
  // households.has_yard / has_garage / has_pets columns) — null means it
  // always applies.
  // ------------------------------------------------------------------
  {
    key: 'yard', label: 'Yard & Outdoor',
    needsStandard: true, appliesIf: 'has_yard',
    prompt: 'How tidy should the yard and outdoor space stay?',
    levels: [
      'Mowed, edged, and swept up right after each session.',
      'Kept tidy on a weekly rhythm.',
      'Kept reasonably tidy every couple of weeks.',
      'A relaxed, lived-in yard is fine most of the season.',
      'Outdoor upkeep happens whenever someone gets to it.'
    ],
    starterTasks: [
      { title: 'Mow the lawn', frequency: 'Weekly' },
      { title: 'Pull weeds from garden beds', frequency: 'Weekly' },
      { title: 'Sweep walkways and patio', frequency: 'Weekly' },
      { title: 'Trim hedges and shrubs', frequency: 'Monthly' },
      { title: 'Rake leaves', frequency: 'Seasonal' },
      { title: 'Check outdoor lighting', frequency: 'Monthly' }
    ]
  },
  {
    key: 'garage', label: 'Garage & Storage',
    needsStandard: true, appliesIf: 'has_garage',
    prompt: 'How organized should the garage or storage areas stay?',
    levels: [
      'Everything has a spot and goes back immediately.',
      'Tidied up weekly.',
      'Tidied up monthly.',
      'A working mess is fine most of the time.',
      'Organized only during occasional big cleanouts.'
    ],
    starterTasks: [
      { title: 'Sweep garage floor', frequency: 'Monthly' },
      { title: 'Put away tools and equipment', frequency: 'Weekly' },
      { title: 'Sort items to donate or discard', frequency: 'Quarterly' },
      { title: 'Test garage door safety features', frequency: 'Quarterly' }
    ]
  },
  {
    key: 'pets', label: 'Pet Care',
    needsStandard: true, appliesIf: 'has_pets',
    prompt: 'How should day-to-day pet care and pet areas get maintained?',
    levels: [
      'Pet messes and supplies get handled immediately.',
      'Pet areas get reset daily.',
      'Pet areas get reset every couple of days.',
      'Pet areas get a once-a-week reset.',
      "A relaxed approach — cleaned up when it's noticeably needed."
    ],
    starterTasks: [
      { title: 'Feed and water pets', frequency: 'Daily' },
      { title: 'Scoop litter box / clean pet area', frequency: 'Daily' },
      { title: 'Walk the dog', frequency: 'Daily' },
      { title: 'Wash pet bowls and bedding', frequency: 'Weekly' },
      { title: 'Vacuum pet hair', frequency: 'Weekly' },
      { title: 'Restock pet food and supplies', frequency: 'Flexible' }
    ]
  },
  {
    key: 'home_safety', label: 'Home Safety & Systems',
    needsStandard: false, appliesIf: null,
    starterTasks: [
      { title: 'Test smoke and CO detectors', frequency: 'Monthly', ownerScope: 'both' },
      { title: 'Check for leaks under sinks and appliances', frequency: 'Monthly', ownerScope: 'both' },
      { title: 'Check fire extinguisher(s)', frequency: 'Quarterly', ownerScope: 'both' },
      { title: 'Replace HVAC air filter', frequency: 'Quarterly', ownerScope: 'both' },
      { title: 'Review emergency kit and supplies', frequency: 'Semiannual', ownerScope: 'both' },
      { title: 'Flush the water heater', frequency: 'Annual', ownerScope: 'owner' },
      { title: 'Clean gutters and downspouts', frequency: 'Seasonal', ownerScope: 'owner' }
    ]
  },
  {
    key: 'home_admin', label: 'Home Administration',
    needsStandard: false, appliesIf: null,
    starterTasks: [
      { title: 'Sort and file mail', frequency: 'Weekly' },
      { title: 'Pay bills and review accounts', frequency: 'Monthly' },
      { title: 'Review household budget', frequency: 'Monthly' },
      { title: 'Take inventory of cleaning and paper supplies', frequency: 'Monthly' },
      { title: 'Schedule a donation drop-off', frequency: 'Quarterly' },
      { title: 'Back up important documents', frequency: 'Annual' }
    ]
  }
];
const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const STANDARD_CATEGORY_KEYS = CATEGORIES.filter(c => c.needsStandard).map(c => c.key);

// ----------------------------------------------------------------------
// Live-update version. Bump this any time public/index.html changes in a
// way that matters (same mechanism as Brick Bank's OTA updates): the
// native app shell ships with a copy of this HTML frozen at build time
// with a BUNDLED_VERSION baked in; on launch it checks this endpoint, and
// if the numbers don't match, prompts the user to load the current copy
// straight from Railway instead of waiting on an App Store review cycle.
// Only native-shell changes (permissions, new Capacitor plugins, etc.)
// still require a real rebuild and resubmission.
// ----------------------------------------------------------------------
const CONTENT_VERSION = '2026.08.09.3';

// ----------------------------------------------------------------------
// Database setup — household/multi-person model.
// ----------------------------------------------------------------------
// One-time cleanup: this database previously held an earlier, unrelated
// prototype (solo photo-verification accountability app) with its own
// `users` table shaped differently from the household model below. Since
// that prototype was never in real use, drop its tables so the new schema
// can create `users` etc. fresh instead of silently no-op'ing against the
// old shape. Safe to run every boot — everything here is IF EXISTS.
async function dropLegacySoloSchema() {
  const hasOldUsersShape = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'household_id'
  `);
  if (hasOldUsersShape.rows.length) return; // already on the new schema
  await pool.query(`
    DROP TABLE IF EXISTS ai_usage CASCADE;
    DROP TABLE IF EXISTS task_completions CASCADE;
    DROP TABLE IF EXISTS room_sessions CASCADE;
    DROP TABLE IF EXISTS user_preferences CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
  console.log('Dropped legacy solo-prototype schema');
}

async function initDb() {
  if (!pool) return;
  await dropLegacySoloSchema();
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS households (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#3f5a6b',
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Each person's private rating for a category, collected during onboarding
    -- or a later renegotiation round. Kept even after a standard is locked so
    -- the "you leaned X, they leaned Y" framing can be shown again later.
    CREATE TABLE IF NOT EXISTS standard_ratings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_key TEXT NOT NULL,
      level INT NOT NULL CHECK (level BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (household_id, user_id, category_key)
    );

    -- The locked, agreed-on standard per category. Owned by the household,
    -- not by either person.
    CREATE TABLE IF NOT EXISTS standards (
      household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      category_key TEXT NOT NULL,
      level INT NOT NULL CHECK (level BETWEEN 1 AND 5),
      locked_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (household_id, category_key)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      category_key TEXT NOT NULL,
      title TEXT NOT NULL,
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      frequency TEXT NOT NULL DEFAULT 'Flexible',
      done BOOLEAN NOT NULL DEFAULT FALSE,
      done_at TIMESTAMPTZ,
      done_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Weekly satisfaction check-in: how a standard is actually feeling for
    -- each person, one row per person/category/week. A low rating from
    -- either person is what reopens a category for renegotiation.
    CREATE TABLE IF NOT EXISTS checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_key TEXT NOT NULL,
      satisfaction INT NOT NULL CHECK (satisfaction BETWEEN 1 AND 5),
      week_start DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (household_id, user_id, category_key, week_start)
    );
  `);

  const indices = [
    `CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ratings_household ON standard_ratings(household_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_household ON tasks(household_id)`,
    `CREATE INDEX IF NOT EXISTS idx_checkins_household_week ON checkins(household_id, week_start)`
  ];
  for (const idx of indices) {
    await pool.query(idx).catch(() => {});
  }

  // households already existed in production before the home-profile
  // questions were added, so CREATE TABLE IF NOT EXISTS above won't add
  // these columns to that existing table — migrate them in explicitly.
  // profile_set distinguishes "not asked yet" from "asked, all answered no".
  const householdProfileColumns = [
    `ALTER TABLE households ADD COLUMN IF NOT EXISTS has_yard BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE households ADD COLUMN IF NOT EXISTS has_garage BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE households ADD COLUMN IF NOT EXISTS has_pets BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE households ADD COLUMN IF NOT EXISTS is_renter BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE households ADD COLUMN IF NOT EXISTS profile_set BOOLEAN NOT NULL DEFAULT false`
  ];
  for (const stmt of householdProfileColumns) {
    await pool.query(stmt);
  }

  console.log('Database tables ready');
}

initDb().catch(console.error);

// ----------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------
app.use(express.json({ limit: '5mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

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

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  next();
}

function makeInviteCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A1B2C3"
}

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

const HOUSEHOLD_COLUMNS = 'id, name, invite_code, created_at, has_yard, has_garage, has_pets, is_renter, profile_set';

async function loadHouseholdPayload(householdId) {
  const household = (await pool.query(`SELECT ${HOUSEHOLD_COLUMNS} FROM households WHERE id = $1`, [householdId])).rows[0];
  const members = (await pool.query('SELECT id, name, color, email FROM users WHERE household_id = $1 ORDER BY created_at ASC', [householdId])).rows;
  return { household, members };
}

// ----------------------------------------------------------------------
// Household + auth endpoints
// ----------------------------------------------------------------------

// Create a new household and its first member in one step.
app.post('/api/households', rateLimit, requireDb, async (req, res) => {
  const { householdName, name, email, password, color } = req.body;
  if (!householdName || !name || !email || !password) {
    return res.status(400).json({ error: 'householdName, name, email, and password are required' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    let inviteCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      inviteCode = makeInviteCode();
      const clash = await pool.query('SELECT id FROM households WHERE invite_code = $1', [inviteCode]);
      if (!clash.rows.length) break;
    }

    const household = (await pool.query(
      `INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING ${HOUSEHOLD_COLUMNS}`,
      [householdName, inviteCode]
    )).rows[0];

    const passwordHash = hashPassword(password);
    const user = (await pool.query(
      `INSERT INTO users (household_id, name, color, email, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, color, email`,
      [household.id, name, color || '#3f5a6b', email.toLowerCase(), passwordHash]
    )).rows[0];

    const token = generateJWT(user.id, JWT_SECRET);
    res.json({ ok: true, token, user, household });
  } catch (err) {
    console.error('Create household error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Join an existing household via its invite code.
app.post('/api/households/join', rateLimit, requireDb, async (req, res) => {
  const { inviteCode, name, email, password, color } = req.body;
  if (!inviteCode || !name || !email || !password) {
    return res.status(400).json({ error: 'inviteCode, name, email, and password are required' });
  }
  try {
    const household = (await pool.query(
      `SELECT ${HOUSEHOLD_COLUMNS} FROM households WHERE invite_code = $1`,
      [inviteCode.toUpperCase()]
    )).rows[0];
    if (!household) return res.status(404).json({ error: 'No household found for that invite code' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = hashPassword(password);
    const user = (await pool.query(
      `INSERT INTO users (household_id, name, color, email, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, color, email`,
      [household.id, name, color || '#c9a15c', email.toLowerCase(), passwordHash]
    )).rows[0];

    const token = generateJWT(user.id, JWT_SECRET);
    res.json({ ok: true, token, user, household });
  } catch (err) {
    console.error('Join household error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', rateLimit, requireDb, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const result = await pool.query(
      'SELECT id, household_id, name, color, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = generateJWT(user.id, JWT_SECRET);
    res.json({
      ok: true, token,
      user: { id: user.id, name: user.name, color: user.color },
      householdId: user.household_id
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT id, household_id, name, color, email FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const { household, members } = await loadHouseholdPayload(me.household_id);
    res.json({ ok: true, user: me, household, members });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: err.message });
  }
});

// A handful of yes/no questions about the home itself (yard? garage? pets?
// rent or own?), asked once per household during onboarding, right after
// the invite step. Determines which of the optional categories
// (yard/garage/pets) show up at all, and trims landlord-responsibility
// tasks out of Home Safety & Systems for renters. Whoever gets to this
// screen first (creator or a joining member) sets it for the household.
app.post('/api/households/profile', authRequired, requireDb, async (req, res) => {
  const { hasYard, hasGarage, hasPets, isRenter } = req.body;
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const household = (await pool.query(
      `UPDATE households SET has_yard = $1, has_garage = $2, has_pets = $3, is_renter = $4, profile_set = true
       WHERE id = $5 RETURNING ${HOUSEHOLD_COLUMNS}`,
      [!!hasYard, !!hasGarage, !!hasPets, !!isRenter, me.household_id]
    )).rows[0];
    res.json({ ok: true, household });
  } catch (err) {
    console.error('Household profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Standards (onboarding negotiation + ongoing reference)
// ----------------------------------------------------------------------
app.get('/api/categories', (req, res) => {
  res.json({ ok: true, categories: CATEGORIES });
});

// Submit one person's ratings for one or more categories. Once every
// current household member has rated every category, the standard for
// each fully-rated category is (re)computed automatically.
app.post('/api/standards/ratings', authRequired, requireDb, async (req, res) => {
  const { ratings } = req.body; // { kitchen: 3, bathroom: 2, ... }
  if (!ratings || typeof ratings !== 'object') {
    return res.status(400).json({ error: 'ratings object is required' });
  }
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const householdId = me.household_id;

    for (const [categoryKey, level] of Object.entries(ratings)) {
      if (!STANDARD_CATEGORY_KEYS.includes(categoryKey)) continue;
      const lvl = parseInt(level, 10);
      if (!(lvl >= 1 && lvl <= 5)) continue;
      await pool.query(
        `INSERT INTO standard_ratings (household_id, user_id, category_key, level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (household_id, user_id, category_key)
         DO UPDATE SET level = EXCLUDED.level, created_at = NOW()`,
        [householdId, req.userId, categoryKey, lvl]
      );
    }

    const memberCount = (await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE household_id = $1', [householdId])).rows[0].n;

    const locked = [];
    for (const categoryKey of STANDARD_CATEGORY_KEYS) {
      const rows = (await pool.query(
        'SELECT level FROM standard_ratings WHERE household_id = $1 AND category_key = $2',
        [householdId, categoryKey]
      )).rows;
      if (rows.length < memberCount) continue; // not everyone has rated this one yet
      const avg = Math.round(rows.reduce((sum, r) => sum + r.level, 0) / rows.length);
      await pool.query(
        `INSERT INTO standards (household_id, category_key, level)
         VALUES ($1, $2, $3)
         ON CONFLICT (household_id, category_key)
         DO UPDATE SET level = EXCLUDED.level, updated_at = NOW()`,
        [householdId, categoryKey, avg]
      );
      locked.push(categoryKey);
    }

    res.json({ ok: true, locked });
  } catch (err) {
    console.error('Ratings error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/standards', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const householdId = me.household_id;

    const standards = (await pool.query(
      'SELECT category_key, level, locked_at, updated_at FROM standards WHERE household_id = $1',
      [householdId]
    )).rows;
    const ratings = (await pool.query(
      'SELECT user_id, category_key, level FROM standard_ratings WHERE household_id = $1',
      [householdId]
    )).rows;

    res.json({ ok: true, standards, ratings });
  } catch (err) {
    console.error('Get standards error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------
app.get('/api/tasks', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const tasks = (await pool.query(
      `SELECT id, category_key, title, owner_id, frequency, done, done_at, done_by
       FROM tasks WHERE household_id = $1 ORDER BY created_at ASC`,
      [me.household_id]
    )).rows;
    res.json({ ok: true, tasks });
  } catch (err) {
    console.error('List tasks error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', authRequired, requireDb, async (req, res) => {
  const { categoryKey, title, ownerId, frequency } = req.body;
  if (!categoryKey || !title) return res.status(400).json({ error: 'categoryKey and title are required' });
  if (!CATEGORY_KEYS.includes(categoryKey)) return res.status(400).json({ error: 'Unknown category' });
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const task = (await pool.query(
      `INSERT INTO tasks (household_id, category_key, title, owner_id, frequency)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, category_key, title, owner_id, frequency, done, done_at, done_by`,
      [me.household_id, categoryKey, title, ownerId || null, frequency || 'Flexible']
    )).rows[0];
    res.json({ ok: true, task });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/toggle', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const existing = (await pool.query(
      'SELECT id, done FROM tasks WHERE id = $1 AND household_id = $2',
      [req.params.id, me.household_id]
    )).rows[0];
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const nowDone = !existing.done;
    const task = (await pool.query(
      `UPDATE tasks SET done = $1, done_at = $2, done_by = $3 WHERE id = $4
       RETURNING id, category_key, title, owner_id, frequency, done, done_at, done_by`,
      [nowDone, nowDone ? new Date() : null, nowDone ? req.userId : null, req.params.id]
    )).rows[0];
    res.json({ ok: true, task });
  } catch (err) {
    console.error('Toggle task error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    await pool.query('DELETE FROM tasks WHERE id = $1 AND household_id = $2', [req.params.id, me.household_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------
// Weekly check-in
// ----------------------------------------------------------------------
app.post('/api/checkins', authRequired, requireDb, async (req, res) => {
  const { ratings } = req.body; // { kitchen: 4, bathroom: 2, ... } (satisfaction, 1-5)
  if (!ratings || typeof ratings !== 'object') {
    return res.status(400).json({ error: 'ratings object is required' });
  }
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const weekStart = mondayOf(new Date());

    for (const [categoryKey, satisfaction] of Object.entries(ratings)) {
      if (!STANDARD_CATEGORY_KEYS.includes(categoryKey)) continue;
      const val = parseInt(satisfaction, 10);
      if (!(val >= 1 && val <= 5)) continue;
      await pool.query(
        `INSERT INTO checkins (household_id, user_id, category_key, satisfaction, week_start)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (household_id, user_id, category_key, week_start)
         DO UPDATE SET satisfaction = EXCLUDED.satisfaction, created_at = NOW()`,
        [me.household_id, req.userId, categoryKey, val, weekStart]
      );
    }
    res.json({ ok: true, weekStart });
  } catch (err) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Categories where someone rated satisfaction <= 2 this week — these are
// the ones the weekly check-in should offer to reopen for renegotiation.
app.get('/api/checkins/needs-attention', authRequired, requireDb, async (req, res) => {
  try {
    const me = (await pool.query('SELECT household_id FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!me) return res.status(404).json({ error: 'User not found' });
    const weekStart = mondayOf(new Date());
    const rows = (await pool.query(
      `SELECT category_key, MIN(satisfaction) AS lowest
       FROM checkins WHERE household_id = $1 AND week_start = $2
       GROUP BY category_key HAVING MIN(satisfaction) <= 2`,
      [me.household_id, weekStart]
    )).rows;
    res.json({ ok: true, weekStart, categories: rows.map(r => r.category_key) });
  } catch (err) {
    console.error('Needs-attention error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: CONTENT_VERSION });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Collaborative Home server listening on port ${PORT}`);
});
