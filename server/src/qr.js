// QR tokens. The QR code on the teacher's screen contains a short text ("token").
// The token says "session 12, time-slot 71234" and carries a signature made with the
// session's secret. Only the server knows the secret, so nobody can forge a token.
// A new token is produced every WINDOW seconds, so a screenshot shared on WhatsApp
// stops working after a few seconds.
import crypto from 'node:crypto';

export const WINDOW_SECONDS = Number(process.env.QR_WINDOW_SECONDS || 25);
const GRACE_WINDOWS = 1; // also accept the previous slot, so a slow scan right at the switch still works

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function makeToken(session, nowSec = Math.floor(Date.now() / 1000)) {
  const slot = Math.floor(nowSec / WINDOW_SECONDS);
  const payload = b64(JSON.stringify({ s: session.id, w: slot }));
  return `${payload}.${sign(session.secret, payload)}`;
}

// Step 1: read which session the token claims to be for (not trusted yet).
export function readTokenSessionId(token) {
  try {
    const [payload] = String(token).split('.');
    const { s } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isInteger(s) ? s : null;
  } catch {
    return null;
  }
}

// Step 2: with the real session loaded from the database, check signature and freshness.
export function verifyToken(token, session, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return false;
    const expected = sign(session.secret, payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const { s, w } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (s !== session.id) return false;
    const current = Math.floor(nowSec / WINDOW_SECONDS);
    return w <= current && current - w <= GRACE_WINDOWS;
  } catch {
    return false;
  }
}
