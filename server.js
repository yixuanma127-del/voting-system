const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'votes.db');

let db;

// Initialize database
async function initDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('Created new database');
  }

  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER DEFAULT 1,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    description TEXT DEFAULT '',
    image_data TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id INTEGER NOT NULL,
    event_id INTEGER DEFAULT 1,
    voter_token TEXT NOT NULL,
    rank INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrations
  try { db.run('ALTER TABLE works ADD COLUMN event_id INTEGER DEFAULT 1'); } catch (e) {}
  try { db.run('ALTER TABLE votes ADD COLUMN event_id INTEGER DEFAULT 1'); } catch (e) {}
  try { db.run('ALTER TABLE works ADD COLUMN author TEXT DEFAULT \'\''); } catch (e) {}
  try { db.run('ALTER TABLE votes ADD COLUMN rank INTEGER DEFAULT 0'); } catch (e) {}

  const eventCount = queryOne('SELECT COUNT(*) as cnt FROM events');
  if (!eventCount || eventCount.cnt === 0) {
    db.run('INSERT INTO events (name) VALUES (?)', ['Default Event']);
    db.run('UPDATE works SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
    db.run('UPDATE votes SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
  }
  saveDatabase();
}

function saveDatabase() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const r = [];
  while (stmt.step()) r.push(stmt.getAsObject());
  stmt.free();
  return r;
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

function execute(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return db.getRowsModified();
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==================== Events API ====================
app.get('/api/events', (req, res) => {
  res.json(queryAll('SELECT * FROM events ORDER BY id DESC'));
});

app.post('/api/events', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Event name required' });
  execute('INSERT INTO events (name) VALUES (?)', [name.trim()]);
  const result = queryOne('SELECT last_insert_rowid() as id');
  res.json({ id: result?.id, message: 'Event created' });
});

app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;
  if (!queryOne('SELECT * FROM events WHERE id = ?', [id])) {
    return res.status(404).json({ error: 'Event not found' });
  }
  execute('DELETE FROM votes WHERE event_id = ?', [id]);
  execute('DELETE FROM works WHERE event_id = ?', [id]);
  execute('DELETE FROM events WHERE id = ?', [id]);
  res.json({ message: 'Event deleted' });
});

app.get('/api/events/default', (req, res) => {
  res.json(queryOne('SELECT * FROM events ORDER BY id DESC LIMIT 1') || { id: 0, name: 'Unnamed Event' });
});

// ==================== Works API ====================
app.get('/api/works', (req, res) => {
  const eid = req.query.event_id;
  if (eid) {
    res.json(queryAll('SELECT * FROM works WHERE event_id = ? ORDER BY id ASC', [eid]));
  } else {
    res.json(queryAll('SELECT * FROM works ORDER BY id ASC'));
  }
});

app.post('/api/works', (req, res) => {
  const { event_id, title, author, description, image_data } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  execute(
    'INSERT INTO works (event_id, title, author, description, image_data) VALUES (?, ?, ?, ?, ?)',
    [event_id || 1, title.trim(), (author || '').trim(), (description || '').trim(), image_data || '']
  );
  const result = queryOne('SELECT last_insert_rowid() as id');
  res.json({ id: result?.id, message: 'Work added' });
});

app.delete('/api/works/:id', (req, res) => {
  const { id } = req.params;
  execute('DELETE FROM votes WHERE work_id = ?', [id]);
  execute('DELETE FROM works WHERE id = ?', [id]);
  res.json({ message: 'Work deleted' });
});

// ==================== Vote API ====================
app.post('/api/vote', (req, res) => {
  const { event_id, work_ids, voter_token } = req.body;
  if (!voter_token) return res.status(400).json({ error: 'Missing voter token' });
  if (!Array.isArray(work_ids) || work_ids.length !== 5) {
    return res.status(400).json({ error: 'Please select 5 works in ranked order' });
  }

  const eid = event_id || 1;

  // Check if already voted in this event
  const existing = queryOne(
    'SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ? AND event_id = ?',
    [voter_token.trim(), eid]
  );
  if (existing && existing.cnt > 0) {
    return res.status(400).json({ error: 'You have already voted in this event' });
  }

  // Validate works exist in this event
  const allWorks = queryAll('SELECT id FROM works WHERE event_id = ?', [eid]);
  const validIds = allWorks.map(w => w.id);
  const uniqueIds = [...new Set(work_ids)];
  if (uniqueIds.length !== 5) return res.status(400).json({ error: 'Please select 5 unique works' });
  for (const wid of uniqueIds) {
    if (!validIds.includes(wid)) return res.status(400).json({ error: `Work ${wid} does not exist` });
  }

  // Insert votes with rank (1=1st place=5pts, 5=5th place=1pt)
  uniqueIds.forEach((wid, i) => {
    execute(
      'INSERT INTO votes (work_id, event_id, voter_token, rank) VALUES (?, ?, ?, ?)',
      [wid, eid, voter_token.trim(), i + 1]
    );
  });

  res.json({ message: 'Vote submitted! Thank you for participating.' });
});

app.get('/api/vote-check', (req, res) => {
  const { token, event_id } = req.query;
  if (!token) return res.json({ hasVoted: false });
  const eid = event_id || 1;
  const r = queryOne(
    'SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ? AND event_id = ?',
    [token, eid]
  );
  res.json({ hasVoted: r ? r.cnt > 0 : false });
});

app.get('/api/voter-check', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ hasVoted: false });
  const r = queryOne('SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ?', [token]);
  res.json({ hasVoted: r ? r.cnt > 0 : false });
});

// ==================== Results API ====================
app.get('/api/results', (req, res) => {
  const eid = req.query.event_id || 1;
  const results = queryAll(
    `SELECT
      w.id, w.title, w.author, w.description, w.image_data,
      COALESCE((
        SELECT SUM(CASE v.rank
          WHEN 1 THEN 5 WHEN 2 THEN 4 WHEN 3 THEN 3 WHEN 4 THEN 2 WHEN 5 THEN 1
          ELSE 0 END)
        FROM votes v WHERE v.work_id = w.id AND v.event_id = ?
      ), 0) as score
    FROM works w
    WHERE w.event_id = ?
    ORDER BY score DESC, w.id ASC`,
    [eid, eid]
  );

  const event = queryOne('SELECT name FROM events WHERE id = ?', [eid]);
  const totalVoters = queryOne(
    'SELECT COUNT(DISTINCT voter_token) as cnt FROM votes WHERE event_id = ?',
    [eid]
  );

  res.json({
    event: event || { name: 'Unnamed Event' },
    results,
    totalVoters: totalVoters?.cnt || 0
  });
});

// ==================== Reset API ====================
app.post('/api/reset', (req, res) => {
  const eid = req.body.event_id || 1;
  execute('DELETE FROM votes WHERE event_id = ?', [eid]);
  res.json({ message: 'Votes for this event have been reset' });
});

// ==================== Start ====================
initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('Voting system running on port ' + PORT);
    });
  })
  .catch(err => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
