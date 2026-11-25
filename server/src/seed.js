// Fills the database with test data: 1 admin, 2 teachers, 1 class with 10 students.
// Run:  npm run seed      (safe to run twice: existing logins are skipped)
import bcrypt from 'bcryptjs';
import { openDb } from './db.js';

const db = openDb();
const add = (role, full_name, login_id, pw) => {
  db.prepare('INSERT OR IGNORE INTO users (role, full_name, login_id, password_hash) VALUES (?,?,?,?)')
    .run(role, full_name, login_id, bcrypt.hashSync(pw, 10));
  return db.prepare('SELECT id FROM users WHERE login_id = ?').get(login_id).id;
};

add('admin', 'Administrateur', 'admin', 'admin123');
const t1 = add('teacher', 'Prof Test 1', 'prof1', 'prof123');
add('teacher', 'Prof Test 2', 'prof2', 'prof123');

if (!db.prepare('SELECT 1 FROM classes').get()) {
  const cid = Number(db.prepare('INSERT INTO classes (name, teacher_id) VALUES (?, ?)').run('Anglais L2 - Groupe 1', t1).lastInsertRowid);
  for (let i = 1; i <= 10; i++) {
    const sid = add('student', `Etudiant ${i}`, `ETU${String(i).padStart(3, '0')}`, 'etu123');
    db.prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?, ?)').run(cid, sid);
  }
}
console.log('Seed done. Logins: admin/admin123, prof1/prof123, ETU001../etu123  (TEST ONLY - change before any real use)');
