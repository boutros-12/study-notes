// Vercel serverless function: /api/chat
// Keeps the API key on the server. Uses Groq (free tier, OpenAI-compatible).
//
// Modes:
//   smart -> strongest model, thinks before answering (default)
//   web   -> same model + live web search
//   fast  -> small, very fast model

const hits = new Map();        // simple per-IP rate limit (best effort)
const LIMIT = 30;              // requests per IP
const WINDOW = 60 * 1000;      // per minute

const SYSTEM_PROMPT = `You are Cedar, an expert AI assistant and senior engineer.

Strong areas:
- Agentic AI: agent loops, tool/function calling, planning (ReAct, plan-and-execute), multi-agent systems, memory, RAG, MCP (Model Context Protocol), evaluation, guardrails, and agent security (prompt injection, tool abuse, data exfiltration).
- Frameworks: LangChain, LangGraph, CrewAI, AutoGen, OpenAI Agents SDK, Claude Agent SDK, LlamaIndex, Semantic Kernel, n8n.
- Programming (Python, JavaScript/TypeScript, SQL, Bash), web development, APIs, Docker, cloud.
- Cybersecurity, networking, and IT.

How to answer:
- Be direct and practical. Start with the answer, then explain.
- Use plain, easy English. Explain jargon the first time you use it.
- Use Markdown: headings for long answers, bullet lists, tables when comparing, and fenced code blocks with the language name.
- Code must be complete and runnable: include imports, setup steps, and how to run it. No placeholders like "..." unless clearly marked.
- For agent designs, describe the loop, the tools, the state/memory, stop conditions, and failure handling. A small ASCII diagram is welcome.
- If a question is unclear, make a sensible assumption, say it in one line, and answer.
- If you are not sure about something, say so. Never invent APIs, packages, or facts.
- Match the user's language (English, Arabic, French, Lebanese Arabic).`;

const MODES = {
  smart: { models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"], effort: "medium" },
  web:   { models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], effort: "low", search: true },
  fast:  { models: ["llama-3.1-8b-instant", "openai/gpt-oss-20b"] },
};

// Remove web-search citation markers like 【2†L6-L10】
const cleanCitations = (s) => s.replace(/【[^】]*】/g, "");

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
  if (list.length >= LIMIT) return res.status(429).json({ error: "Too many messages. Wait a minute and try again." });
  list.push(now);
  hits.set(ip, list);

  const { messages, mode: modeName } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Bad request" });
  const mode = MODES[modeName] || MODES.smart;

  // Keep recent history; older messages get trimmed harder to save space
  const recent = messages.slice(-30);
  const clean = recent.map((m, i) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, i >= recent.length - 4 ? 60000 : 8000),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const system = `${SYSTEM_PROMPT}\n\nToday's date is ${today}.` +
    (mode.search ? "\nYou can search the web. Use it for anything recent or factual you are unsure about, and mention the sources (site names or links) at the end." : "");

  const models = (process.env.MODEL && !mode.search ? [process.env.MODEL] : []).concat(mode.models);

  try {
    let r, lastError = "AI error";
    for (const model of models) {
      const body = {
        model,
        messages: [{ role: "system", content: system }, ...clean],
        max_completion_tokens: mode.search ? 4096 : 8192,
        stream: !mode.search,
      };
      if (model.startsWith("openai/gpt-oss") && mode.effort) body.reasoning_effort = mode.effort;
      if (mode.search) body.tools = [{ type: "browser_search" }];

      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (r.ok) break;
      const data = await r.json().catch(() => ({}));
      lastError = data?.error?.message || "AI error";
      if (r.status === 429) { lastError = "The AI is busy (free limit reached). Try again in a minute, or switch to Fast mode."; break; }
      // Try the next model only if this one is missing, retired, or not allowed
      const modelProblem = r.status === 404 || /model|tool|not supported/i.test(lastError);
      if (!modelProblem) break;
    }
    if (!r.ok) return res.status(500).json({ error: lastError });

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });

    // Web mode: one full answer (search runs on Groq's side)
    if (mode.search) {
      const data = await r.json();
      res.write(cleanCitations(data.choices?.[0]?.message?.content || ""));
      return res.end();
    }

    // Other modes: stream text chunks to the browser
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
