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

  db.run(`
    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      image_data TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      voter_token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  saveDatabase();
  console.log('✅ 数据库初始化完成（作品列表为空，请在管理后台添加）');
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
app.use(express.static(path.join(__dirname, 'public')));

// ─────────── API 路由 ───────────

// 获取所有作品
app.get('/api/works', (req, res) => {
  const works = queryAll('SELECT * FROM works ORDER BY id ASC');
  res.json(works);
});

// 添加作品
app.post('/api/works', (req, res) => {
  const { title, description, image_data } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: '作品标题不能为空' });
  }
  execute(
    'INSERT INTO works (title, description, image_data) VALUES (?, ?, ?)',
    [title.trim(), (description || '').trim(), image_data || '']
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

// 投票
app.post('/api/vote', (req, res) => {
  const { work_ids, voter_token } = req.body;

  if (!voter_token || !voter_token.trim()) {
    return res.status(400).json({ error: '缺少投票者标识' });
  }
  if (!Array.isArray(work_ids) || work_ids.length === 0) {
    return res.status(400).json({ error: '请至少选择1个作品' });
  }
  if (work_ids.length > 5) {
    return res.status(400).json({ error: '最多只能投5个作品' });
  }

  // 检查是否已投票
  const existing = queryOne('SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ?', [voter_token.trim()]);
  if (existing && existing.cnt > 0) {
    return res.status(400).json({ error: '您已经投过票了，每个用户只能投票一次' });
  }

  // 检查作品是否存在
  const allWorks = queryAll('SELECT id FROM works');
  const validIds = allWorks.map(w => w.id);
  const uniqueIds = [...new Set(work_ids)];
  for (const wid of uniqueIds) {
    if (!validIds.includes(wid)) {
      return res.status(400).json({ error: `作品 ID ${wid} 不存在` });
    }
  }

  // 批量插入投票
  uniqueIds.forEach(wid => {
    execute('INSERT INTO votes (work_id, voter_token) VALUES (?, ?)', [wid, voter_token.trim()]);
  });

  res.json({ message: '投票成功！感谢您的参与', voted_count: uniqueIds.length });
});

// 检查是否已投票
app.get('/api/voter-check', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ hasVoted: false });
  const result = queryOne('SELECT COUNT(*) as cnt FROM votes WHERE voter_token = ?', [token]);
  res.json({ hasVoted: result ? result.cnt > 0 : false });
});

// 获取投票结果
app.get('/api/results', (req, res) => {
  const results = queryAll(`
    SELECT w.id, w.title, w.description, w.image_data,
           (SELECT COUNT(*) FROM votes v WHERE v.work_id = w.id) as vote_count
    FROM works w
    ORDER BY vote_count DESC, w.id ASC
  `);
  const totalVoters = queryOne('SELECT COUNT(DISTINCT voter_token) as cnt FROM votes');
  res.json({ results, totalVoters: totalVoters?.cnt || 0 });
});

// 重置所有投票
app.post('/api/reset-votes', (req, res) => {
  execute('DELETE FROM votes');
  res.json({ message: '所有投票已重置' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  首页 → 观众投票页面（无管理功能）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
