import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SITE_URL = process.env.SITE_URL;

const CATALOG = {
  1: { name: "Business Laptop", pricePesewas: 450000 },
  2: { name: "Premium Laptop", pricePesewas: 720000 },
  3: { name: "Android Smartphone", pricePesewas: 185000 },
  4: { name: "iPhone", pricePesewas: 650000 },
  5: { name: "PlayStation Console", pricePesewas: 620000 },
  6: { name: "Xbox Console", pricePesewas: 590000 },
  7: { name: "Wireless Headphones", pricePesewas: 45000 },
  8: { name: "Smartwatch", pricePesewas: 65000 }
};

app.post("/api/pay", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY || !SITE_URL) return res.status(503).json({ error: "Online payments are not configured yet. Please contact the store." });
    const { email, items } = req.body || {};
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "A valid email address is required." });
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) return res.status(400).json({ error: "Your cart is empty or invalid." });

    let amount = 0;
    const orderItems = [];
    for (const item of items) {
      const product = CATALOG[Number(item.id)];
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: "An item in your cart is invalid." });
      amount += product.pricePesewas * quantity;
      orderItems.push({ name: product.name, quantity, unit_price_pesewas: product.pricePesewas });
    }
    if (!Number.isSafeInteger(amount) || amount < 100) return res.status(400).json({ error: "The order total is invalid." });

    const reference = `dst_${crypto.randomUUID().replaceAll("-", "")}`;
    const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email, amount: String(amount), currency: "GHS", reference,
        callback_url: `${SITE_URL.replace(/\/$/, "")}/`,
        channels: ["card", "mobile_money"],
        metadata: { store: "Darko Smart Tech", order_items: orderItems }
      })
    });
    const data = await paystackResponse.json();
    if (!paystackResponse.ok || !data.status || !data.data?.authorization_url) return res.status(502).json({ error: data.message || "Payment provider could not start checkout." });
    res.json({ authorization_url: data.data.authorization_url, reference });
  } catch (error) {
    console.error("Payment initialization error:", error);
    res.status(500).json({ error: "Unable to start payment. Please try again later." });
  }
});

app.get("/api/verify", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: "Payments are not configured." });
    const reference = String(req.query.reference || "");
    if (!/^dst_[a-f0-9]{32}$/.test(reference)) return res.status(400).json({ error: "Invalid payment reference." });
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();
    if (!response.ok || !data.status) return res.status(502).json({ error: data.message || "Could not verify payment." });
    const transaction = data.data;
    const paid = transaction.status === "success" && transaction.currency === "GHS" && Number.isInteger(transaction.amount) && transaction.amount > 0;
    res.json({ paid, message: paid ? "Payment verified." : `Transaction status: ${transaction.status || "unknown"}.` });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: "Unable to verify payment right now." });
  }
});

// Configure this endpoint as the webhook URL in the Paystack dashboard.
app.post("/api/paystack-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY || "").update(req.body).digest("hex");
  if (!signature || signature !== expected) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString("utf8"));
  if (event.event === "charge.success") console.log("Paystack successful charge:", event.data.reference);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Darko Smart Tech server listening on ${PORT}`));
