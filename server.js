const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'votes.db');
const SAVE_INTERVAL_MS = 3000;
const MIN_RANK_LIMIT = 1;
const MAX_RANK_LIMIT = 20;

let db;
let databaseDirty = false;
let saveTimer = null;

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
      rank_limit INTEGER NOT NULL DEFAULT 5,
      award_limit INTEGER NOT NULL DEFAULT 3,
      show_results_after_vote INTEGER NOT NULL DEFAULT 0,
      is_ended INTEGER NOT NULL DEFAULT 0,
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
  try { db.run('ALTER TABLE events ADD COLUMN rank_limit INTEGER NOT NULL DEFAULT 5'); } catch(e) {}
  try { db.run('ALTER TABLE events ADD COLUMN award_limit INTEGER NOT NULL DEFAULT 3'); } catch(e) {}
  try { db.run('ALTER TABLE events ADD COLUMN show_results_after_vote INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE events ADD COLUMN is_ended INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_event_voter_rank ON votes(event_id, voter_token, rank)');
  db.run('CREATE INDEX IF NOT EXISTS idx_votes_event_voter ON votes(event_id, voter_token)');
  db.run('CREATE INDEX IF NOT EXISTS idx_votes_event_work ON votes(event_id, work_id)');

  // 创建默认活动（如果没有任何活动）
  const eventCount = queryOne('SELECT COUNT(*) as cnt FROM events');
  if (!eventCount || eventCount.cnt === 0) {
    db.run('INSERT INTO events (name) VALUES (?)', ['默认活动']);
    // 将现有数据归属到默认活动
    db.run('UPDATE works SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
    db.run('UPDATE votes SET event_id = 1 WHERE event_id IS NULL OR event_id = 0');
    console.log('✅ 已创建默认活动');
  }

  databaseDirty = true;
  saveDatabase();
  console.log('✅ 数据库初始化完成');
}

function saveDatabase() {
  if (!db || !databaseDirty) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  databaseDirty = false;
  console.log(`💾 数据库批量保存完成 (${new Date().toISOString()})`);
}

function markDatabaseDirty() {
  databaseDirty = true;
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
  markDatabaseDirty();
  return db.getRowsModified();
}

function normalizeRankLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < MIN_RANK_LIMIT || limit > MAX_RANK_LIMIT) return null;
  return limit;
}

function normalizeFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function withImageUrl(row) {
  const item = { ...row };
  const hasImage = !!item.has_image || !!item.image_data;
  delete item.has_image;
  if (hasImage) item.image_url = `/api/works/${item.id}/image`;
  return item;
}

function sendImageData(res, imageData) {
  if (!imageData) return res.status(404).send('image not found');
  const match = String(imageData).match(/^data:([^;]+);base64,(.*)$/);
  const contentType = match ? match[1] : 'image/jpeg';
  const base64 = match ? match[2] : String(imageData);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(base64, 'base64'));
}

function startBatchPersistence() {
  saveTimer = setInterval(() => {
    try { saveDatabase(); } catch (error) { console.error('❌ 批量保存数据库失败', error); }
  }, SAVE_INTERVAL_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在保存数据库...`);
  if (saveTimer) clearInterval(saveTimer);
  try { saveDatabase(); } catch (error) { console.error('❌ 退出前保存失败', error); }
  process.exit(0);
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
  const { name, rank_limit, award_limit, show_results_after_vote } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '活动名称不能为空' });
  }
  const rankLimit = normalizeRankLimit(rank_limit === undefined ? 5 : rank_limit);
  if (!rankLimit) {
    return res.status(400).json({ error: `排名数量必须是 ${MIN_RANK_LIMIT}-${MAX_RANK_LIMIT} 之间的整数` });
  }
  const awardLimit = normalizeRankLimit(award_limit === undefined ? 3 : award_limit);
  if (!awardLimit) {
    return res.status(400).json({ error: `获奖名额必须是 ${MIN_RANK_LIMIT}-${MAX_RANK_LIMIT} 之间的整数` });
  }
  const showResultsAfterVote = normalizeFlag(show_results_after_vote);
  execute(
    'INSERT INTO events (name, rank_limit, award_limit, show_results_after_vote) VALUES (?, ?, ?, ?)',
    [name.trim(), rankLimit, awardLimit, showResultsAfterVote]
  );
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  res.json({ id: lastId?.id, rank_limit: rankLimit, award_limit: awardLimit, show_results_after_vote: showResultsAfterVote, message: '活动创建成功' });
});

app.patch('/api/events/:id/settings', (req, res) => {
  const { id } = req.params;
  const { name, rank_limit, award_limit, show_results_after_vote } = req.body;
  const event = queryOne('SELECT * FROM events WHERE id = ?', [id]);
  if (!event) return res.status(404).json({ error: '活动不存在' });
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '活动名称不能为空' });
  }
  const rankLimit = normalizeRankLimit(rank_limit === undefined ? event.rank_limit : rank_limit);
  if (!rankLimit) {
    return res.status(400).json({ error: `排名数量必须是 ${MIN_RANK_LIMIT}-${MAX_RANK_LIMIT} 之间的整数` });
  }
  const awardLimit = normalizeRankLimit(award_limit === undefined ? event.award_limit : award_limit);
  if (!awardLimit) {
    return res.status(400).json({ error: `获奖名额必须是 ${MIN_RANK_LIMIT}-${MAX_RANK_LIMIT} 之间的整数` });
  }
  const showResultsAfterVote = normalizeFlag(show_results_after_vote);
  execute(
    'UPDATE events SET name = ?, rank_limit = ?, award_limit = ?, show_results_after_vote = ? WHERE id = ?',
    [name.trim(), rankLimit, awardLimit, showResultsAfterVote, id]
  );
  res.json({ id: Number(id), rank_limit: rankLimit, award_limit: awardLimit, show_results_after_vote: showResultsAfterVote, message: '活动设置已保存' });
});

app.post('/api/events/:id/end', (req, res) => {
  const { id } = req.params;
  const event = queryOne('SELECT * FROM events WHERE id = ?', [id]);
  if (!event) return res.status(404).json({ error: '活动不存在' });
  execute('UPDATE events SET is_ended = 1 WHERE id = ?', [id]);
  saveDatabase();
  res.json({ message: '活动已结束，投票数据已保存' });
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
  const includeImages = req.query.include_images === '1';
  const fields = includeImages
    ? '*'
    : "id, event_id, title, author, description, created_at, CASE WHEN image_data IS NOT NULL AND image_data <> '' THEN 1 ELSE 0 END as has_image";
  let works;
  if (eventId) {
    works = queryAll(`SELECT ${fields} FROM works WHERE event_id = ? ORDER BY id ASC`, [eventId]);
  } else {
    works = queryAll(`SELECT ${fields} FROM works ORDER BY id ASC`);
  }
  res.json(works.map(withImageUrl));
});

app.get('/api/works/:id/image', (req, res) => {
  const work = queryOne('SELECT image_data FROM works WHERE id = ?', [req.params.id]);
  if (!work) return res.status(404).send('image not found');
  return sendImageData(res, work.image_data);
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
  const eid = event_id || 1;
  const event = queryOne('SELECT * FROM events WHERE id = ?', [eid]);
  if (!event) return res.status(404).json({ error: '活动不存在' });
  if (event.is_ended) return res.status(400).json({ error: '活动已结束，不能继续投票' });
  const rankLimit = normalizeRankLimit(event.rank_limit) || 5;
  if (!Array.isArray(work_ids) || work_ids.length !== rankLimit) {
    return res.status(400).json({ error: `请选择 ${rankLimit} 个参选项目` });
  }


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
  if (uniqueIds.length !== rankLimit) {
    return res.status(400).json({ error: `请选择 ${rankLimit} 个不重复的参选项目` });
  }
  for (const wid of uniqueIds) {
    if (!validIds.includes(wid)) {
      return res.status(400).json({ error: `作品 ID ${wid} 不存在` });
    }
  }

  try {
    db.run('BEGIN TRANSACTION');
    uniqueIds.forEach((wid, i) => {
      db.run('INSERT INTO votes (work_id, event_id, voter_token, rank) VALUES (?, ?, ?, ?)',
        [wid, eid, voter_token.trim(), i + 1]);
    });
    db.run('COMMIT');
    markDatabaseDirty();
  } catch (error) {
    try { db.run('ROLLBACK'); } catch (_) {}
    console.error('投票写入失败', error);
    return res.status(500).json({ error: '投票保存失败，请重试' });
  }

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

  const event = queryOne('SELECT * FROM events WHERE id = ?', [eid]);
  if (!event) return res.status(404).json({ error: '活动不存在' });
  if (req.query.public === '1' && !event.is_ended && !event.show_results_after_vote) {
    return res.status(403).json({ error: '活动设置为投票后不公开结果' });
  }
  const includeImages = req.query.include_images === '1';
  const imageField = includeImages
    ? 'w.image_data,'
    : "CASE WHEN w.image_data IS NOT NULL AND w.image_data <> '' THEN 1 ELSE 0 END as has_image,";
  const results = queryAll(`
    SELECT w.id, w.title, w.author, w.description, ${imageField}
           COALESCE((SELECT COUNT(*)
             FROM votes v
             WHERE v.work_id = w.id AND v.event_id = ?), 0) as score
    FROM works w
    WHERE w.event_id = ?
    ORDER BY score DESC, w.id ASC
  `, [eid, eid]).map(withImageUrl);

  const totalVoters = queryOne(
    'SELECT COUNT(DISTINCT voter_token) as cnt FROM votes WHERE event_id = ?',
    [eid]
  );

  res.json({
    event,
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
  startBatchPersistence();
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
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








