// GET /api/health -> checks each AI provider with a tiny request.
// Shows only OK / error messages, never the keys.

export default async function handler(req, res) {
  const out = {};

  async function ping(name, url, key, model) {
    if (!key) return (out[name] = "no key set");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK" }], max_tokens: 20 }),
      });
      const d = await r.json().catch(() => ({}));
      const err = Array.isArray(d) ? d[0]?.error : d?.error;
      out[name] = r.ok ? "OK" : `error ${r.status}: ${(err?.message || "").slice(0, 160)}`;
    } catch (e) {
      out[name] = "network error";
    }
  }

  await Promise.all([
    ping("groq", "https://api.groq.com/openai/v1/chat/completions", process.env.GROQ_API_KEY, "openai/gpt-oss-20b"),
    ping("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-3.8-flash"),
  ]);

  // Which chat models this Groq key can use
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } });
    const d = await r.json();
    out.groq_models = (d.data || []).map((m) => m.id).filter((id) => !/whisper|tts|orpheus|guard/i.test(id)).sort();
  } catch {}

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
