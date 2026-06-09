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
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(emai
