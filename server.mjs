import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SITE_URL = process.env.SITE_URL || "https://darko-smart-tech-store.onrender.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add the PostgreSQL Internal Database URL in Render Environment.");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is missing. Add a strong admin password in Render Environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render internal database connections normally do not require SSL.
  // Set DATABASE_SSL=true only if your database provider requires TLS.
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.use(express.static(PUBLIC_DIR));

const starterProducts = [
  { name: "Business Laptop", category: "Laptops", price: 4500, emoji: "💻", description: "Reliable everyday laptop for work and study." },
  { name: "Premium Laptop", category: "Laptops", price: 7200, emoji: "🖥️", description: "Extra performance for demanding tasks." },
  { name: "Android Smartphone", category: "Phones", price: 1850, emoji: "📱", description: "A smart everyday phone with modern features." },
  { name: "iPhone", category: "Phones", price: 6500, emoji: "📲", description: "Premium smartphone experience." },
  { name: "PlayStation Console", category: "Gaming", price: 6200, emoji: "🎮", description: "Bring home an immersive gaming experience." },
  { name: "Xbox Console", category: "Gaming", price: 5900, emoji: "🕹️", description: "Big-screen gaming and entertainment." },
  { name: "Wireless Headphones", category: "Accessories", price: 450, emoji: "🎧", description: "Enjoy music, calls and entertainment." },
  { name: "Smartwatch", category: "Accessories", price: 650, emoji: "⌚", description: "Keep useful features close at hand." }
];

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      emoji TEXT NOT NULL DEFAULT '📦',
      description TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
      order_status TEXT NOT NULL DEFAULT 'New',
      payment_status TEXT NOT NULL DEFAULT 'Unpaid',
      payment_reference TEXT UNIQUE,
      source TEXT NOT NULL DEFAULT 'WhatsApp',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM products");
  if (count.rows[0].count === 0) {
    for (const p of starterProducts) {
      await pool.query(
        "INSERT INTO products (name, category, price, emoji, description) VALUES ($1,$2,$3,$4,$5)",
        [p.name, p.category, p.price, p.emoji, p.description]
      );
    }
    console.log("Starter product catalogue added to PostgreSQL.");
  }
  console.log("PostgreSQL connected and tables are ready.");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function makeAdminToken() {
  return crypto.createHmac("sha256", ADMIN_PASSWORD).update("darko-smart-tech-admin-session").digest("hex");
}
function requireAdmin(req, res, next) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf("="); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
  if (!cookies.dst_admin || !safeEqual(cookies.dst_admin, makeAdminToken())) {
    return res.status(401).json({ error: "Please sign in to the admin dashboard." });
  }
  next();
}
function validProduct(body) {
  return body && typeof body.name === "string" && body.name.trim().length > 0 &&
    typeof body.category === "string" && body.category.trim().length > 0 &&
    Number.isFinite(Number(body.price)) && Number(body.price) >= 0 &&
    typeof (body.description ?? "") === "string" && typeof (body.emoji ?? "📦") === "string";
}

// Paystack webhook: verify the untouched request body before processing events.
app.post("/api/paystack-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return res.sendStatus(503);
  const signature = req.headers["x-paystack-signature"];
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
  if (!signature || typeof signature !== "string" || signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(401);
  try {
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success" && event.data?.reference) {
      await pool.query(
        "UPDATE orders SET payment_status='Paid', order_status=CASE WHEN order_status='New' THEN 'Processing' ELSE order_status END, updated_at=NOW() WHERE payment_reference=$1",
        [event.data.reference]
      );
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook error:", error);
    return res.sendStatus(400);
  }
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

app.use(express.json({ limit: "1mb" }));

// Public active product catalogue used by the storefront.
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, category, price, emoji, description FROM products WHERE active=TRUE ORDER BY id");
    res.json(result.rows.map(p => ({ ...p, price: Number(p.price) })));
  } catch (error) {
    console.error("Product list error:", error);
    res.status(500).json({ error: "Could not load products." });
  }
});

app.post("/api/admin/login", (req, res) => {
  const password = req.body?.password;
  if (typeof password !== "string" || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  res.setHeader("Set-Cookie", `dst_admin=${makeAdminToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "dst_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ authenticated: true }));

app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  try {
    const [products, orders, revenue, recent] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM products WHERE active=TRUE"),
      pool.query("SELECT COUNT(*)::int AS count FROM orders"),
      pool.query("SELECT COALESCE(SUM(total),0)::numeric(12,2) AS total FROM orders WHERE payment_status='Paid'"),
      pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE order_status IN ('New','Processing')")
    ]);
    res.json({ products: products.rows[0].count, orders: orders.rows[0].count, revenue: Number(revenue.rows[0].total), openOrders: recent.rows[0].count });
  } catch (error) {
    console.error("Admin summary error:", error);
    res.status(500).json({ error: "Could not load dashboard summary." });
  }
});
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(r.rows.map(p => ({ ...p, price: Number(p.price) })));
  } catch (error) { res.status(500).json({ error: "Could not load products." }); }
});
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  if (!validProduct(req.body)) return res.status(400).json({ error: "Enter a product name, category and valid price." });
  try {
    const { name, category, price, emoji = "📦", description = "" } = req.body;
    const r = await pool.query("INSERT INTO products (name,category,price,emoji,description) VALUES ($1,$2,$3,$4,$5) RETURNING *", [name.trim(), category.trim(), Number(price), emoji, description.trim()]);
    res.status(201).json({ ...r.rows[0], price: Number(r.rows[0].price) });
  } catch (error) { res.status(500).json({ error: "Could not save product." }); }
});
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  if (!validProduct(req.body)) return res.status(400).json({ error: "Enter a product name, category and valid price." });
  try {
    const { name, category, price, emoji = "📦", description = "", active = true } = req.body;
    const r = await pool.query("UPDATE products SET name=$1,category=$2,price=$3,emoji=$4,description=$5,active=$6,updated_at=NOW() WHERE id=$7 RETURNING *", [name.trim(), category.trim(), Number(price), emoji, description.trim(), Boolean(active), req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Product not found." });
    res.json({ ...r.rows[0], price: Number(r.rows[0].price) });
  } catch (error) { res.status(500).json({ error: "Could not update product." }); }
});
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Product not found." });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Could not remove product." }); }
});
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200");
    res.json(r.rows.map(o => ({ ...o, total: Number(o.total) })));
  } catch (error) { res.status(500).json({ error: "Could not load orders." }); }
});
app.patch("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const allowed = ["New", "Processing", "Completed", "Cancelled"];
  if (!allowed.includes(req.body?.order_status)) return res.status(400).json({ error: "Invalid order status." });
  try {
    const r = await pool.query("UPDATE orders SET order_status=$1,updated_at=NOW() WHERE id=$2 RETURNING *", [req.body.order_status, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Order not found." });
    res.json(r.rows[0]);
  } catch (error) { res.status(500).json({ error: "Could not update order." }); }
});

// WhatsApp checkout also records the order in PostgreSQL before opening WhatsApp.
app.post("/api/orders", async (req, res) => {
  try {
    const { items, customer_name = "", customer_phone = "", customer_email = "" } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 30) return res.status(400).json({ error: "Your cart is empty or invalid." });
    const ids = items.map(i => Number(i.id));
    if (ids.some(id => !Number.isInteger(id) || id < 1)) return res.status(400).json({ error: "Invalid product in cart." });
    const found = await pool.query("SELECT id,name,price FROM products WHERE active=TRUE AND id=ANY($1::bigint[])", [ids]);
    const byId = new Map(found.rows.map(p => [String(p.id), p]));
    let total = 0;
    const savedItems = [];
    for (const item of items) {
      const product = byId.get(String(Number(item.id)));
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: "An item in your cart is invalid." });
      const unit = Number(product.price);
      total += unit * quantity;
      savedItems.push({ id: Number(product.id), name: product.name, quantity, unit_price: unit });
    }
    const r = await pool.query("INSERT INTO orders (customer_name,customer_phone,customer_email,items,total,source) VALUES ($1,$2,$3,$4,$5,'WhatsApp') RETURNING id", [String(customer_name).slice(0,120), String(customer_phone).slice(0,40), String(customer_email).slice(0,160), JSON.stringify(savedItems), total.toFixed(2)]);
    res.status(201).json({ order_id: r.rows[0].id, total: Number(total), items: savedItems });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(500).json({ error: "Could not save your order." });
  }
});

// Paystack initialization and verification remain available.
app.post("/api/pay", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY || !SITE_URL) return res.status(503).json({ error: "Online payments are not configured yet." });
    const { email, items } = req.body || {};
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email address is required." });
    if (!Array.isArray(items) || !items.length || items.length > 30) return res.status(400).json({ error: "Your cart is empty or invalid." });
    const ids = items.map(i => Number(i.id));
    const found = await pool.query("SELECT id,name,price FROM products WHERE active=TRUE AND id=ANY($1::bigint[])", [ids]);
    const byId = new Map(found.rows.map(p => [String(p.id), p]));
    let total = 0; const orderItems = [];
    for (const item of items) {
      const p = byId.get(String(Number(item.id))); const quantity = Number(item.quantity);
      if (!p || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: "An item in your cart is invalid." });
      const unit = Number(p.price); total += unit * quantity;
      orderItems.push({ id: Number(p.id), name: p.name, quantity, unit_price: unit });
    }
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: "The order total is invalid." });
    const reference = `dst_${crypto.randomUUID().replaceAll("-", "")}`;
    await pool.query("INSERT INTO orders (customer_email,items,total,payment_status,payment_reference,source) VALUES ($1,$2,$3,'Pending',$4,'Paystack')", [email, JSON.stringify(orderItems), total.toFixed(2), reference]);
    const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, amount: String(Math.round(total * 100)), currency: "GHS", reference, callback_url: `${SITE_URL.replace(/\/$/, "")}/`, channels: ["card", "mobile_money"], metadata: { store: "Darko Smart Tech", order_items: orderItems } })
    });
    const data = await paystackResponse.json();
    if (!paystackResponse.ok || !data.status || !data.data?.authorization_url) {
      await pool.query("UPDATE orders SET payment_status='Failed',updated_at=NOW() WHERE payment_reference=$1", [reference]);
      return res.status(502).json({ error: data.message || "Payment provider could not start checkout." });
    }
    res.json({ authorization_url: data.data.authorization_url, reference });
  } catch (error) { console.error("Payment initialization error:", error); res.status(500).json({ error: "Unable to start payment." }); }
});
app.get("/api/verify", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: "Payments are not configured." });
    const reference = String(req.query.reference || "");
    if (!/^dst_[a-f0-9]{32}$/.test(reference)) return res.status(400).json({ error: "Invalid payment reference." });
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    const data = await response.json();
    if (!response.ok || !data.status) return res.status(502).json({ error: data.message || "Could not verify payment." });
    const t = data.data;
    const paid = t.status === "success" && t.currency === "GHS" && Number.isInteger(t.amount) && t.amount > 0;
    if (paid) await pool.query("UPDATE orders SET payment_status='Paid',order_status=CASE WHEN order_status='New' THEN 'Processing' ELSE order_status END,updated_at=NOW() WHERE payment_reference=$1", [reference]);
    res.json({ paid, message: paid ? "Payment verified." : `Transaction status: ${t.status || "unknown"}.` });
  } catch (error) { console.error("Payment verification error:", error); res.status(500).json({ error: "Unable to verify payment right now." }); }
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  if (!res.headersSent) res.status(500).json({ error: "An unexpected server error occurred." });
});

initializeDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`Darko Smart Tech server listening on ${PORT}`));
}).catch(error => {
  console.error("Database startup failed:", error);
  process.exit(1);
});
