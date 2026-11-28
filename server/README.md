# Presence server (prototype)

Node.js + Express + SQLite. The database is one file (`server/data/presence.db`), created automatically.
Needs Node 22.13 or newer.

## Run it
```
cd server
npm install
cp .env.example .env        # then set JWT_SECRET to a long random string
npm run seed                # test users: admin/admin123, prof1/prof123, ETU001..ETU010/etu123
npm start                   # http://localhost:3000 (also serves the HTML pages)
```
Test logins are for TEST ONLY.

## Test it
```
npm test
```
Covers: login, role checks, a teacher can't touch another teacher's class, valid scan, double scan,
not-enrolled student, expired / forged / wrong-session token, closed session, manual override,
history, CSV export, admin class-list paste.

## Endpoints (all JSON, login via cookie)
- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- Admin: `POST|GET /api/admin/users`, `POST|GET /api/admin/classes`, `PUT /api/admin/classes/:id/teacher`, `POST|GET /api/admin/classes/:id/students`
- Teacher: `GET /api/teacher/classes`, `POST /api/teacher/sessions`, `GET .../sessions/:id/qr`, `GET .../sessions/:id/attendance`, `POST .../sessions/:id/manual`, `POST .../sessions/:id/close`, `GET /api/teacher/classes/:id/export.csv`
- Student: `POST /api/student/scan` ({ token }), `GET /api/student/history`

## Not done yet
- HTTPS (phone cameras only scan on https), login rate limiting, Arabic/English UI.
- Edit/delete users and classes, password reset.
