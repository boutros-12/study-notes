// Vercel serverless function: /api/chat
// Keeps your API key on the server. Uses Groq (free tier, OpenAI-compatible).

const hits = new Map(); // simple per-IP rate limit (resets when the function cold-starts)
const LIMIT = 20;        // messages per IP
const WINDOW = 60 * 1000; // per minute

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Optional password lock: set SITE_PASSWORD in Vercel to enable
  const pass = process.env.SITE_PASSWORD;
  if (pass && req.headers["x-site-password"] !== pass) {
    return res.status(401).json({ error: "Wrong password" });
  }

  // Rate limit
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "x";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (list.length >= LIMIT) return res.status(429).json({ error: "Slow down, try again in a minute" });
  list.push(now);
  hits.set(ip, list);

  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: "Bad request" });

  // Keep only the last 20 messages and cap length
  const clean = messages.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 4000),
  }));

  // Try models in order; if one is retired or not allowed, use the next
  const models = (process.env.MODEL ? [process.env.MODEL] : []).concat([
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
  ]);

  try {
    let r, lastError = "AI error";
    for (const model of models) {
      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are a helpful, friendly assistant. Keep answers clear and short." },
            ...clean,
          ],
          max_tokens: 1024,
          stream: true,
        }),
      });
      if (r.ok) break;
      const data = await r.json().catch(() => ({}));
      lastError = data?.error?.message || "AI error";
      const modelProblem = r.status === 404 || /model/i.test(lastError);
      if (!modelProblem) break;
    }
    if (!r.ok) return res.status(500).json({ error: lastError });

    // Stream plain text chunks to the browser
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const t = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (t) res.write(t);
        } catch {}
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
    else res.end();
  }
}
