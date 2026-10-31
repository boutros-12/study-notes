# AI Chat — deploy in 5 minutes

## 1. Get a free API key
Go to https://console.groq.com/keys → Create key → copy it.

## 2. Put the code on GitHub
Create a new repo, upload all these files (keep the `api` and `public` folders).

## 3. Deploy on Vercel
1. vercel.com → Add New → Project → import your repo → Deploy.
2. Project → Settings → Environment Variables, add:
   - `GROQ_API_KEY` = your key  (required)
   - `SITE_PASSWORD` = any password  (optional, locks the site)
   - `MODEL` = another Groq model name  (optional)
3. Deployments → Redeploy. Done: `yourname.vercel.app`

## 4. Backup links (if one gets blocked)
- Netlify / Cloudflare Pages work too, but they need small changes to the `api` folder.
- Better: buy a cheap domain and add it in Vercel → Settings → Domains.
  You can add several domains to the same project.

## Safety
- Set a spending limit in your Groq dashboard.
- Built-in limit: 20 messages per minute per person (edit in `api/chat.js`).
- Never put your API key in `index.html`.
