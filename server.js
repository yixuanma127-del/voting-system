const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'votes.db');

let db;

// ─────────── 初始化数据库 ───────────
async function initDatabase() {
  const SQL = await initSqlJs();

  // 如果已有数据库文件则加载，否则创建新的
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('📂 已加载现有数据库');
  } else {
    db = new SQL.Database();
    console.log('🆕 创建新数据库');
  }

  // 活动表
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 作品表
  db.run(`
    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER DEFAULT 1,
      title TEXT NOT NULL,
      author TEXT DEFAULT '',
      description TEXT DEFAULT '',
      image_data TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 投票表
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      event_id INTEGER DEFAULT 1,
      voter_token TEXT NOT NULL,
      rank INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：添加 event_id 列
  try { db.run('ALTER TABLE works ADD COLUMN event_id INTEGER DEFAULT 1'); console.log('✅ works 已添加 event_id'); } catch(e) {}
  try { db.run('ALTER TABLE votes ADD COLUMN event_id INTEGER DEFAULT 1'); console.log('✅ votes 已添加 event_id'); } catch(e) {}
  try { db.run('ALTER TABLE works ADD COLUMN author TEXT DEFAULT \'\''); } catch(e) {}
  try { db.run('ALTER TABLE votes ADD COLUMN rank INTEGER DEFAULT 0'); } catch(e) {}

  // 创建默认活动（如果没有任何活动）
  const eventCount = queryOne('SELECT COUNT(*) as cnt FROM events');
  if (!eventCount || eventCount.cnt === 0) {
    db.run('INSERT INTO events (name) VALUES (?)', ['默认活动']);
    // 将现有数据归属到默认活动
    db.run('UPDATE works SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
    db.run('UPDATE votes SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
    console.log('✅ 已创建默认活动');
  }

  saveDatabase();
  console.log('✅ 数据库初始化完成');
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ─────────── 查询辅助函数 ───────────
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results[0] || null;
}

function execute(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return db.getRowsModified();
}

// ─────────── 中间件 ───────────
app.use(express.json({ limit: '50mb' }));

// CORS 支持（微信小程序需要）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─────────── 活动 API ───────────

// 获取所有活动
app.get('/api/events', (req, res) => {
  const events = queryAll('SELECT * FROM events ORDER BY id DESC');
  res.json(events);
});

// 创建活动
app.post('/api/events', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '活动名称不能为空' });
  }
  execute('INSERT INTO events (name) VALUES (?)', [name.trim()]);
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  res.json({ id: lastId?.id, message: '活动创建成功' });
});

// 删除活动（级联删除作品和投票）
app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const event = queryOne('SELECT * FROM events WHERE id = ?', [id]);
  if (!event) return res.status(404).json({ error: '活动不存在' });

  execute('DELETE FROM votes WHERE event_id = ?', [id]);
  execute('DELETE FROM works WHERE event_id = ?', [id]);
  execute('DELETE FROM events WHERE id = ?', [id]);
  res.json({ message: '活动已删除（含作品和投票数据）' });
});

// 获取默认活动
app.get('/api/events/default', (req, res) => {
  const event = queryOne('SELECT * FROM events ORDER BY id DESC LIMIT 1');
  res.json(event || { id: 0, name: '未命名活动' });
});

// ─────────── 作品 API ───────────

// 获取作品（可按活动过滤）
app.get('/api/works', (req, res) => {
  const eventId = req.query.event_id;
  let works;
  if (eventId) {
    works = queryAll('SELECT * FROM works WHERE event_id = ? ORDER BY id ASC', [eventId]);
  } else {
    works = queryAll('SELECT * FROM works ORDER BY id ASC');
  }
  res.json(works);
});

// 添加作品
app.post('/api/works', (req, res) => {
  const { event_id, title, author, description, image_data } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: '作品标题不能为空' });
  }
  const eid = event_id || 1;
  execute(
    'INSERT INTO works (event_id, title, author, description, image_data) VALUES (?, ?, ?, ?, ?)',
    [eid, title.trim(), (author || '').trim(), (description || '').trim(), image_data || '']
  );
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  res.json({ id: lastId?.id, message: '作品添加成功' });
});

// 删除作品
app.delete('/api/works/:id', (req, res) => {
  const { id } = req.params;
  execute('DELETE FROM votes WHERE work_id = ?', [id]);
  execute('DELETE FROM works WHERE id = ?', [id]);
  res.json({ message: '作品已删除' });
});

// ─────────── 投票 API ───────────

// 投票
app.post('/api/vote', (req, res) => {
  const { event_id, work_ids, voter_token } = req.body;

  if (!voter_token || !voter_token.trim()) {
    return res.status(400).json({ error: '缺少投票者标识' });
  }
  if (!Array.isArray(work_ids) || work_ids.length !== 5) {
    return res.status(400).json({ error: '请按排名顺序选择 5 个作品' });
  }

  const eid = event_id || 1;

  // 检查该活动是否已投票
  const existing = queryOne(
    'SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ? AND event_id = ?',
    [voter_token.trim(), eid]
  );
  if (existing && existing.cnt > 0) {
    return res.status(400).json({ error: '您在该活动中已经投过票了' });
  }

  // 检查作品是否属于该活动
  const allWorks = queryAll('SELECT id FROM works WHERE event_id = ?', [eid]);
  const validIds = allWorks.map(w => w.id);
  const uniqueIds = [...new Set(work_ids)];
  if (uniqueIds.length !== 5) {
    return res.status(400).json({ error: '请选择 5 个不重复的作品' });
  }
  for (const wid of uniqueIds) {
    if (!validIds.includes(wid)) {
      return res.status(400).json({ error: `作品 ID ${wid} 不存在` });
    }
  }

  uniqueIds.forEach((wid, i) => {
    execute('INSERT INTO votes (work_id, event_id, voter_token, rank) VALUES (?, ?, ?, ?)',
      [wid, eid, voter_token.trim(), i + 1]);
  });

  res.json({ message: '投票成功！感谢您的参与' });
});

// 检查是否已投票（通过活动+token）
app.get('/api/vote-check', (req, res) => {
  const { token, event_id } = req.query;
  if (!token) return res.json({ hasVoted: false });
  const eid = event_id || 1;
  const result = queryOne(
    'SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ? AND event_id = ?',
    [token, eid]
  );
  res.json({ hasVoted: result ? result.cnt > 0 : false });
});

// 旧端点兼容
app.get('/api/vote/:token', (req, res) => {
  const { token } = req.params;
  if (!token) return res.json({ hasVoted: false });
  const result = queryOne('SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ?', [token]);
  res.json({ hasVoted: result ? result.cnt > 0 : false, votes: result ? result.cnt : 0 });
});

app.get('/api/voter-check', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ hasVoted: false });
  const result = queryOne('SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ?', [token]);
  res.json({ hasVoted: result ? result.cnt > 0 : false });
});

// ─────────── 结果 API ───────────

// 获取投票结果（按活动）
app.get('/api/results', (req, res) => {
  const eventId = req.query.event_id;
  const eid = eventId || 1;

  const results = queryAll(`
    SELECT w.id, w.title, w.author, w.description, w.image_data,
           COALESCE((SELECT SUM(
             CASE v.rank
               WHEN 1 THEN 5
               WHEN 2 THEN 4
               WHEN 3 THEN 3
               WHEN 4 THEN 2
               WHEN 5 THEN 1
               ELSE 0
             END
           ) FROM votes v WHERE v.work_id = w.id AND v.event_id = ?), 0) as score
    FROM works w
    WHERE w.event_id = ?
    ORDER BY score DESC, w.id ASC
  `, [eid, eid]);

  const event = queryOne('SELECT name FROM events WHERE id = ?', [eid]);
  const totalVoters = queryOne(
    'SELECT COUNT(DISTINCT voter_token) as cnt FROM votes WHERE event_id = ?',
    [eid]
  );

  res.json({
    event: event || { name: '未命名活动' },
    results,
    totalVoters: totalVoters?.cnt || 0
  });
});

// ─────────── 重置 API ───────────

// 重置活动投票
app.post('/api/reset', (req, res) => {
  const { event_id } = req.body;
  const eid = event_id || 1;
  execute('DELETE FROM votes WHERE event_id = ?', [eid]);
  res.json({ message: '该活动的投票已重置' });
});

app.post('/api/reset-votes', (req, res) => {
  execute('DELETE FROM votes');
  res.json({ message: '所有投票已重置' });
});

// ─────────── 首页 ───────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────── 启动服务 ───────────
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║     🗳️  在线投票系统已启动          ║');
    console.log('╠══════════════════════════════════════╣');
    console.log('║  管理后台: http://localhost:' + PORT + '/admin.html  ║');
    console.log('║  投票入口: http://localhost:' + PORT + '/            ║');
    console.log('╚══════════════════════════════════════╝\n');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
