// app.js – Pay backend with CORS + LowDB v6 fixed + Render-friendly

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const cors = require('cors');     // ⭐ 必须安装：npm i cors
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
app.use(morgan('combined'));
app.use(cors()); // ⭐ 允许你的博客前端跨域访问 API

// Body parsers
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

/* ●──────────── ENV ────────────● */
const PORT = parseInt(process.env.PORT || '3000', 10);
const SITE_URL = process.env.SITE_URL || ''; // e.g. https://hanscn.com
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || '86400', 10);

/* ●──────────── DB (lowdb v6 FIXED) ────────────● */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const dbFile = path.join(DB_DIR, 'orders.json');
const adapter = new JSONFile(dbFile);

// ⭐ lowdb 必须传默认数据，否则会报错：missing default data
const DEFAULT_DB = { orders: [] };
const db = new Low(adapter, DEFAULT_DB);

async function initDB() {
  try {
    await db.read();
  } catch (e) {
    console.warn('lowdb read error, initializing new DB:', e.message);
  }

  db.data = db.data || DEFAULT_DB;

  try {
    await db.write();
  } catch (e) {
    console.error('lowdb write error:', e.message);
  }
}
initDB();

/* ●──────────── Helpers ────────────● */
function issueToken(postId, trade_no) {
  return jwt.sign(
    { postId, trade_no },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/* ●──────────── API ────────────● */

// 1) 创建订单
app.post('/api/create-order', async (req, res) => {
  const { post_id, amount } = req.body;

  if (!post_id) return res.status(400).json({ ok: false, error: 'post_id required' });

  const trade_no = `${Date.now()}_${nanoid(6)}`;

  db.data.orders.push({
    trade_no,
    post_id,
    amount,
    paid: false
  });
  await db.write();

  res.json({ ok: true, trade_no });
});

// 2) 支付回调（模拟）
app.post('/api/payment-notify', async (req, res) => {
  const { trade_no, post_id, amount } = req.body;

  const order = db.data.orders.find(o => o.trade_no === trade_no);
  if (!order) return res.status(404).send('order not found');

  order.paid = true;
  order.amount = amount || order.amount;
  order.post_id = post_id || order.post_id;

  await db.write();
  res.send('OK');
});

// 3) 查询支付状态
app.get('/api/check-payment', async (req, res) => {
  const { trade_no } = req.query;

  const order = db.data.orders.find(o => o.trade_no === trade_no);
  if (!order || !order.paid) return res.json({ paid: false });

  const token = issueToken(order.post_id, trade_no);

  res.json({
    paid: true,
    token,
    post_id: order.post_id
  });
});

// 4) 返回付费内容
app.get('/api/get-post', (req, res) => {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'missing token' });

  const token = auth.replace('Bearer ', '');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const postId = decoded.postId;

    const filePath = path.join(__dirname, 'private_posts', `${postId}.html`);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'post not found' });

    const html = fs.readFileSync(filePath, 'utf-8');

    res.json({ html });

  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
});

/* ●──────────── Start Server ────────────● */
app.listen(PORT, () => {
  console.log(`Pay backend running on port ${PORT}`);
});
