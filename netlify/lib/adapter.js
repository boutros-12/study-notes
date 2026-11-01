// Lets the same /api code (written for Vercel) run as Netlify Edge Functions.
// It turns a web Request into the small req/res objects the handlers expect.

export function adapt(handler) {
  return async (request) => {
    // Make process.env available (Netlify Edge runs on Deno)
    try {
      const env = globalThis.Netlify?.env?.toObject?.() || {};
      if (!globalThis.process) globalThis.process = { env: {} };
      if (!globalThis.process.env) globalThis.process.env = {};
      for (const [k, v] of Object.entries(env)) {
        if (globalThis.process.env[k] !== v) {
          try { globalThis.process.env[k] = v; } catch {}
        }
      }
    } catch {}

    const headers = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    if (!headers["x-forwarded-for"]) headers["x-forwarded-for"] = headers["x-nf-client-connection-ip"] || "";

    let body;
    if (request.method === "POST" || request.method === "PUT") {
      try { body = await request.json(); } catch { body = {}; }
    }

    return new Promise((resolve) => {
      let status = 200, done = false, writer = null;
      const out = new Headers();
      const enc = new TextEncoder();
      const finish = (resp) => { if (!done) { done = true; res.headersSent = true; resolve(resp); } };

      const res = {
        headersSent: false,
        setHeader(k, v) { out.set(k, v); },
        status(c) { status = c; return res; },
        json(b) { out.set("Content-Type", "application/json"); finish(new Response(JSON.stringify(b), { status, headers: out })); },
        writeHead(s, h = {}) {
          status = s;
          for (const k in h) out.set(k, h[k]);
          const ts = new TransformStream();
          writer = ts.writable.getWriter();
          finish(new Response(ts.readable, { status, headers: out }));
        },
        write(t) { writer?.write(enc.encode(t)).catch(() => {}); },
        end() { if (writer) writer.close().catch(() => {}); else finish(new Response(null, { status, headers: out })); },
      };

      Promise.resolve()
        .then(() => handler({ method: request.method, headers, body }, res))
        .catch(() => { if (!done) finish(new Response(JSON.stringify({ error: "Server error" }), { status: 500 })); else writer?.close().catch(() => {}); })
        .finally(() => { if (!done) finish(new Response(null, { status: 204 })); });
    });
  };
}
