import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '../..'); // the repo root, where the HTML pages are

const db = openDb();
const api = createApp(db);

const app = express();
// Never serve the server's own code or config as web pages.
app.use((req, res, next) => (req.path.startsWith('/server') ? res.status(404).end() : next()));
app.use(api);
app.use(express.static(siteDir, { dotfiles: 'deny', index: 'index.html' }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Presence server on http://localhost:${port}`));
