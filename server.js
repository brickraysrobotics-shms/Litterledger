const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Admin password ----------
// Uses ADMIN_PASSWORD env var if set. Otherwise generates one on first run
// and stores it in .admin-password (git-ignored) so it's stable across restarts.
const ADMIN_PASSWORD_FILE = path.join(__dirname, '.admin-password');
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (fs.existsSync(ADMIN_PASSWORD_FILE)) {
    ADMIN_PASSWORD = fs.readFileSync(ADMIN_PASSWORD_FILE, 'utf8').trim();
  } else {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(ADMIN_PASSWORD_FILE, ADMIN_PASSWORD);
  }
}

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'litter-ledger.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  suggested_category_id TEXT,
  suggested_category_label TEXT,
  claimed_removed INTEGER NOT NULL DEFAULT 0,
  spot TEXT,
  photo BLOB NOT NULL,
  photo_mime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  points INTEGER,
  reviewer_note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  total_points INTEGER NOT NULL DEFAULT 0,
  items_logged INTEGER NOT NULL DEFAULT 0,
  items_removed INTEGER NOT NULL DEFAULT 0
);
`);

// Categories are just a hint the reporter gives the reviewer — they no longer
// determine points on their own. The admin decides points on every submission.
const CATEGORIES = [
  { id: 'butt', label: 'Cigarette butt' },
  { id: 'bottle', label: 'Bottle / can' },
  { id: 'wrapper', label: 'Wrapper' },
  { id: 'bag', label: 'Plastic bag/film' },
  { id: 'glass', label: 'Glass' },
  { id: 'other', label: 'Other / bulk item' },
];

function sanitizeUsername(s) {
  return String(s || '').trim().slice(0, 40);
}

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key');
  if (!key || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB raw upload cap, pre-compression
});

// ---------- Public routes ----------
app.get('/api/categories', (req, res) => {
  res.json(CATEGORIES);
});

app.post('/api/entries', upload.single('photo'), async (req, res) => {
  try {
    const username = sanitizeUsername(req.body.username);
    const categoryId = req.body.categoryId || null;
    const claimedRemoved = req.body.removed === 'true' || req.body.removed === true;
    const spot = (req.body.spot || '').toString().slice(0, 200);

    if (!username) return res.status(400).json({ error: 'username is required' });

    const cat = CATEGORIES.find((c) => c.id === categoryId) || null;

    if (!req.file) return res.status(400).json({ error: 'photo is required' });
    if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'file must be an image' });
    }

    // Resize + recompress server-side so we control what actually lands in the DB.
    const resized = await sharp(req.file.buffer)
      .rotate() // respect EXIF orientation
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const createdAt = Date.now();

    db.prepare(
      `INSERT INTO entries
        (id, username, suggested_category_id, suggested_category_label, claimed_removed, spot, photo, photo_mime, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?)`
    ).run(
      id,
      username,
      cat ? cat.id : null,
      cat ? cat.label : null,
      claimedRemoved ? 1 : 0,
      spot,
      resized,
      'image/jpeg',
      createdAt
    );

    // No user/leaderboard update yet — that happens on admin approval.
    res.json({
      id,
      username,
      category: cat ? cat.label : null,
      claimedRemoved,
      spot,
      status: 'pending',
      photoUrl: `/api/photos/${id}`,
      ts: createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Public feed: approved entries only.
app.get('/api/entries', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const rows = db
    .prepare(
      `SELECT id, username, suggested_category_label, claimed_removed, spot, points, created_at
       FROM entries WHERE status = 'approved' ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);

  res.json(
    rows.map((r) => ({
      id: r.id,
      username: r.username,
      category: r.suggested_category_label,
      claimedRemoved: !!r.claimed_removed,
      spot: r.spot,
      points: r.points,
      ts: r.created_at,
      photoUrl: `/api/photos/${r.id}`,
    }))
  );
});

app.get('/api/photos/:id', (req, res) => {
  const row = db.prepare('SELECT photo, photo_mime FROM entries WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.photo_mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(row.photo);
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db
    .prepare(
      'SELECT username, total_points, items_logged, items_removed FROM users ORDER BY total_points DESC'
    )
    .all();
  res.json(
    rows.map((u) => ({
      username: u.username,
      totalPoints: u.total_points,
      itemsLogged: u.items_logged,
      itemsRemoved: u.items_removed,
    }))
  );
});

app.get('/api/users/:username', (req, res) => {
  const username = sanitizeUsername(req.params.username);
  const row = db
    .prepare('SELECT username, total_points, items_logged, items_removed FROM users WHERE username = ?')
    .get(username);

  const pendingRow = db
    .prepare(`SELECT COUNT(*) AS n FROM entries WHERE username = ? AND status = 'pending'`)
    .get(username);
  const pendingCount = pendingRow ? pendingRow.n : 0;

  if (!row) {
    return res.json({
      username,
      totalPoints: 0,
      itemsLogged: 0,
      itemsRemoved: 0,
      rank: null,
      pendingCount,
    });
  }

  const rankRow = db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM users
       WHERE total_points > (SELECT total_points FROM users WHERE username = ?)`
    )
    .get(username);

  res.json({
    username: row.username,
    totalPoints: row.total_points,
    itemsLogged: row.items_logged,
    itemsRemoved: row.items_removed,
    rank: rankRow ? rankRow.rank : null,
    pendingCount,
  });
});

// ---------- Admin routes ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.get('/api/admin/pending', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, suggested_category_label, claimed_removed, spot, created_at
       FROM entries WHERE status = 'pending' ORDER BY created_at ASC`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      username: r.username,
      category: r.suggested_category_label,
      claimedRemoved: !!r.claimed_removed,
      spot: r.spot,
      ts: r.created_at,
      photoUrl: `/api/photos/${r.id}`,
    }))
  );
});

app.post('/api/admin/entries/:id/review', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { decision, points, note } = req.body || {};

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }

  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  if (entry.status !== 'pending') {
    return res.status(400).json({ error: 'entry already reviewed' });
  }

  let awardedPoints = null;
  if (decision === 'approved') {
    awardedPoints = parseInt(points, 10);
    if (!Number.isFinite(awardedPoints) || awardedPoints < 0) {
      return res.status(400).json({ error: 'points must be a non-negative number' });
    }
  }

  const reviewedAt = Date.now();
  db.prepare(
    `UPDATE entries SET status = ?, points = ?, reviewer_note = ?, reviewed_at = ? WHERE id = ?`
  ).run(decision, awardedPoints, (note || '').toString().slice(0, 300), reviewedAt, id);

  if (decision === 'approved') {
    const existing = db.prepare('SELECT username FROM users WHERE username = ?').get(entry.username);
    if (existing) {
      db.prepare(
        `UPDATE users
         SET total_points = total_points + ?, items_logged = items_logged + 1, items_removed = items_removed + ?
         WHERE username = ?`
      ).run(awardedPoints, entry.claimed_removed ? 1 : 0, entry.username);
    } else {
      db.prepare(
        `INSERT INTO users (username, total_points, items_logged, items_removed) VALUES (?,?,?,?)`
      ).run(entry.username, awardedPoints, 1, entry.claimed_removed ? 1 : 0);
    }
  }

  res.json({ id, status: decision, points: awardedPoints });
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Litter Ledger server running at http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Admin password (saved to .admin-password): ${ADMIN_PASSWORD}`);
    console.log(`Review queue: http://localhost:${PORT}/admin.html`);
  }
});
