// Vercel serverless function: /api/chat
// Keeps API keys on the server.
//
// Providers (all OpenAI-compatible):
//   Groq   -> GROQ_API_KEY   (required)
//   Gemini -> GEMINI_API_KEY (optional free backup, used when Groq limits are hit)
//
// Modes:
//   smart -> strongest model, thinks before answering (default)
//   web   -> live web search
//   fast  -> small, very fast model
//
// If a model is busy, over its limit, retired, or the chat is too long for it,
// the next one in the list is tried automatically.

const hits = new Map();        // simple per-IP rate limit (best effort)
const LIMIT = 40;              // requests per IP
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

const PROVIDERS = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: () => process.env.GROQ_API_KEY },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: () => process.env.GEMINI_API_KEY },
};

const GEMINI_MODEL = () => process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Each step: provider, model, label shown to the user, and options.
// `budget` = max characters of chat history to send (smaller for low per-minute limits).
const CHAINS = {
  smart: () => [
    { p: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", effort: "medium", budget: 22000 },
    { p: "gemini", model: GEMINI_MODEL(), label: "Gemini Flash", budget: 200000 },
    { p: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B", effort: "medium", budget: 22000 },
    { p: "groq", model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", budget: 22000 },
  ],
  web: () => [
    { p: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B + web", effort: "low", search: true, budget: 12000 },
    { p: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B + web", effort: "low", search: true, budget: 12000 },
    { p: "gemini", model: GEMINI_MODEL(), label: "Gemini Flash (no web)", budget: 200000, noWeb: true },
    { p: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B (no web)", effort: "medium", budget: 22000, noWeb: true },
    { p: "groq", model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B (no web)", budget: 22000, noWeb: true },
  ],
  fast: () => [
    { p: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B", effort: "low", budget: 22000 },
    { p: "groq", model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", budget: 22000 },
    { p: "gemini", model: GEMINI_MODEL(), label: "Gemini Flash", budget: 200000 },
    { p: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", effort: "low", budget: 22000 },
  ],
};

// Remove web-search citation markers like 【2†L6-L10】
const cleanCitations = (s) => s.replace(/【[^】]*】/g, "");

// Keep the newest messages that fit in `budget` characters.
// The latest message is always kept (cut if it alone is too long).
function fitHistory(msgs, budget) {
  const out = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const left = budget - used;
    if (i === msgs.length - 1) {
      const content = m.content.length > left ? m.content.slice(0, left) + "\n\n[...cut: too long]" : m.content;
      out.unshift({ ...m, content }); used += content.length; continue;
    }
    if (m.content.length > left) break;
    out.unshift(m); used += m.content.length;
  }
  // history must start with a user message
  while (out.length > 1 && out[0].role !== "user") out.shift();
  return out;
}

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

  const all = messages.slice(-40).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 200000),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const chain = (CHAINS[modeName] || CHAINS.smart)().filter((s) => PROVIDERS[s.p].key());
  if (!chain.length) return res.status(500).json({ error: "No API key set on the server." });

  let r, step, lastError = "AI error";
  try {
    for (step of chain) {
      const system = `${SYSTEM_PROMPT}\n\nToday's date is ${today}.` +
        (step.search ? "\nYou can search the web. Use it for anything recent or factual you are unsure about, and mention the sources (site names or links) at the end." : "") +
        (step.noWeb ? "\nWeb search is unavailable right now. Answer from your own knowledge and say that live info may be out of date." : "");

      const body = {
        model: step.model,
        messages: [{ role: "system", content: system }, ...fitHistory(all, step.budget)],
        max_completion_tokens: step.search ? 4096 : 8192,
        stream: !step.search,
      };
      if (step.effort) body.reasoning_effort = step.effort;
      if (step.model.startsWith("qwen/")) body.reasoning_format = "hidden"; // hide <think> text
      if (step.search) body.tools = [{ type: "browser_search" }];
      if (step.p === "gemini") { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }

      try {
        r = await fetch(PROVIDERS[step.p].url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVIDERS[step.p].key()}` },
          body: JSON.stringify(body),
        });
      } catch (e) { lastError = "Network error"; r = null; continue; }

      if (r.ok) break;
      const data = await r.json().catch(() => ({}));
      const err = Array.isArray(data) ? data[0]?.error : data?.error;
      lastError = err?.message || `AI error (${r.status})`;
      console.log(`[chat] ${step.label} failed ${r.status}: ${lastError.slice(0, 200)}`);
      // any failure -> try the next model
    }

    if (!r || !r.ok) {
      const busy = /rate|limit|quota|exceeded|busy|429/i.test(lastError);
      return res.status(503).json({
        error: busy
          ? "All free AI models are at their limit right now. Wait a minute and try again (daily limits reset every 24h)."
          : lastError,
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Model": step.label,
    });

    // Web mode: one full answer (search runs on Groq's side)
    if (!body_stream(step)) {
      const data = await r.json();
      res.write(cleanCitations(data.choices?.[0]?.message?.content || ""));
      return res.end();
    }

    // Stream text chunks to the browser
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

const body_stream = (step) => !step.search;
