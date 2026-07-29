# Seedance Studio

## Seedance 2.0 relay API

The server exposes a small API-key relay on `/v1`. It reuses the configured
`VIDEO_API_BASE_URL` channel, keeps upstream credentials on the server, stores
each task in PostgreSQL, and snapshots both supplier cost and the external sale
price. The external sale price is always:

```text
supplier cost × 1.8
```

Required configuration:

```env
DATABASE_URL=postgresql://...
VIDEO_API_BASE_URL=https://...
VIDEO_PROJECT_CODE=...
VIDEO_ACCESS_KEY=...
VIDEO_SECRET_KEY=...

SEEDANCE_RELAY_API_KEY=sk-seedance-change-me
SEEDANCE_RELAY_APP_ID=default
SEEDANCE_RELAY_APP_NAME=Default relay client
```

For multiple callers, use `SEEDANCE_RELAY_API_KEYS_JSON` as shown in
`.env.example`. Each caller can only query tasks and usage created by its own
key.

Create a task:

```bash
curl https://your-domain.example/v1/videos/generations \
  -H 'Authorization: Bearer sk-seedance-change-me' \
  -H 'Idempotency-Key: order-20260729-001' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "doubao-seedance-2-0-260128",
    "prompt": "A product rotates slowly on a clean studio background",
    "mode": "t2v",
    "resolution": "720p",
    "aspect_ratio": "9:16",
    "duration": 5
  }'
```

The response is `202 Accepted` and includes `id`, `poll_url`, and a billing
snapshot. Use the same API key to poll or inspect usage:

```bash
curl https://your-domain.example/v1/videos/generations/TASK_ID \
  -H 'Authorization: Bearer sk-seedance-change-me'

curl https://your-domain.example/v1/usage \
  -H 'Authorization: Bearer sk-seedance-change-me'

curl https://your-domain.example/v1/pricing \
  -H 'Authorization: Bearer sk-seedance-change-me'
```

Operators can inspect an all-key cost, sales, and gross-margin summary through
the existing admin authentication:

```bash
curl 'https://your-domain.example/api/admin/relay/overview?days=30' \
  -H 'Authorization: Bearer YOUR_ADMIN_PASSWORD'
```

Reference modes accept URL/reference strings in
`references.images`, `references.videos`, and `references.audios`. The relay
does not expose upstream access keys or upstream task ownership.

## Frontend development

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
