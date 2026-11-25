import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { makeToken, readTokenSessionId, verifyToken, WINDOW_SECONDS } from './qr.js';

const now = () => Math.floor(Date.now() / 1000);

export function createApp(db, { jwtSecret = process.env.JWT_SECRET } = {}) {
  if (!jwtSecret) throw new Error('JWT_SECRET is not set (see .env.example)');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // ---------- helpers ----------
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Login check: reads the login cookie and puts the user on req.user.
  function auth(req, res, next) {
    try {
      const { uid } = jwt.verify(req.cookies.token, jwtSecret);
      const user = db.prepare('SELECT id, role, full_name, login_id, language FROM users WHERE id = ?').get(uid);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'not_logged_in' });
    }
  }
  // Role check: only lets through the given role.
  const only = (role) => (req, res, next) =>
    req.user.role === role ? next() : res.status(403).json({ error: 'forbidden' });

  const guard = (role) => [auth, only(role)];

  // A teacher may only touch sessions of classes assigned to them.
  function ownedSession(req, res) {
    const s = db.prepare(
      `SELECT s.* FROM sessions s JOIN classes c ON c.id = s.class_id
       WHERE s.id = ? AND c.teacher_id = ?`
    ).get(Number(req.params.id), req.user.id);
    if (!s) res.status(404).json({ error: 'session_not_found' });
    return s;
  }
  const isOpen = (s) => s.status === 'open' && now() >= s.starts_at && now() <= s.ends_at;

  // ---------- login ----------
  app.post('/api/login', wrap((req, res) => {
    const { login_id, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE login_id = ?').get(String(login_id || ''));
    // Same answer whether the ID or the password is wrong, so nobody can probe which IDs exist.
    if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    const token = jwt.sign({ uid: u.id }, jwtSecret, { expiresIn: '12h' });
    res.cookie('token', token, {
      httpOnly: true, // JavaScript on the page cannot read it
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true', // set true when served over HTTPS
      maxAge: 12 * 3600 * 1000,
    });
    res.json({ role: u.role, full_name: u.full_name, language: u.language });
  }));
  app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
  app.get('/api/me', auth, (req, res) => res.json(req.user));

  // ---------- admin ----------
  const admin = guard('admin');
  const randomPassword = () => crypto.randomBytes(5).toString('hex'); // e.g. "a3f09c12bb"

  app.post('/api/admin/users', admin, wrap((req, res) => {
    const { role, full_name, login_id, password, language = 'fr' } = req.body || {};
    if (!['teacher', 'student', 'admin'].includes(role) || !full_name || !login_id) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const pw = password || randomPassword();
    try {
      const r = db.prepare(
        'INSERT INTO users (role, full_name, login_id, password_hash, language) VALUES (?,?,?,?,?)'
      ).run(role, full_name, String(login_id), bcrypt.hashSync(pw, 10), language);
      res.status(201).json({ id: Number(r.lastInsertRowid), login_id, password: pw });
    } catch {
      res.status(409).json({ error: 'login_id_taken' });
    }
  }));

  app.get('/api/admin/users', admin, (req, res) => {
    const role = req.query.role;
    const rows = role
      ? db.prepare('SELECT id, role, full_name, login_id, language FROM users WHERE role = ? ORDER BY full_name').all(role)
      : db.prepare('SELECT id, role, full_name, login_id, language FROM users ORDER BY role, full_name').all();
    res.json(rows);
  });

  app.post('/api/admin/classes', admin, wrap((req, res) => {
    const { name, teacher_id = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'missing_name' });
    if (teacher_id !== null && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'teacher'").get(Number(teacher_id) || 0)) {
      return res.status(400).json({ error: 'not_a_teacher' });
    }
    const r = db.prepare('INSERT INTO classes (name, teacher_id) VALUES (?, ?)').run(name, teacher_id);
    res.status(201).json({ id: Number(r.lastInsertRowid), name, teacher_id });
  }));

  app.get('/api/admin/classes', admin, (req, res) => {
    res.json(db.prepare(
      `SELECT c.id, c.name, c.teacher_id, t.full_name AS teacher_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
       FROM classes c LEFT JOIN users t ON t.id = c.teacher_id ORDER BY c.name`
    ).all());
  });

  app.put('/api/admin/classes/:id/teacher', admin, wrap((req, res) => {
    const t = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'teacher'").get(Number(req.body?.teacher_id) || 0);
    if (!t) return res.status(400).json({ error: 'not_a_teacher' });
    const r = db.prepare('UPDATE classes SET teacher_id = ? WHERE id = ?').run(t.id, Number(req.params.id));
    r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'class_not_found' });
  }));

  // Paste a class list: [{ login_id, full_name }]. Unknown students get an account with a
  // random password (returned once, so the admin can hand it out). Known ones are just enrolled.
  app.post('/api/admin/classes/:id/students', admin, wrap((req, res) => {
    const classId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM classes WHERE id = ?').get(classId)) {
      return res.status(404).json({ error: 'class_not_found' });
    }
    const list = Array.isArray(req.body?.students) ? req.body.students : [];
    const created = [];
    const enrolled = [];
    db.exec('BEGIN');
    try {
      for (const s of list) {
        const login_id = String(s.login_id || '').trim();
        if (!login_id) continue;
        let u = db.prepare("SELECT id FROM users WHERE login_id = ? AND role = 'student'").get(login_id);
        if (!u) {
          if (!s.full_name) throw new Error(`full_name needed for new student ${login_id}`);
          const pw = randomPassword();
          const r = db.prepare(
            "INSERT INTO users (role, full_name, login_id, password_hash) VALUES ('student', ?, ?, ?)"
          ).run(s.full_name, login_id, bcrypt.hashSync(pw, 10));
          u = { id: Number(r.lastInsertRowid) };
          created.push({ login_id, full_name: s.full_name, password: pw });
        }
        db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)').run(classId, u.id);
        enrolled.push(login_id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: 'bad_list', detail: e.message });
    }
    res.status(201).json({ enrolled: enrolled.length, created });
  }));

  app.get('/api/admin/classes/:id/students', admin, (req, res) => {
    res.json(db.prepare(
      `SELECT u.id, u.full_name, u.login_id FROM enrollments e JOIN users u ON u.id = e.student_id
       WHERE e.class_id = ? ORDER BY u.full_name`
    ).all(Number(req.params.id)));
  });

  // ---------- teacher ----------
  const teacher = guard('teacher');

  app.get('/api/teacher/classes', teacher, (req, res) => {
    res.json(db.prepare(
      `SELECT c.id, c.name, (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
       FROM classes c WHERE c.teacher_id = ? ORDER BY c.name`
    ).all(req.user.id));
  });

  app.post('/api/teacher/sessions', teacher, wrap((req, res) => {
    const classId = Number(req.body?.class_id);
    const minutes = Math.min(Math.max(Number(req.body?.duration_minutes) || 15, 1), 240);
    const c = db.prepare('SELECT id FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
    if (!c) return res.status(404).json({ error: 'class_not_found' });
    const t = now();
    const r = db.prepare(
      'INSERT INTO sessions (class_id, created_by, starts_at, ends_at, secret) VALUES (?,?,?,?,?)'
    ).run(classId, req.user.id, t, t + minutes * 60, crypto.randomBytes(32).toString('hex'));
    res.status(201).json({ id: Number(r.lastInsertRowid), starts_at: t, ends_at: t + minutes * 60 });
  }));

  // The page calls this every few seconds; the token inside it changes every WINDOW seconds.
  app.get('/api/teacher/sessions/:id/qr', teacher, (req, res) => {
    const s = ownedSession(req, res); if (!s) return;
    if (!isOpen(s)) return res.status(409).json({ error: 'session_closed' });
    res.json({ token: makeToken(s), refresh_in: WINDOW_SECONDS - (now() % WINDOW_SECONDS), ends_at: s.ends_at });
  });

  app.get('/api/teacher/sessions/:id/attendance', teacher, (req, res) => {
    const s = ownedSession(req, res); if (!s) return;
    const rows = db.prepare(
      `SELECT u.id AS student_id, u.full_name, u.login_id, a.scanned_at, a.method
       FROM enrollments e JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a ON a.student_id = u.id AND a.session_id = ?
       WHERE e.class_id = ? ORDER BY u.full_name`
    ).all(s.id, s.class_id);
    res.json({
      open: isOpen(s),
      present: rows.filter((r) => r.scanned_at).length,
      total: rows.length,
      students: rows.map((r) => ({ ...r, present: !!r.scanned_at })),
    });
  });

  // Manual override for students whose phone is dead.
  app.post('/api/teacher/sessions/:id/manual', teacher, wrap((req, res) => {
    const s = ownedSession(req, res); if (!s) return;
    const sid = Number(req.body?.student_id) || 0;
    if (!db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(s.class_id, sid)) {
      return res.status(400).json({ error: 'not_enrolled' });
    }
    db.prepare("INSERT OR IGNORE INTO attendance (session_id, student_id, scanned_at, method) VALUES (?,?,?,'manual')")
      .run(s.id, sid, now());
    res.json({ ok: true });
  }));

  app.post('/api/teacher/sessions/:id/close', teacher, (req, res) => {
    const s = ownedSession(req, res); if (!s) return;
    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(s.id);
    res.json({ ok: true });
  });

  // CSV opens in Excel. One row per student, one column per session.
  app.get('/api/teacher/classes/:id/export.csv', teacher, (req, res) => {
    const classId = Number(req.params.id);
    const c = db.prepare('SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
    if (!c) return res.status(404).json({ error: 'class_not_found' });
    const sessions = db.prepare('SELECT id, starts_at FROM sessions WHERE class_id = ? ORDER BY starts_at').all(classId);
    const students = db.prepare(
      `SELECT u.id, u.full_name, u.login_id FROM enrollments e JOIN users u ON u.id = e.student_id
       WHERE e.class_id = ? ORDER BY u.full_name`
    ).all(classId);
    const att = new Set(
      db.prepare(
        `SELECT a.session_id || '-' || a.student_id AS k FROM attendance a JOIN sessions s ON s.id = a.session_id
         WHERE s.class_id = ?`
      ).all(classId).map((r) => r.k)
    );
    // Cells starting with = + - @ can run as formulas in Excel; a leading quote makes them plain text.
    const cell = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const header = ['Matricule', 'Nom', ...sessions.map((s) => new Date(s.starts_at * 1000).toISOString().slice(0, 16).replace('T', ' ')), 'Total'];
    const lines = [header.map(cell).join(',')];
    for (const st of students) {
      const marks = sessions.map((s) => (att.has(`${s.id}-${st.id}`) ? 'P' : 'A'));
      lines.push([st.login_id, st.full_name, ...marks, marks.filter((m) => m === 'P').length].map(cell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-class-${classId}.csv"`);
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel shows Arabic and accents correctly
  });

  // ---------- student ----------
  const student = guard('student');

  // The scan check, in order. Each failed step answers with its own code.
  app.post('/api/student/scan', student, wrap((req, res) => {
    const token = req.body?.token;
    const sid = readTokenSessionId(token);
    const s = sid && db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!s) return res.status(400).json({ error: 'invalid_token' });
    if (!isOpen(s)) return res.status(409).json({ error: 'session_closed' });
    if (!verifyToken(token, s)) return res.status(400).json({ error: 'invalid_or_expired_token' });
    if (!db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(s.class_id, req.user.id)) {
      return res.status(403).json({ error: 'not_enrolled' });
    }
    const r = db.prepare("INSERT OR IGNORE INTO attendance (session_id, student_id, scanned_at, method) VALUES (?,?,?,'qr')")
      .run(s.id, req.user.id, now());
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(s.class_id);
    // Scanning twice is not an error for the student: they are recorded either way.
    res.json({ status: r.changes ? 'recorded' : 'already_recorded', class_name: cls.name });
  }));

  app.get('/api/student/history', student, (req, res) => {
    res.json(db.prepare(
      `SELECT s.id AS session_id, c.name AS class_name, s.starts_at,
              a.scanned_at IS NOT NULL AS present, a.method
       FROM sessions s JOIN classes c ON c.id = s.class_id
       JOIN enrollments e ON e.class_id = c.id AND e.student_id = ?
       LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = e.student_id
       ORDER BY s.starts_at DESC`
    ).all(req.user.id).map((r) => ({ ...r, present: !!r.present })));
  });

  // ---------- errors ----------
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
