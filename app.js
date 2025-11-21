// app.js - Render friendly (no native modules)
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const { nanoid } = require('nanoid');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
app.use(morgan('combined'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ---------------- ENV ---------------- */
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || ''; // 填部署后 Render 域名
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PAID_COOKIE_NAME = process.env.PAID_COOKIE_NAME || 'paid_token';
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || '86400', 10);

/* ---------------- DB (lowdb) ---------------- */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const dbFile = path.join(DB_DIR, 'orders.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { orders: [] });   // 加上默认数据
async function initDB() {
  await db.read();
  db.data = db.data || { orders: [] };
  await db.write();
}
initDB();

/* ---------------- Helpers ---------------- */
function issueToken(postId, trade_no) {
  return jwt.sign({ postId, trade_no }, JWT_SECRET, { expiresIn: '24h' });
}

/* ---------------- Routes ---------------- */

/**
 * create-order
 * POST { post_id, amount }
 * returns { ok:true, trade_no }
 */
app.post('/api/create-order', async (req, res) => {
  const { post_id, amount = 199 } = req.body || {};
  if (!post_id) return res.status(400).json({ ok: false, error: 'post_id required' });
  const trade_no = `${Date.now()}_${nanoid(6)}`;
  await db.read();
  db.data.orders.push({
    trade_no,
    post_id,
    amount,
    status: 'PENDING',
    token: null,
    created_at: new Date().toISOString(),
    paid_at: null
  });
  await db.write();
  return res.json({ ok: true, trade_no });
});

/**
 * payment-notify
 * third-party or scanner will call this to mark as paid
 * accept JSON or form fields: trade_no, post_id, amount
 */
app.post('/api/payment-notify', async (req, res) => {
  const data = Object.assign({}, req.body, req.query);
  const trade_no = data.trade_no || data.out_trade_no || data.transaction_id || null;
  const post_id = data.post_id || data.post || data.attach || null;
  const amount = data.amount || data.total_fee || data.fee || null;

  if (!trade_no || !post_id) return res.status(400).send('missing trade_no or post_id');

  await db.read();
  const idx = db.data.orders.findIndex(o => o.trade_no === trade_no);
  const token = issueToken(post_id, trade_no);
  if (idx >= 0) {
    db.data.orders[idx].status = 'PAID';
    db.data.orders[idx].token = token;
    db.data.orders[idx].paid_at = new Date().toISOString();
    if (amount) db.data.orders[idx].amount = amount;
  } else {
    db.data.orders.push({
      trade_no,
      post_id,
      amount,
      status: 'PAID',
      token,
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString()
    });
  }
  await db.write();
  // some platforms expect "OK"
  return res.send('OK');
});

/**
 * check-payment?trade_no=xxx
 */
app.get('/api/check-payment', async (req, res) => {
  const { trade_no } = req.query;
  if (!trade_no) return res.status(400).json({ error: 'trade_no required' });
  await db.read();
  const row = db.data.orders.find(o => o.trade_no === trade_no);
  if (!row) return res.json({ paid: false });
  if (row.status === 'PAID') return res.json({ paid: true, token: row.token, post_id: row.post_id });
  return res.json({ paid: false });
});

/**
 * exchange-session?trade_no=xxx&post=yyy
 * sets HttpOnly cookie and redirects to article
 */
app.get('/api/exchange-session', async (req, res) => {
  const trade_no = req.query.trade_no;
  const post = req.query.post;
  if (!trade_no || !post) return res.status(400).send('missing trade_no or post');
  await db.read();
  const row = db.data.orders.find(o => o.trade_no === trade_no && o.post_id === post);
  if (!row || row.status !== 'PAID') return res.redirect(`${SITE_URL}/_pay/failed`);
  const token = row.token;
  // set cookie
  const cookieStr = `${PAID_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  // If SITE_URL is https and cookie secure desired, you could add ; Secure
  res.setHeader('Set-Cookie', cookieStr);
  const articleUrl = `${SITE_URL}/post/${encodeURIComponent(post)}`;
  return res.redirect(302, articleUrl);
});

/**
 * get-post?postId=xxx  (returns HTML of private post)
 */
app.get('/api/get-post', async (req, res) => {
  let token = null;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.split(' ')[1];
  if (!token) {
    const cookies = req.headers.cookie || '';
    const m = cookies.match(new RegExp('(?:^|; )' + PAID_COOKIE_NAME + '=([^;]+)'));
    if (m) token = m[1];
  }
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const postId = payload.postId;
    const file = path.join(__dirname, 'private_posts', `${postId}.html`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'post not found' });
    const html = fs.readFileSync(file, 'utf8');
    return res.json({ html });
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
});

/**
 * admin/orders - list recent orders (no auth - protect in production)
 */
app.get('/admin/orders', async (req, res) => {
  await db.read();
  return res.json(db.data.orders.slice().reverse().slice(0, 200));
});

/* ---------------- Start server ---------------- */
app.listen(PORT, () => {
  console.log(`Pay backend listening on port ${PORT}`);
});
