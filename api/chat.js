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
  anthropic: { url: "https://api.anthropic.com/v1/messages", key: () => process.env.ANTHROPIC_API_KEY },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: () => process.env.GROQ_API_KEY },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: () => process.env.GEMINI_API_KEY },
};

const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CLAUDE_FAST = () => process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5";
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
  // Paid: your Anthropic API key. Falls back to the free models if credit runs out.
  claude: () => [
    { p: "anthropic", model: CLAUDE_MODEL(), label: "Claude Sonnet 5.5", budget: 300000, vision: true },
    { p: "anthropic", model: CLAUDE_FAST(), label: "Claude Haiku 5.5", budget: 300000, vision: true },
    { p: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B (free backup)", effort: "medium", budget: 22000 },
    { p: "gemini", model: GEMINI_MODEL(), label: "Gemini Flash (free backup)", budget: 200000 },
    { p: "groq", model: "openai/gpt-oss-20b", label: "GPT-OSS 20B (free backup)", effort: "medium", budget: 22000 },
  ],
  // Used automatically when the chat contains pictures
  vision: () => [
    { p: "groq", model: "qwen/qwen3.8-27b", label: "Qwen 3.8 (vision)", budget: 20000, vision: true },
    { p: "gemini", model: GEMINI_MODEL(), label: "Gemini Flash (vision)", budget: 200000, vision: true },
    { p: "gemini", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash (vision)", budget: 200000, vision: true },
    { p: "gemini", model: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (vision)", budget: 200000, vision: true },
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

  // Pictures: data URLs only, max 3 in the whole request (newest kept)
  let imgLeft = 3;
  const all = messages.slice(-40).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 200000),
    images: Array.isArray(m.images) ? m.images.filter((u) => typeof u === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(u) && u.length < 6e6) : [],
  }));
  for (let i = all.length - 1; i >= 0; i--) {
    const keep = all[i].images.slice(0, Math.max(imgLeft, 0));
    imgLeft -= keep.length;
    all[i].images = all[i].role === "user" ? keep : [];
  }
  const hasImages = all.some((m) => m.images.length);

  const today = new Date().toISOString().slice(0, 10);
  let chain = modeName === "claude"
    ? CHAINS.claude()
    : (hasImages ? CHAINS.vision : CHAINS[modeName] || CHAINS.smart)();
  // pictures: only models that can see them
  if (hasImages) chain = chain.filter((s) => s.vision).concat(modeName === "claude" ? CHAINS.vision() : []);
  chain = chain.filter((s) => PROVIDERS[s.p].key());
  if (!chain.length) return res.status(500).json({ error: "No API key set on the server." });

  let r, step, lastError = "AI error";
  try {
    for (step of chain) {
      const system = `${SYSTEM_PROMPT}\n\nToday's date is ${today}.` +
        (step.search ? "\nYou can search the web. Use it for anything recent or factual you are unsure about, and mention the sources (site names or links) at the end." : "") +
        (step.noWeb ? "\nWeb search is unavailable right now. Answer from your own knowledge and say that live info may be out of date." : "") +
        (step.vision ? "\nThe user attached picture(s). Look at them carefully: read any text, code, diagrams, tables or questions in them, and answer based on what you see." : "");

      const hist = fitHistory(all, step.budget);
      let body, headers;
      if (step.p === "anthropic") {
        // Claude's own format: system is separate, pictures are base64 blocks, roles must alternate
        const msgs = [];
        for (const m of hist) {
          const parts = [];
          for (const url of m.images) {
            const mm = url.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
            if (mm) parts.push({ type: "image", source: { type: "base64", media_type: mm[1] === "image/jpg" ? "image/jpeg" : mm[1], data: mm[2] } });
          }
          parts.push({ type: "text", text: m.content || "(empty)" });
          const prev = msgs[msgs.length - 1];
          if (prev && prev.role === m.role) prev.content.push(...parts);
          else msgs.push({ role: m.role, content: parts });
        }
        body = { model: step.model, system, messages: msgs, max_tokens: 8192, stream: true };
        headers = { "Content-Type": "application/json", "x-api-key": PROVIDERS.anthropic.key(), "anthropic-version": "2023-06-01" };
      } else {
      headers = { "Content-Type": "application/json", Authorization: `Bearer ${PROVIDERS[step.p].key()}` };
      body = {
        model: step.model,
        messages: [{ role: "system", content: system }, ...hist.map((m) =>
          m.images.length
            ? { role: m.role, content: [{ type: "text", text: m.content }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] }
            : { role: m.role, content: m.content })],
        max_completion_tokens: step.search ? 4096 : 8192,
        stream: !step.search,
      };
      if (step.effort) body.reasoning_effort = step.effort;
      if (step.model.startsWith("qwen/")) body.reasoning_format = "hidden"; // hide <think> text
      if (step.search) body.tools = [{ type: "browser_search" }];
      if (step.p === "gemini") { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
      }

      // Give up on a model that doesn't start answering in time, and try the next one
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), step.search ? 40000 : step.p === "anthropic" ? 30000 : 20000);
      try {
        r = await fetch(PROVIDERS[step.p].url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (step.search && r.ok) { r = { ok: true, _json: await r.json() }; } // web answer arrives all at once
      } catch (e) {
        lastError = e.name === "AbortError" ? `${step.label} took too long` : "Network error";
        console.log(`[chat] ${step.label}: ${lastError}`);
        r = null; clearTimeout(timer); continue;
      }
      clearTimeout(timer);

      if (r.ok) break;
      const data = await r.json().catch(() => ({}));
      const err = Array.isArray(data) ? data[0]?.error : data?.error;
      lastError = err?.message || `AI error (${r.status})`;
      console.log(`[chat] ${step.label} failed ${r.status}: ${lastError.slice(0, 200)}`);
      // any failure -> try the next model
    }

    if (!r || !r.ok) {
      const busy = /rate|limit|quota|exceeded|busy|demand|429|503/i.test(lastError);
      if (hasImages) return res.status(503).json({ error: busy ? "The picture models are busy right now. Try again in a minute." : "Could not read the picture: " + lastError });
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
      const data = r._json;
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
          const j = JSON.parse(payload);
          const t = step.p === "anthropic"
            ? (j.type === "content_block_delta" && j.delta?.type === "text_delta" ? j.delta.text : "")
            : j.choices?.[0]?.delta?.content;
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
