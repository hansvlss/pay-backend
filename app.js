// backend/app.js
// 完整付费阅读后端：订单创建、支付回调、轮询、会话换取、文章读取

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const Database = require('better-sqlite3');
const cookie = require('cookie');
const morgan = require('morgan');

const app = express();
app.use(morgan('combined'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ------------------ ENV ----------------------- */
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_secret';
const PAID_COOKIE_NAME = process.env.PAID_COOKIE_NAME || 'paid_token';
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || '86400', 10);

/* ------------------ DB ------------------------- */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

const db = new Database(path.join(DB_DIR, 'orders.sqlite'));
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_no TEXT UNIQUE,
  post_id TEXT,
  amount INTEGER,
  status TEXT DEFAULT 'PENDING',
  token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME
);
`);

/* ------------------ Helper --------------------- */
function issueToken(post_id, trade_no) {
  return jwt.sign({ post_id, trade_no }, JWT_SECRET, { expiresIn: '24h' });
}

/* ------------------ API Routes ------------------- */

/**
 * 1. 创建订单（客户端请求）
 */
app.post('/api/create-order', (req, res) => {
  const { post_id, amount = 199 } = req.body;

  if (!post_id)
    return res.status(400).json({ ok: false, error: 'post_id is required' });

  const trade_no = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    db.prepare(
      'INSERT INTO orders (trade_no, post_id, amount, status) VALUES (?, ?, ?, ?)'
    ).run(trade_no, post_id, amount, 'PENDING');

    return res.json({ ok: true, trade_no });
  } catch (err) {
    console.error('create-order error:', err);
    return res.status(500).json({ ok: false, error: 'db error' });
  }
});

/**
 * 2. 支付回调（Scanner 或第三方平台调用）
 */
app.post('/api/payment-notify', (req, res) => {
  const data = Object.assign({}, req.body, req.query);

  const trade_no =
    data.trade_no ||
    data.out_trade_no ||
    data.transaction_id ||
    data.tradeNo ||
    null;

  const post_id = data.post_id || data.post || data.attach || null;
  const amount = data.amount || data.fee || data.total_fee || null;

  if (!trade_no || !post_id) {
    console.warn('missing trade_no or post_id:', data);
    return res.status(400).send('missing required fields');
  }

  try {
    const row = db
      .prepare('SELECT id, status FROM orders WHERE trade_no=?')
      .get(trade_no);
    const token = issueToken(post_id, trade_no);

    if (row) {
      // 已存在订单
      if (row.status === 'PAID') return res.send('OK');

      db.prepare(
        'UPDATE orders SET status=?, token=?, paid_at=?, amount=? WHERE trade_no=?'
      ).run('PAID', token, new Date().toISOString(), amount, trade_no);

      console.log('order updated PAID:', trade_no);
      return res.send('OK');
    } else {
      // 回调先到达 -> 自动创建
      db.prepare(
        'INSERT INTO orders (trade_no, post_id, amount, status, token, paid_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        trade_no,
        post_id,
        amount,
        'PAID',
        token,
        new Date().toISOString()
      );

      console.log('order created PAID:', trade_no);
      return res.send('OK');
    }
  } catch (err) {
    console.error('notify error:', err);
    return res.status(500).send('server error');
  }
});

/**
 * 3. 查询支付状态（客户端轮询）
 */
app.get('/api/check-payment', (req, res) => {
  const { trade_no } = req.query;

  if (!trade_no)
    return res.status(400).json({ error: 'trade_no is required' });

  const row = db
    .prepare('SELECT status, token, post_id FROM orders WHERE trade_no=?')
    .get(trade_no);

  if (!row) return res.json({ paid: false });

  if (row.status === 'PAID')
    return res.json({ paid: true, token: row.token, post_id: row.post_id });

  return res.json({ paid: false });
});

/**
 * 4. 会话换取 (成功付款跳转)
 */
app.get('/api/exchange-session', (req, res) => {
  const trade_no = req.query.trade_no;
  const post_id = req.query.post;

  if (!trade_no || !post_id)
    return res.status(400).send('missing trade_no or post');

  const row = db
    .prepare(
      'SELECT status, token FROM orders WHERE trade_no=? AND post_id=?'
    )
    .get(trade_no, post_id);

  if (!row || row.status !== 'PAID') {
    return res.redirect(`${SITE_URL}/_pay/failed`);
  }

  const cookieStr = cookie.serialize(PAID_COOKIE_NAME, row.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
    path: '/'
  });

  res.setHeader('Set-Cookie', cookieStr);

  const articleUrl = `${SITE_URL}/post/${encodeURIComponent(post_id)}`;
  return res.redirect(302, articleUrl);
});

/**
 * 5. 获取付费文章全文（需 token）
 */
app.get('/api/get-post', (req, res) => {
  let token = null;

  // Bearer token
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.split(' ')[1];

  // Cookie
  if (!token) {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(
      new RegExp('(?:^|; )' + PAID_COOKIE_NAME + '=([^;]+)')
    );
    if (match) token = match[1];
  }

  if (!token) return res.status(401).json({ error: 'no token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const post_id = payload.post_id;

    const file = path.join(__dirname, 'private_posts', `${post_id}.html`);

    if (!fs.existsSync(file))
      return res.status(404).json({ error: 'post not found' });

    const html = fs.readFileSync(file, 'utf8');
    return res.json({ html });
  } catch (e) {
    console.warn('invalid token:', e.message);
    return res.status(401).json({ error: 'invalid or expired token' });
  }
});

/**
 * 6. 后台查看订单（可加密码）
 */
app.get('/admin/orders', (req, res) => {
  const rows = db
    .prepare(
      'SELECT trade_no, post_id, amount, status, created_at, paid_at FROM orders ORDER BY id DESC LIMIT 200'
    )
    .all();

  res.json(rows);
});

/* ------------------ Start Server --------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BACKEND running at port ${PORT}`);
});
