// app.js – Pay backend (with CORS and improved error handling)
// Minimal dependencies, designed to run on Render / similar PaaS

const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const cors = require("cors");
const { nanoid } = require("nanoid");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

const app = express();
app.use(morgan("combined"));
app.use(cors()); // allow all origins
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

/* -------------- ENV -------------- */
const PORT = parseInt(process.env.PORT || "3000", 10);
const SITE_URL = process.env.SITE_URL || ""; // Optional for redirects
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const PAID_COOKIE_NAME = process.env.PAID_COOKIE_NAME || "paid_token";
const COOKIE_MAX_AGE = parseInt(process.env.COOKIE_MAX_AGE || "86400", 10);

/* -------------- DB (lowdb v6 fix) -------------- */
const DB_DIR = path.join(__dirname, "db");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const dbFile = path.join(DB_DIR, "orders.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter); // DO NOT pass default data here (v6 rule)

// Proper DB initialization
async function initDB() {
  try {
    await db.read();
  } catch (e) {
    console.error("lowdb read error (continuing):", e.message);
  }

  db.data = db.data || { orders: [] };

  try {
    await db.write();
  } catch (e) {
    console.error("lowdb write error:", e.message);
  }
}
initDB();

/* -------------- Helpers -------------- */
function issueToken(postId, trade_no) {
  return jwt.sign({ postId, trade_no }, JWT_SECRET, { expiresIn: "24h" });
}

/* -------------- API -------------- */

// 1) Create order
app.post("/api/create-order", async (req, res) => {
  const { post_id, amount = 199 } = req.body;

  if (!post_id) {
    return res.status(400).json({ ok: false, error: "post_id required" });
  }

  const trade_no = `${Date.now()}_${nanoid(6)}`;

  db.data.orders.push({
    trade_no,
    post_id,
    amount,
    paid: false,
    created_at: new Date().toISOString(),
  });

  await db.write();

  res.json({ ok: true, trade_no });
});

// 2) Simulate payment callback
app.post("/api/payment-notify", async (req, res) => {
  const { trade_no, post_id, amount } = req.body;

  const order = db.data.orders.find((o) => o.trade_no === trade_no);
  if (!order) return res.status(404).send("order not found");

  order.paid = true;
  order.post_id = post_id || order.post_id;
  order.amount = amount || order.amount;
  order.paid_at = new Date().toISOString();

  await db.write();

  res.send("OK");
});

// 3) Query payment
app.get("/api/check-payment", async (req, res) => {
  const { trade_no } = req.query;

  const order = db.data.orders.find((o) => o.trade_no === trade_no);
  if (!order) return res.json({ paid: false });

  if (!order.paid) return res.json({ paid: false });

  const token = issueToken(order.post_id, order.trade_no);

  res.json({
    paid: true,
    token,
    post_id: order.post_id,
  });
});

// 4) Load paid content
app.get("/api/get-post", async (req, res) => {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing token" });
  }

  const token = auth.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const postId = decoded.postId;

    const filePath = path.join(__dirname, "private_posts", `${postId}.html`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "post not found" });
    }

    const html = fs.readFileSync(filePath, "utf-8");
    res.json({ html });
  } catch (e) {
    res.status(401).json({ error: "invalid or expired token" });
  }
});

/* -------------- Admin: list orders -------------- */
app.get("/api/admin/orders", async (req, res) => {
  await db.read();
  res.json(db.data.orders.slice().reverse());
});

/* -------------- Start Server -------------- */
app.listen(PORT, () => {
  console.log(`Pay backend running on port ${PORT}`);
});
