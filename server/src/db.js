// Database setup. SQLite is a database that lives in ONE file (data/presence.db),
// so there is no separate database program to install or run.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file = process.env.DB_FILE || 'data/presence.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      role          TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
      full_name     TEXT NOT NULL,
      login_id      TEXT NOT NULL UNIQUE,   -- student matricule, teacher username, admin username
      password_hash TEXT NOT NULL,
      language      TEXT NOT NULL DEFAULT 'fr' CHECK (language IN ('ar','fr','en'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      teacher_id INTEGER REFERENCES users(id)
    );

    -- Who belongs to which class. A student cannot be added twice to the same class.
    CREATE TABLE IF NOT EXISTS enrollments (
      class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
      PRIMARY KEY (class_id, student_id)
    );

    -- One attendance session = one class meeting. "secret" signs that session's QR tokens.
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id   INTEGER NOT NULL REFERENCES classes(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      starts_at  INTEGER NOT NULL,          -- unix seconds
      ends_at    INTEGER NOT NULL,          -- unix seconds
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      secret     TEXT NOT NULL
    );

    -- UNIQUE (session_id, student_id) is what makes double attendance impossible.
    CREATE TABLE IF NOT EXISTS attendance (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id),
      scanned_at INTEGER NOT NULL,
      method     TEXT NOT NULL CHECK (method IN ('qr','manual')),
      UNIQUE (session_id, student_id)
    );
  `);
  return db;
}
