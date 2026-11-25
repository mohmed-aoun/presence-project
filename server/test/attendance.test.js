import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makeToken } from '../src/qr.js';

let db, server, base;

// A tiny "browser": remembers the login cookie between calls.
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (type.includes('json')) return { status: res.status, body: await res.json() };
    const raw = Buffer.from(await res.arrayBuffer()); // raw bytes, so we can see the BOM (text() hides it)
    return { status: res.status, raw, body: raw.toString('utf8').replace(/^\uFEFF/, '') };
  };
}
const user = (role, name, login, pw = 'pw') =>
  Number(db.prepare('INSERT INTO users (role, full_name, login_id, password_hash) VALUES (?,?,?,?)')
    .run(role, name, login, bcrypt.hashSync(pw, 4)).lastInsertRowid);

let teacherId, otherTeacherId, classId, sessionId;

before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { jwtSecret: 'test-secret' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;

  user('admin', 'Admin', 'admin');
  teacherId = user('teacher', 'Prof', 'prof');
  otherTeacherId = user('teacher', 'Autre Prof', 'prof2');
  const s1 = user('student', 'Etu Un', 'S1');
  user('student', 'Etu Deux', 'S2');
  user('student', 'Etu Dehors', 'OUT'); // not enrolled anywhere
  classId = Number(db.prepare('INSERT INTO classes (name, teacher_id) VALUES (?,?)').run('Classe A', teacherId).lastInsertRowid);
  db.prepare('INSERT INTO enrollments VALUES (?,?)').run(classId, s1);
  db.prepare('INSERT INTO enrollments VALUES (?,?)').run(classId, db.prepare("SELECT id FROM users WHERE login_id='S2'").get().id);
});
after(() => server.close());

const login = async (id) => { const c = client(); const r = await c('POST', '/api/login', { login_id: id, password: 'pw' }); assert.equal(r.status, 200); return c; };

test('wrong password and unknown id give the same answer', async () => {
  const c = client();
  const a = await c('POST', '/api/login', { login_id: 'prof', password: 'nope' });
  const b = await c('POST', '/api/login', { login_id: 'ghost', password: 'nope' });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('roles are enforced', async () => {
  const stu = await login('S1');
  assert.equal((await stu('GET', '/api/admin/users')).status, 403);
  assert.equal((await stu('POST', '/api/teacher/sessions', { class_id: classId })).status, 403);
  assert.equal((await client()('GET', '/api/me')).status, 401);
});

test('teacher starts a session and gets a QR token', async () => {
  const t = await login('prof');
  const s = await t('POST', '/api/teacher/sessions', { class_id: classId, duration_minutes: 10 });
  assert.equal(s.status, 201);
  sessionId = s.body.id;
  const qr = await t('GET', `/api/teacher/sessions/${sessionId}/qr`);
  assert.equal(qr.status, 200);
  assert.ok(qr.body.token.includes('.'));
});

test("another teacher cannot see or start someone else's class", async () => {
  const t2 = await login('prof2');
  assert.equal((await t2('GET', `/api/teacher/sessions/${sessionId}/qr`)).status, 404);
  assert.equal((await t2('POST', '/api/teacher/sessions', { class_id: classId })).status, 404);
});

test('valid scan is recorded, second scan is "already_recorded" and no duplicate row', async () => {
  const t = await login('prof');
  const { body: { token } } = await t('GET', `/api/teacher/sessions/${sessionId}/qr`);
  const stu = await login('S1');
  const first = await stu('POST', '/api/student/scan', { token });
  assert.equal(first.body.status, 'recorded');
  const second = await stu('POST', '/api/student/scan', { token });
  assert.equal(second.body.status, 'already_recorded');
  const rows = db.prepare('SELECT COUNT(*) n FROM attendance WHERE session_id = ?').get(sessionId);
  assert.equal(rows.n, 1);
});

test('not-enrolled student is refused', async () => {
  const t = await login('prof');
  const { body: { token } } = await t('GET', `/api/teacher/sessions/${sessionId}/qr`);
  const out = await login('OUT');
  const r = await out('POST', '/api/student/scan', { token });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'not_enrolled');
});

test('expired token (old time slot) is refused', async () => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const old = makeToken(session, Math.floor(Date.now() / 1000) - 120);
  const stu = await login('S2');
  const r = await stu('POST', '/api/student/scan', { token: old });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_or_expired_token');
});

test('forged and garbage tokens are refused', async () => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const real = makeToken(session);
  const forged = real.split('.')[0] + '.AAAAAAAA';
  const stu = await login('S2');
  assert.equal((await stu('POST', '/api/student/scan', { token: forged })).status, 400);
  assert.equal((await stu('POST', '/api/student/scan', { token: 'hello' })).status, 400);
  assert.equal((await stu('POST', '/api/student/scan', {})).status, 400);
});

test('token from another session does not work', async () => {
  const t = await login('prof');
  const s2 = (await t('POST', '/api/teacher/sessions', { class_id: classId })).body.id;
  const other = db.prepare('SELECT * FROM sessions WHERE id = ?').get(s2);
  // Re-label a session-2 token as session 1 -> signature no longer matches session 1's secret.
  const session1 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const p = Buffer.from(JSON.stringify({ s: session1.id, w: Math.floor(Date.now() / 1000 / 25) })).toString('base64url');
  const sigFromOther = makeToken(other).split('.')[1];
  const stu = await login('S2');
  assert.equal((await stu('POST', '/api/student/scan', { token: `${p}.${sigFromOther}` })).status, 400);
  await t('POST', `/api/teacher/sessions/${s2}/close`);
});

test('closed session refuses scans', async () => {
  const t = await login('prof');
  const s = (await t('POST', '/api/teacher/sessions', { class_id: classId })).body.id;
  const { body: { token } } = await t('GET', `/api/teacher/sessions/${s}/qr`);
  await t('POST', `/api/teacher/sessions/${s}/close`);
  const stu = await login('S2');
  const r = await stu('POST', '/api/student/scan', { token });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'session_closed');
});

test('live list, manual override and student history', async () => {
  const t = await login('prof');
  let list = (await t('GET', `/api/teacher/sessions/${sessionId}/attendance`)).body;
  assert.equal(list.present, 1);
  assert.equal(list.total, 2);
  const s2id = db.prepare("SELECT id FROM users WHERE login_id='S2'").get().id;
  assert.equal((await t('POST', `/api/teacher/sessions/${sessionId}/manual`, { student_id: s2id })).status, 200);
  list = (await t('GET', `/api/teacher/sessions/${sessionId}/attendance`)).body;
  assert.equal(list.present, 2);
  assert.equal(list.students.find((s) => s.login_id === 'S2').method, 'manual');
  // not enrolled -> refused
  const outId = db.prepare("SELECT id FROM users WHERE login_id='OUT'").get().id;
  assert.equal((await t('POST', `/api/teacher/sessions/${sessionId}/manual`, { student_id: outId })).status, 400);
  const hist = (await (await login('S1'))('GET', '/api/student/history')).body;
  assert.ok(hist.some((h) => h.session_id === sessionId && h.present));
});

test('CSV export has BOM, header, and neutralises formula-looking names', async () => {
  db.prepare("UPDATE users SET full_name = '=cmd()' WHERE login_id = 'S1'").run();
  const t = await login('prof');
  const r = await t('GET', `/api/teacher/classes/${classId}/export.csv`);
  assert.equal(r.status, 200);
  assert.deepEqual([...r.raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel reads Arabic/accents
  assert.ok(r.body.startsWith('"Matricule"'));
  assert.ok(r.body.includes(`"'=cmd()"`));
});

test('admin: create teacher, assign, paste a class list', async () => {
  const a = await login('admin');
  const t = await a('POST', '/api/admin/users', { role: 'teacher', full_name: 'Nouveau Prof', login_id: 'newprof' });
  assert.equal(t.status, 201);
  assert.ok(t.body.password.length >= 8);
  assert.equal((await a('POST', '/api/admin/users', { role: 'teacher', full_name: 'X', login_id: 'newprof' })).status, 409);
  const c = await a('POST', '/api/admin/classes', { name: 'Classe B' });
  assert.equal((await a('PUT', `/api/admin/classes/${c.body.id}/teacher`, { teacher_id: t.body.id })).status, 200);
  assert.equal((await a('PUT', `/api/admin/classes/${c.body.id}/teacher`, { teacher_id: 'S1' })).status, 400);
  const list = await a('POST', `/api/admin/classes/${c.body.id}/students`, {
    students: [{ login_id: 'S1' }, { login_id: 'NEW1', full_name: 'Nouvel Etu' }],
  });
  assert.equal(list.body.enrolled, 2);
  assert.equal(list.body.created.length, 1);
  assert.equal((await a('GET', `/api/admin/classes/${c.body.id}/students`)).body.length, 2);
  // a list with a new student but no name is rejected as a whole
  const bad = await a('POST', `/api/admin/classes/${c.body.id}/students`, { students: [{ login_id: 'NONAME' }] });
  assert.equal(bad.status, 400);
  void teacherId; void otherTeacherId;
});
