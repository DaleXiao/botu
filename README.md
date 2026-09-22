# botu

botu.openclawd.co — 把任意角色图变成极简 bot icon。Turn any character image into a minimal bot icon.

- 纯静态前端（零外链）+ Cloudflare Pages Function 代理 DashScope `qwen-image-3.0-pro` 图生图
- 上传 → canvas 压缩（长边 ≤1536, JPEG q0.85）→ `POST /api/generate` → ~3-4 分钟 → PNG 下载
- 双语 zh/en（localStorage 持久化）；SEO 全套（og-image 1200×630 / JSON-LD / robots / sitemap）

## 开发

```bash
node --test        # 全量测试（Node ≥22；勿传目录参数）
wrangler pages dev # 本地预览（需 DASHSCOPE_API_KEY）
```

## Function 契约

`POST /api/generate` `{image_base64, mime}` → `{image_base64, mime:"image/png"}`。
mime 白名单 jpeg/png/webp（400）；base64 ≤14M chars（413）；缺 key 500；上游异常 502。
OSS 签名 URL 仅在 worker 内消费，不下发前端。

## 部署

Cloudflare Pages（git integration, branch `main`）。部署前置：Pages secret `DASHSCOPE_API_KEY`。
