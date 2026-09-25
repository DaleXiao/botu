# botu

botu.openclawd.co — turn any character image into a minimal bot icon.

- Pure static frontend (zero external links) + a Cloudflare Pages Function proxying DashScope `qwen-image-3.0-pro` image-to-image generation
- Upload → canvas compression (longest edge ≤1536, JPEG q0.85) → `POST /api/generate` → ~3-4 minutes → PNG download
- Bilingual zh/en (persisted in localStorage); full SEO suite (og-image 1200×630 / JSON-LD / robots / sitemap)

## Development

```bash
node --test        # full test suite (Node ≥22; do not pass directory arguments)
wrangler pages dev # local preview (requires DASHSCOPE_API_KEY)
```

## Function contract

`POST /api/generate` `{image_base64, mime}` → `{image_base64, mime:"image/png"}`.
mime allowlist jpeg/png/webp (400); base64 ≤14M chars (413); missing key 500; upstream errors 502.
OSS signed URLs are consumed inside the worker only and never sent to the frontend.

## Deployment

Cloudflare Pages (git integration, branch `main`). Deployment prerequisite: Pages secret `DASHSCOPE_API_KEY`.
