// /api/sync -> saves and loads your chats so every device sees the same history.
//
// Storage: Upstash Redis (free), added in Vercel -> Storage. Vercel sets these for you:
//   KV_REST_API_URL + KV_REST_API_TOKEN   (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//
// Each person picks a private "sync code". Chats are stored under a hash of that code,
// so the code itself is never saved, and nobody without it can read the chats.
//
// GET  /api/sync            header x-sync-code -> { data: {chats, deleted} | null }
// PUT  /api/sync  {data}    header x-sync-code -> { ok: true }

import { createHash } from "crypto";

const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB per sync code

async function redis(cmd) {
  const r = await fetch(URL_(), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `storage error ${r.status}`);
  return d.result;
}

// Small brute-force protection: limit attempts per IP
const tries = new Map();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_() || !TOKEN()) return res.status(501).json({ error: "Sync is not set up yet (no database connected)." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "x";
  const now = Date.now();
  const t = (tries.get(ip) || []).filter((x) => now - x < 60000);
  if (t.length > 60) return res.status(429).json({ error: "Too many sync requests. Wait a minute." });
  t.push(now); tries.set(ip, t);

  const code = String(req.headers["x-sync-code"] || "");
  if (code.length < 6) return res.status(400).json({ error: "Sync code must be at least 6 characters." });
  const key = "chats:" + createHash("sha256").update("cedar-sync:" + code).digest("hex");

  try {
    if (req.method === "GET") {
      const raw = await redis(["GET", key]);
      return res.status(200).json({ data: raw ? JSON.parse(raw) : null });
    }

    if (req.method === "PUT") {
      const data = req.body?.data;
      if (!data || !Array.isArray(data.chats)) return res.status(400).json({ error: "Bad data" });
      const raw = JSON.stringify({ chats: data.chats, deleted: data.deleted || {} });
      if (raw.length > MAX_BYTES) return res.status(413).json({ error: "Too much chat history to sync. Delete some old chats." });
      await redis(["SET", key, raw]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "GET or PUT only" });
  } catch (e) {
    return res.status(500).json({ error: "Sync failed: " + e.message });
  }
}
