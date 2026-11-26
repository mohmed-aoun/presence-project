# UniPrésence — QR-code attendance for university classes

A web platform for taking class attendance with QR codes. Administrators set up classes, teachers and students; a teacher opens an attendance session and shows a QR code in the classroom; students scan it with their phone to be marked present.

Built for the Faculté des Langues (Université Abou Bekr Belkaid, Tlemcen). The interface is in French, with the data model ready for Arabic / French / English.

> **Status: prototype.** The backend (API, database, QR security, tests) is complete and working. The HTML pages are still static mock-ups that run on fake data and are **not yet connected to the API** (see [Roadmap](#roadmap)).

---

## How it works

There are three roles, each with its own space:

| Role | What they do |
|------|--------------|
| **Admin** | Creates teacher and student accounts, creates classes, assigns a teacher to each class, and enrolls students (including by pasting a class list). |
| **Teacher** | Sees their own classes, starts an attendance session, displays the rotating QR code, watches students check in live, adds anyone manually (e.g. dead phone), closes the session, and exports attendance to CSV/Excel. |
| **Student** | Logs in, scans the teacher's QR code with their phone camera, and views their own attendance history. |

### The attendance flow

```
Admin                 Teacher                          Student
  │                      │                                │
  │ create class,        │                                │
  │ assign teacher,      │                                │
  │ enroll students      │                                │
  │ ───────────────────► │                                │
  │                      │ start session (e.g. 15 min)    │
  │                      │ QR code shown, refreshes       │
  │                      │ every ~25 s                    │
  │                      │ ─────── student scans QR ────► │
  │                      │                                │ server checks the token,
  │                      │ ◄── live attendance list ───── │ enrollment, and session
  │                      │ close session / export CSV     │ → marked present
```

### Anti-cheating design

The QR code does not contain a fixed link. It contains a **signed, short-lived token**:

- Each session has its own random secret, known only to the server.
- The token holds the session id and a time slot, signed with HMAC-SHA256 using that secret. It can't be forged without the secret.
- The slot changes every `QR_WINDOW_SECONDS` (default 25 s), so a screenshot forwarded on WhatsApp stops working within seconds. One previous slot is also accepted, so a scan right at the switch still works.
- On every scan the server also checks that the session is still open and within its time range, and that the student is **enrolled in that class**.
- A database `UNIQUE (session_id, student_id)` constraint makes double attendance impossible; scanning twice just answers `already_recorded`.
- Teachers can only access sessions of classes assigned to them.

Other security choices: passwords hashed with bcrypt; login in an `httpOnly`, `sameSite=lax` JWT cookie (12 h); identical error for wrong ID and wrong password (no account probing); CSV export neutralizes cells that could run as Excel formulas and includes a UTF-8 BOM so Arabic and accents display correctly; the server refuses to serve its own source files.

---

## Tech stack

- **Backend:** Node.js ≥ 22.13, Express 4, built-in `node:sqlite` (SQLite, single-file database — nothing else to install), `jsonwebtoken`, `bcryptjs`, `cookie-parser`
- **Frontend:** plain HTML/CSS/JavaScript pages, `qrcodejs` (teacher QR display), `html5-qrcode` (student camera scanner), SheetJS (Excel export in the mock-up)
- **Tests:** Node's built-in test runner (`node --test`)

## Project structure

```
presence-project/
├── index.html              Login page (mock-up)
├── admin.html              Admin dashboard: students, teachers, schedule (mock-up, localStorage)
├── espace_prof.html.html   Teacher space: QR generation, live list, Excel export (mock-up)
├── espace_etudiant.html    Student space: camera QR scanner (mock-up)
└── server/
    ├── .env.example        Configuration template
    ├── README.md           Server-specific notes
    ├── src/
    │   ├── server.js       Starts Express, serves the API and the HTML pages
    │   ├── app.js          All API routes, auth, and role checks
    │   ├── db.js           SQLite schema (created automatically)
    │   ├── qr.js           QR token creation and verification
    │   └── seed.js         Test data
    └── test/
        └── attendance.test.js
```

## Getting started

Requires **Node.js 22.13 or newer**.

```bash
cd server
npm install
cp .env.example .env     # then set JWT_SECRET to a long random string
npm run seed             # create test data
npm start                # http://localhost:3000
```

The server also serves the HTML pages from the repo root, so open `http://localhost:3000` in your browser.

### Test accounts (seed data — for testing only)

| Role | Login | Password |
|------|-------|----------|
| Admin | `admin` | `admin123` |
| Teacher | `prof1` (owns the demo class), `prof2` | `prof123` |
| Student | `ETU001` … `ETU010` | `etu123` |

The seed creates one class ("Anglais L2 - Groupe 1") with the ten students enrolled. **Change or delete these accounts before any real use.**

### Configuration (`server/.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `JWT_SECRET` | — (required) | Secret used to sign login cookies. Use a long random string. |
| `PORT` | `3000` | Port the server listens on. |
| `COOKIE_SECURE` | `false` | Set to `true` once the site is served over HTTPS. |
| `QR_WINDOW_SECONDS` | `25` | How often the QR code changes. |
| `DB_FILE` | `data/presence.db` | Path of the SQLite database file. |

### Running the tests

```bash
cd server
npm test
```

The suite covers: login behaviour, role enforcement, a teacher being blocked from another teacher's class, valid and duplicate scans, non-enrolled students, expired / forged / wrong-session tokens, closed sessions, manual override, live list and history, CSV export (BOM and formula neutralization), and the admin flow including pasting a class list.

---

## Data model

| Table | Purpose |
|-------|---------|
| `users` | Everyone: `role` (`admin` / `teacher` / `student`), `full_name`, `login_id` (student matricule or username, unique), password hash, `language` (`ar` / `fr` / `en`). |
| `classes` | A class/group with an optional assigned teacher. |
| `enrollments` | Which students belong to which class (a student can't be enrolled twice in one). |
| `sessions` | One class meeting: class, start/end time, `open`/`closed` status, and the secret that signs its QR tokens. |
| `attendance` | One row per student per session, with timestamp and method (`qr` or `manual`). |

## API reference

All endpoints speak JSON and authenticate with the login cookie. Errors look like `{ "error": "code" }`.

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Body `{ login_id, password }`. Sets the cookie; returns role, name, language. |
| POST | `/api/logout` | Clears the cookie. |
| GET | `/api/me` | Current user. |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/users` | Create a user (`role`, `full_name`, `login_id`, optional `password`, `language`). A random password is generated and returned if none is given. |
| GET | `/api/admin/users?role=` | List users, optionally by role. |
| POST | `/api/admin/classes` | Create a class (`name`, optional `teacher_id`). |
| GET | `/api/admin/classes` | List classes with teacher name and student count. |
| PUT | `/api/admin/classes/:id/teacher` | Assign a teacher (`teacher_id`). |
| POST | `/api/admin/classes/:id/students` | Paste a class list `{ students: [{ login_id, full_name }] }`. Unknown students get an account with a random password (returned once); known ones are just enrolled. All-or-nothing. |
| GET | `/api/admin/classes/:id/students` | List enrolled students. |

### Teacher
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/teacher/classes` | The teacher's own classes. |
| POST | `/api/teacher/sessions` | Start a session (`class_id`, `duration_minutes`, default 15, max 240). |
| GET | `/api/teacher/sessions/:id/qr` | Current QR token and seconds until it refreshes. Poll every few seconds. |
| GET | `/api/teacher/sessions/:id/attendance` | Live list: who is present, counts, whether the session is open. |
| POST | `/api/teacher/sessions/:id/manual` | Mark an enrolled student present manually (`student_id`). |
| POST | `/api/teacher/sessions/:id/close` | Close the session. |
| GET | `/api/teacher/classes/:id/export.csv` | Attendance sheet: one row per student, one column per session (P/A) plus total. Opens in Excel. |

### Student
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/student/scan` | Body `{ token }` from the QR code. Returns `recorded` or `already_recorded`. Fails with `invalid_token`, `invalid_or_expired_token`, `session_closed`, or `not_enrolled`. |
| GET | `/api/student/history` | The student's attendance across all their sessions. |

---

## Roadmap

**Frontend (next step)**
- Connect the HTML pages to the API. Right now they use `localStorage` or hard-coded demo data instead:
  - `index.html` — validates the form but doesn't log in; should call `POST /api/login` and redirect by role (and use the matricule/username instead of an e-mail field).
  - `admin.html` — manages students, teachers and a timetable in the browser only; should use the `/api/admin/*` endpoints.
  - `espace_prof.html.html` — generates a QR containing local data and a fake student list; should create a real session and display the rotating token from `/api/teacher/sessions/:id/qr`, with the live list from `/attendance`. (The filename also has a doubled `.html.html` extension that should be fixed.)
  - `espace_etudiant.html` — scans and just displays the decoded text; should send it to `POST /api/student/scan` and show the history.

**Before real-world use**
- Serve over **HTTPS** (phone browsers only allow camera access on HTTPS or localhost) and set `COOKIE_SECURE=true`.
- Login rate limiting.
- Arabic / French / English interface (the `language` field already exists per user).
- Replace the seed accounts and put real secrets in `.env`.

## License

No license specified yet.
