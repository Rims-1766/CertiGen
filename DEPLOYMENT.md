# CertiGen Zero-Cost Deployment Guide

This app needs a Node.js server and a database. GitHub Pages alone cannot run it because Pages only serves static files.

No provider can guarantee that a free plan will stay unchanged forever. This guide uses providers whose current official free tiers can run the app at zero monthly cost if you stay within their limits.

## Recommended Stack

- Code repository: GitHub
- Web app: Koyeb free web service
- Database: Neon Free Postgres

Koyeb serves the files in `frontend/` through `backend/server.js`, so you do not need GitHub Pages for the main app.

## 1. Push The Updated Repo

Push these deployment-ready changes to GitHub:

- `backend/server.js`
- `backend/package.json`
- `backend/package-lock.json`
- `Dockerfile`
- `.dockerignore`
- `DEPLOYMENT.md`
- `frontend/templates/`
- `frontend/index.html`
- `frontend/admin.html`
- `frontend/employee-dashboard.html`
- `frontend/verify.html`
- `frontend/style.css`
- `frontend/styles.css`

Do not commit `.env`, `backend/admin.local.json`, `backend/uploads/`, `backend/uploaded_templates/`, `backend/certificates/`, `backend/node_modules/`, or `Information.txt`.

## 2. Create A Free Neon Database

1. Create a Neon account.
2. Create a Free project.
3. Copy the pooled or normal Postgres connection string.

It looks like this:

```text
postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

You do not need to run SQL manually on a fresh Neon database. The app creates the required tables on startup.

## 3. Deploy The App On Koyeb

1. Create a Koyeb account.
2. Create a new Web Service from your GitHub repository.
3. Choose the free instance.
4. Use the Dockerfile deployment option if Koyeb asks how to build the app.
5. Set the service port to `3000` if it is not detected automatically.

The Dockerfile installs dependencies from `backend/package-lock.json` and starts `backend/server.js`.

Set these environment variables:

```text
NODE_ENV=production
HOST=0.0.0.0
TRUST_PROXY=true
DB_CLIENT=postgres
DB_SSL=true
DATABASE_URL=your Neon Postgres connection string
PUBLIC_BASE_URL=https://your-koyeb-app-url
ADMIN_NAME=Your Name
ADMIN_EMAIL=your-admin-email@example.com
ADMIN_PASSWORD=use-a-strong-password
ADMIN_PHONE=your phone number
CREATE_DEMO_EMPLOYEE=false
DATA_DIR=/tmp/certigen
```

Optional email variables:

```text
EMAIL_USER=your Gmail address
EMAIL_PASS=your Gmail app password
```

The app health endpoint is:

```text
/healthz
```

After Koyeb gives you the final app URL, update `PUBLIC_BASE_URL` to that exact URL. This keeps QR verification links correct.

Note: Koyeb documents that the free web service itself is not charged, but it may ask for card validation to prevent abuse. If you want to avoid adding a card entirely, use the Render alternative below with Neon.

## Render Alternative

Render can also host the Node web service for free, and `render.yaml` is included for that path. Do not use Render Free Postgres if you need permanent free storage because Render documents that free Postgres databases expire after 30 days.

For Render + Neon, use the same env vars above and set:

```text
PUBLIC_BASE_URL=https://your-render-service-name.onrender.com
```

## Important Free-Tier Notes

- Certificate records persist in Neon Postgres.
- Generated ZIP files and uploaded templates are stored in `DATA_DIR`.
- On free web hosts, local files can disappear when the service restarts or redeploys.
- For a serious production version, generated PDFs/templates should move to permanent object storage. That part is usually not permanently free at meaningful scale.
- Free tiers are best for demos, portfolios, and low-traffic projects.

## Security Notes

- Do not use demo credentials on a public deployment.
- New passwords are stored as hashes.
- Existing plain-text passwords still work once and are upgraded to hashes after login.
- Use a strong `ADMIN_PASSWORD` in the host environment variables.
