# CertiGen

CertiGen is a Node.js + Express project for bulk certificate generation, ZIP download, email notification, employee/admin dashboards, and QR-based certificate verification.

## Project Structure

```text
CertiGen/
|-- backend/
|   |-- server.js
|   |-- package.json
|   |-- package-lock.json
|   |-- certigen.sql
|   |-- .env.example
|   |-- admin.local.example.json
|   |-- certificates/
|   |-- uploads/
|   `-- uploaded_templates/
|
|-- frontend/
|   |-- index.html
|   |-- admin.html
|   |-- employee-dashboard.html
|   |-- verify.html
|   |-- login.backup.html
|   |-- style.css
|   |-- styles.css
|   |-- image1.jpeg
|   |-- ParticipantList.xlsx
|   `-- templates/
|
|-- docs/
|   |-- Certi-Gen-APIs.txt
|   |-- Certi-Gen-Functions.txt
|   |-- Certi-Gen-Modules.txt
|   `-- System Architecture.txt
|
|-- Dockerfile
|-- DEPLOYMENT.md
|-- render.yaml
`-- README.md
```

## Features

- Bulk certificate generation
- ZIP download support
- Email notifications after certificate generation
- Admin and employee dashboards
- QR-based certificate verification
- MySQL support for local setup
- PostgreSQL support for free hosted deployment
- Docker deployment support

## Prerequisites

Install these first:

- Node.js 18+ or newer
- MySQL 8+ or compatible for local setup

For free hosted deployment, the app also supports PostgreSQL providers such as Neon.

## Setup

1. Go to the backend folder:

```powershell
cd backend
```

2. Install dependencies:

```powershell
npm install
```

3. Create the local MySQL database and tables:

```sql
SOURCE certigen.sql;
```

If your MySQL client does not support `SOURCE`, open `backend/certigen.sql` and run it manually.

The app also creates the required tables automatically when it starts, which is useful for hosted databases.

4. Set environment variables before starting the server.

PowerShell example for local MySQL:

```powershell
$env:PORT="3000"
$env:DB_CLIENT="mysql"
$env:DB_HOST="localhost"
$env:DB_PORT="3306"
$env:DB_NAME="certigen"
$env:DB_USER="root"
$env:DB_PASSWORD="your_mysql_password"
$env:EMAIL_USER="your_gmail_address"
$env:EMAIL_PASS="your_gmail_app_password"
node server.js
```

You can leave `EMAIL_USER` and `EMAIL_PASS` empty if you do not want email sending yet.

5. If your database details are already configured and you only want to enable email generation, run from `backend/`:

```powershell
$env:EMAIL_USER="your_gmail_address"
$env:EMAIL_PASS="your_gmail_app_password"
node server.js
```

Use a Gmail app password for `EMAIL_PASS`, not your normal Gmail password.

6. If you do not have separate admin database details and are using the default local MySQL setup, run from `backend/`:

```powershell
$env:DB_HOST="localhost"
$env:DB_PORT="3306"
$env:DB_NAME="certigen"
$env:DB_USER="root"
$env:DB_PASSWORD="password"
$env:EMAIL_USER="your_gmail_address"
$env:EMAIL_PASS="your_gmail_app_password"
node server.js
```

These email variables are important for sending certificate generation notifications.

7. Open the app:

```text
http://localhost:3000
```

Do not use VS Code Live Server as the main app URL unless the backend is also running with `node server.js`.

## Default Demo Accounts

These accounts are created by `backend/certigen.sql` and by the server during local startup:

- Admin:
  - Email: `admin@certigen.local`
  - Password: `admin123`
- Employee:
  - Email: `employee@certigen.local`
  - Password: `employee123`

For public deployment, set your own `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.

## GitHub Notes

These folders and files are intentionally ignored because they are generated locally, contain dependencies, or may contain secrets:

- `backend/node_modules/`
- `backend/uploads/`
- `backend/uploaded_templates/`
- `backend/certificates/`
- `.env`
- `.env.local`
- `backend/.env`
- `backend/.env.local`
- `backend/admin.local.json`
- `Information.txt`
- `*.log`

The folder structure for `backend/uploads/`, `backend/uploaded_templates/`, and `backend/certificates/` is preserved with `.gitkeep` files.

`Information.txt`, `.env`, and `backend/admin.local.json` should never be pushed to GitHub because they may contain private details or secrets.

## Run Commands

Run these from the `backend/` folder.

Start the app:

```powershell
npm start
```

Development start command:

```powershell
npm run dev
```

Current test command:

```powershell
npm test
```

## Deployment

This app needs a Node.js server and a database. GitHub Pages can only host static files, so deploy the full app as a Node web service.

See `DEPLOYMENT.md` for a zero-cost deployment path using Koyeb for the web service and Neon Postgres for the database. `render.yaml` is included as an alternate Render deployment configuration.

## Important Note

New passwords are stored as hashes. Existing plain-text passwords still work once and are upgraded to hashes after a successful login.
