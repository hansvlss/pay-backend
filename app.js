// app.js – Pay backend (with CORS and improved error handling)
// Minimal deps: express, body-parser, jsonwebtoken, lowdb, nanoid, morgan, cors

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const cors = require('cors');
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
app.use(morgan('combined'));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

/* ============ ENV ============ */
const PORT = parseInt(process.env.PORT || '3000', 10);
const SITE_URL = process.env.SITE_URL || ''; // e.g. https://hanscn.com
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PAID_COOKIE_NAME = process.env.PAID_COOKIE_NAME || 'paid_token';
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || '86400', 10);

/* ============ CORS ============ */
// 如果 SITE_URL 设置则只允许该 origin；否则允许所有（你可以改成更严格的策略）
if (SITE_URL) {
  app.use(cors({ origin: SITE_URL }));
} else {
  app.use(cors());
}

/* ============ DB (lowdb) ============ */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const dbFile = path.join(DB_DIR, 'orders.json');
const adapter = new JSONFile(dbFile);

// lowdb v6 要传默认数据作为第二参数，避免 "missing default data" 错误
const db = new Low(adapter, { orders: [] });

async function initDB() {
  await db.read();
  db.data = db.data || { orders: [] };
  await db.write();
}
initDB().catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

/* ============ Helpers ============ */
function issueToken(postId, trade_no) {
  return jwt.sign({ postId, trade_no }, JWT_SECRET, { expiresIn: '24h' });
}

/* ============ API ============ */

// POST /api/create-order
app.post('/api/create-order', async (req, res) => {
  const { post_id, amount } = req.body || {};
  if (!post_id) return res.status(400).json({ ok: false, error: 'post_id required' });

  const trade_no = `${Date.now()}_${nanoid(6)}`;
  db.data.orders.push({ trade_no, post_id, amount: amount || 0, paid: false });
  await db.write();
  res.json({ ok: true, trade_no });
});

// POST /api/payment-notify  (simulate payment)
app.post('/api/payment-notify', async (req, res) => {
  const { trade_no, post_id, amount } = req.body || {};
  if (!trade_no) return res.status(400).send('trade_no required');

  const order = db.data.orders.find(o => o.trade_no === trade_no);
  if (!order) return res.status(404).send('order not found');

  order.paid = true;
  if (amount) order.amount = amount;
  if (post_id) order.post_id = post_id;
  await db.write();
  res.send('OK');
});

// GET /api/check-payment?trade_no=...
app.get('/api/check-payment', async (req, res) => {
  const { trade_no } = req.query || {};
  if (!trade_no) return res.json({ paid: false });

  const order = db.data.orders.find(o => o.trade_no === trade_no);
  if (!order) return res.json({ paid: false });

  if (!order.paid) return res.json({ paid: false });

  const token = issueToken(order.post_id, order.trade_no);
  res.json({ paid: true, token, post_id: order.post_id });
});

// GET /api/get-post  — 需要 Authorization: Bearer <token>
app.get('/api/get-post', (req, res) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });

  const token = auth.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const postId = decoded.postId;
    const filePath = path.join(__dirname, 'private_posts', `${postId}.html`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'post not found' });
    const html = fs.readFileSync(filePath, 'utf-8');
    res.json({ html });
  } catch (e) {
    console.error('token error', e && e.message);
    return res.status(401).json({ error: 'invalid or expired token' });
  }
});

/* health / root */
app.get('/', (req, res) => {
  res.status(404).send('Not Found');
});

/* ============ Start ============ */
app.listen(PORT, () => {
  console.log(`Pay backend running on port ${PORT}`);
});
