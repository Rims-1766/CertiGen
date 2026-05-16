require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const mysql = require('mysql2/promise');
const { Pool: PgPool } = require('pg');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const archiver = require('archiver');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const FRONTEND_DIR = path.join(ROOT, '..', 'frontend');
const DATA_DIR = process.env.DATA_DIR || ROOT;
const DIRS = {
    templates: path.join(FRONTEND_DIR, 'templates'),
    uploaded: path.join(DATA_DIR, 'uploaded_templates'),
    uploads: path.join(DATA_DIR, 'uploads'),
    certificates: path.join(DATA_DIR, 'certificates')
};
const LOCAL_ADMIN_FILE = path.join(ROOT, 'admin.local.json');

Object.values(DIRS).forEach(dir => fs.mkdirSync(dir, { recursive: true }));

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
        res.set('Cache-Control', 'no-store');
    }
    next();
});
app.use('/templates', express.static(DIRS.templates));
app.use('/uploaded_templates', express.static(DIRS.uploaded));
app.use('/certificates', express.static(DIRS.certificates));
app.use(express.static(FRONTEND_DIR));
app.get('/', (_, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
app.get('/login.html', (_, res) => res.redirect('/index.html'));

const DB_CLIENT = (process.env.DB_CLIENT || (process.env.DATABASE_URL || '').split(':')[0] || 'mysql').toLowerCase();
const isPostgres = ['postgres', 'postgresql'].includes(DB_CLIENT);

function toPostgresQuery(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
}

// These values let the app run locally or on a hosted database without editing code.
function createDb() {
    const sslEnabled = process.env.DB_SSL === 'true' || process.env.MYSQL_SSL === 'true' || isPostgres;

    if (isPostgres) {
        const pool = new PgPool({
            connectionString: process.env.DATABASE_URL,
            ssl: sslEnabled ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
            max: Number(process.env.DB_CONNECTION_LIMIT) || 10
        });

        return {
            query: async (sql, params = []) => {
                const result = await pool.query(toPostgresQuery(sql), params);
                return [result.rows];
            }
        };
    }

    const common = {
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
        ssl: sslEnabled ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
    };

    const pool = process.env.DATABASE_URL
        ? mysql.createPool({ uri: process.env.DATABASE_URL, ...common })
        : mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD ?? '',
            database: process.env.DB_NAME || 'certigen',
            port: Number(process.env.DB_PORT) || 3306,
            ...common
        });

    return { query: (sql, params = []) => pool.query(sql, params) };
}

const db = createDb();

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const transporter = EMAIL_USER && EMAIL_PASS
    ? nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } })
    : null;

const hashPassword = password => {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
    return `pbkdf2$${salt}$${derived}`;
};

const verifyPassword = (password, storedPassword) => {
    const stored = String(storedPassword || '');
    if (!stored.startsWith('pbkdf2$')) return String(password) === stored;
    const [, salt, expected] = stored.split('$');
    if (!salt || !expected) return false;
    const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));
};

// This creates the required tables when a hosted database starts empty.
async function ensureSchema() {
    if (isPostgres) {
        await db.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(150) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                phone VARCHAR(30),
                role VARCHAR(30) DEFAULT 'employee'
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS certificates (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                reg_no VARCHAR(100) NOT NULL UNIQUE,
                course_name VARCHAR(150) NOT NULL,
                course_type VARCHAR(80) NOT NULL,
                score VARCHAR(30) NOT NULL,
                passing_marks VARCHAR(30),
                total_marks VARCHAR(30),
                start_date DATE NOT NULL,
                end_date DATE NOT NULL,
                email VARCHAR(150),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        try { await db.query('ALTER TABLE employees ALTER COLUMN password TYPE VARCHAR(255)'); } catch (_) { /* already correct type */ }

        // Auto-migrate: add new columns to existing databases that predate these additions.
        const pgMigrations = [
            "ALTER TABLE certificates ADD COLUMN IF NOT EXISTS email VARCHAR(150)",
            "ALTER TABLE certificates ADD COLUMN IF NOT EXISTS passing_marks VARCHAR(30)",
            "ALTER TABLE certificates ADD COLUMN IF NOT EXISTS total_marks VARCHAR(30)"
        ];
        for (const sql of pgMigrations) {
            try { await db.query(sql); } catch (_) { /* skip */ }
        }
        return;
    }

    await db.query(`
        CREATE TABLE IF NOT EXISTS employees (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(150) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            phone VARCHAR(30),
            role VARCHAR(30) DEFAULT 'employee'
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS certificates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            reg_no VARCHAR(100) NOT NULL UNIQUE,
            course_name VARCHAR(150) NOT NULL,
            course_type VARCHAR(80) NOT NULL,
            score VARCHAR(30) NOT NULL,
            passing_marks VARCHAR(30),
            total_marks VARCHAR(30),
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            email VARCHAR(150),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    try { await db.query('ALTER TABLE employees MODIFY password VARCHAR(255) NOT NULL'); } catch (_) { /* already correct type */ }

    // Auto-migrate: add new columns to existing databases that predate these additions.
    const migrations = [
        "ALTER TABLE certificates ADD COLUMN email VARCHAR(150)",
        "ALTER TABLE certificates ADD COLUMN passing_marks VARCHAR(30)",
        "ALTER TABLE certificates ADD COLUMN total_marks VARCHAR(30)"
    ];
    for (const sql of migrations) {
        try { await db.query(sql); } catch (_) { /* column already exists, skip */ }
    }
}

async function upsertEmployee({ name, email, password, phone, role }) {
    if (isPostgres) {
        await db.query(
            `INSERT INTO employees (name, email, password, phone, role)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (email) DO UPDATE SET
             name = EXCLUDED.name,
             password = EXCLUDED.password,
             phone = EXCLUDED.phone,
             role = EXCLUDED.role`,
            [name, email, password, phone, role]
        );
        return;
    }

    await db.query(
        `INSERT INTO employees (name, email, password, phone, role)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         password = VALUES(password),
         phone = VALUES(phone),
         role = VALUES(role)`,
        [name, email, password, phone, role]
    );
}

async function upsertCertificate(student) {
    if (isPostgres) {
        await db.query(
            `INSERT INTO certificates (name, reg_no, course_name, course_type, score, passing_marks, total_marks, start_date, end_date, email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (reg_no) DO UPDATE SET
             name = EXCLUDED.name,
             course_name = EXCLUDED.course_name,
             course_type = EXCLUDED.course_type,
             score = EXCLUDED.score,
             passing_marks = EXCLUDED.passing_marks,
             total_marks = EXCLUDED.total_marks,
             start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date,
             email = EXCLUDED.email`,
            [student.name, student.reg_no, student.course_name, student.course_type, student.score, student.passing_marks || null, student.total_marks || null, student.start_date, student.end_date, student.email || null]
        );
        return;
    }

    await db.query(
        `INSERT INTO certificates (name, reg_no, course_name, course_type, score, passing_marks, total_marks, start_date, end_date, email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name=VALUES(name), course_name=VALUES(course_name), course_type=VALUES(course_type), score=VALUES(score), passing_marks=VALUES(passing_marks), total_marks=VALUES(total_marks), start_date=VALUES(start_date), end_date=VALUES(end_date), email=VALUES(email)`,
        [student.name, student.reg_no, student.course_name, student.course_type, student.score, student.passing_marks || null, student.total_marks || null, student.start_date, student.end_date, student.email || null]
    );
}

// This reads the real admin details from env vars or an ignored local file.
function loadLocalAdmin() {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        return {
            name: String(process.env.ADMIN_NAME || 'Admin User').trim(),
            email: String(process.env.ADMIN_EMAIL).trim(),
            password: String(process.env.ADMIN_PASSWORD).trim(),
            phone: String(process.env.ADMIN_PHONE || '').trim(),
            role: 'admin'
        };
    }

    try {
        if (!fs.existsSync(LOCAL_ADMIN_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(LOCAL_ADMIN_FILE, 'utf8'));
        if (!raw?.email || !raw?.password) return null;
        return {
            name: String(raw.name || 'Local Admin').trim(),
            email: String(raw.email).trim(),
            password: String(raw.password).trim(),
            phone: String(raw.phone || '').trim(),
            role: 'admin'
        };
    } catch (error) {
        console.warn('Local admin file could not be read:', error.message);
        return null;
    }
}

// This creates default login accounts so a fresh setup can sign in right away.
async function ensureDefaultUsers() {
    try {
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@certigen.local';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        const employeeEmail = process.env.DEMO_EMPLOYEE_EMAIL || 'employee@certigen.local';
        const employeePassword = process.env.DEMO_EMPLOYEE_PASSWORD || 'employee123';

        await upsertEmployee({
            name: process.env.ADMIN_NAME || 'Admin User',
            email: adminEmail,
            password: hashPassword(adminPassword),
            phone: process.env.ADMIN_PHONE || '0000000000',
            role: 'admin'
        });

        if (process.env.CREATE_DEMO_EMPLOYEE !== 'false') {
            await upsertEmployee({
                name: 'Employee User',
                email: employeeEmail,
                password: hashPassword(employeePassword),
                phone: '1111111111',
                role: 'employee'
            });
        }

        const localAdmin = loadLocalAdmin();
        if (localAdmin) {
            await upsertEmployee({
                name: localAdmin.name,
                email: localAdmin.email,
                password: hashPassword(localAdmin.password),
                phone: localAdmin.phone,
                role: localAdmin.role
            });
        }
    } catch (error) {
        console.warn('Default user setup skipped:', error.message);
    }
}

async function upgradePlainPassword(email, password) {
    await db.query('UPDATE employees SET password=? WHERE email=?', [hashPassword(password), email]);
}

const excelUpload = multer({ dest: DIRS.uploads });
const templateUpload = multer({
    storage: multer.diskStorage({
        destination: (_, __, cb) => cb(null, DIRS.uploaded),
        filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    })
});

let selectedTemplate = { name: 'template1.jpg', source: 'built_in', path: path.join(DIRS.templates, 'template1.jpg') };
let uploadedStudents = [];
let uploadSummary = { totalRows: 0, validRows: 0, invalidRows: 0, courseNames: [], invalidParticipants: [] };
let lastGeneration = null;

// This makes column names easier to match from different Excel files.
const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// This keeps PDF file names safe for Windows folders.
const safeName = value => String(value || 'certificate').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'certificate';

// This finds the local network IP so QR links can work on other devices too.
function getLanIp() {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return null;
}

// This builds the base URL used inside QR verification links.
function baseUrl(req) {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
    const host = req.get('host') || `localhost:${PORT}`;
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        const lanIp = getLanIp();
        if (lanIp) return `${req.protocol}://${lanIp}:${PORT}`;
    }
    return `${req.protocol}://${host}`;
}

// This turns different date formats into one simple YYYY-MM-DD format.
const formatDate = value => {
    if (value === undefined || value === null || value === '') return '';
    if (value instanceof Date && !Number.isNaN(value)) return value.toISOString().split('T')[0];
    if (typeof value === 'number') return new Date((value - 25569) * 86400 * 1000).toISOString().split('T')[0];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value).trim() : parsed.toISOString().split('T')[0];
};

// This picks the first filled value from a list of possible column names.
const pick = (row, keys) => keys.map(key => row[key]).find(v => v !== undefined && v !== null && String(v).trim() !== '') || '';

// This helps show why a participant did not get a certificate.
// When the Excel sheet has a passing_marks column, that value is used per-row.
// If passing_marks is absent, the fallback threshold of 35 is used.
function invalidReason(student) {
    const requiredCore = ['name', 'reg_no', 'course_name', 'start_date', 'end_date', 'score', 'email', 'course_type'];
    const missingFields = requiredCore
        .filter(key => !String(student[key] || '').trim())
        .map(key => key.replace(/_/g, ' '));

    if (missingFields.length) {
        return `Missing: ${missingFields.join(', ')}`;
    }

    const scoreValue = Number(student.score);
    if (Number.isNaN(scoreValue)) return 'Score is not a valid number';

    const passingValue = Number(student.passing_marks);
    if (student.passing_marks && !Number.isNaN(passingValue)) {
        if (scoreValue < passingValue) {
            const outOf = student.total_marks ? ` out of ${student.total_marks}` : '';
            return `Score ${student.score} is below the passing mark of ${student.passing_marks}${outOf}`;
        }
    } else {
        if (scoreValue <= 35) return 'Score is 35 or below (default passing threshold)';
    }

    return 'Participant is not eligible';
}

// This combines built-in and uploaded templates for the UI.
const templateList = () => [
    ...fs.readdirSync(DIRS.templates).filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => ({
        name, source: 'built_in', url: `/templates/${encodeURIComponent(name)}`, selected: selectedTemplate.name === name && selectedTemplate.source === 'built_in'
    })),
    ...fs.readdirSync(DIRS.uploaded).filter(f => /\.(png|jpe?g)$/i.test(f)).sort((a, b) => b.localeCompare(a)).map(name => ({
        name, source: 'uploaded', url: `/uploaded_templates/${encodeURIComponent(name)}`, selected: selectedTemplate.name === name && selectedTemplate.source === 'uploaded'
    }))
];

// This reads Excel rows and keeps only students with complete valid details.
// Eligibility uses passing_marks from the row when present; falls back to score > 35.
function mapStudents(rows) {
    const validRows = [];
    const courseNames = new Set();
    const invalidParticipants = [];
    let invalidRows = 0;

    rows.forEach((raw, index) => {
        const row = {};
        Object.entries(raw).forEach(([key, value]) => { row[normalize(key)] = value; });

        // Read the optional passing_marks and total_marks columns — they may not exist in every sheet.
        const rawPassing = String(pick(row, ['passing_marks', 'pass_marks', 'minimum_marks', 'min_marks', 'passing_score', 'pass_score'])).trim();
        const rawTotal   = String(pick(row, ['total_marks', 'maximum_marks', 'max_marks', 'total_score', 'out_of'])).trim();

        const student = {
            name:         String(pick(row, ['name_of_candidate', 'candidate_name', 'student_name', 'name'])).trim(),
            reg_no:       String(pick(row, ['id_number', 'reg_number', 'registration_number', 'reg_no', 'id_no', 'id'])).trim(),
            course_name:  String(pick(row, ['name_of_course', 'course_name', 'course'])).trim(),
            start_date:   formatDate(pick(row, ['starting_date_of_the_course', 'start_date', 'course_start_date', 'starting_date'])),
            end_date:     formatDate(pick(row, ['ending_date_of_the_course', 'end_date', 'course_end_date', 'ending_date'])),
            score:        String(pick(row, ['score_of_the_candidate_in_the_course', 'score_achieved', 'score', 'marks'])).trim(),
            email:        String(pick(row, ['email_of_the_participants', 'participant_email', 'email'])).trim(),
            course_type:  String(pick(row, ['course_type_online_offline', 'course_type', 'type_of_course'])).trim(),
            passing_marks: rawPassing,
            total_marks:   rawTotal
        };

        const scoreValue   = Number(student.score);
        const passingValue = Number(student.passing_marks);

        // Check required core fields (passing_marks and total_marks are optional).
        const requiredCore = ['name', 'reg_no', 'course_name', 'start_date', 'end_date', 'score', 'email', 'course_type'];
        const hasRequiredFields = requiredCore.every(key => Boolean(String(student[key] || '').trim()));

        // Determine eligibility: use the row's passing_marks if provided, otherwise fall back to > 35.
        let isEligible = false;
        if (hasRequiredFields && !Number.isNaN(scoreValue)) {
            if (student.passing_marks && !Number.isNaN(passingValue)) {
                isEligible = scoreValue >= passingValue;
            } else {
                isEligible = scoreValue > 35;
            }
        }

        if (isEligible) {
            validRows.push(student);
            courseNames.add(student.course_name);
        } else {
            invalidRows += 1;
            invalidParticipants.push({
                rowNumber:    index + 2,
                name:         student.name         || 'No name',
                reg_no:       student.reg_no        || 'No registration number',
                course_name:  student.course_name   || 'No course',
                email:        student.email         || 'No email',
                score:        student.score         || 'No score',
                passing_marks: student.passing_marks || '',
                total_marks:  student.total_marks   || '',
                course_type:  student.course_type   || 'No course type',
                reason:       invalidReason(student)
            });
        }
    });

    return {
        students: validRows,
        summary: {
            totalRows: rows.length,
            validRows: validRows.length,
            invalidRows,
            courseNames: [...courseNames],
            invalidParticipants
        }
    };
}

// This sends a mail update after certificates are generated.
async function sendGenerationMail({ employeeEmail, zipName, zipPath, zipUrl, generatedCount, invalidParticipants }) {
    if (!transporter) return { sent: false, reason: 'Email is not configured on the server.' };
    try {
        const [admins] = await db.query(
            "SELECT id, name, email, phone, role FROM employees WHERE role='admin' ORDER BY id DESC LIMIT 1"
        );
        const [employeeRows] = employeeEmail
            ? await db.query('SELECT id,name,email,phone,role FROM employees WHERE email=? LIMIT 1', [employeeEmail])
            : [[]];
        const employee = employeeRows[0] || null;
        const latestAdmin = admins[0] || null;
        const recipients = [latestAdmin?.email].filter(Boolean);
        if (!recipients.length) return { sent: false, reason: 'No admin email address was found.' };

        const invalidLines = (invalidParticipants || []).length
            ? invalidParticipants.map(person => {
                const passingInfo = person.passing_marks
                    ? ` | Passing Marks: ${person.passing_marks}${person.total_marks ? ` / ${person.total_marks}` : ''}`
                    : '';
                return `Row ${person.rowNumber}: ${person.name} | Reg No: ${person.reg_no} | Course: ${person.course_name} | Email: ${person.email} | Score: ${person.score}${passingInfo} | Reason: ${person.reason}`;
            }).join('\n')
            : 'No ineligible participants in this upload.';

        await transporter.sendMail({
            from: EMAIL_USER,
            to: recipients.join(','),
            subject: 'Certificates generated successfully',
            text: [
                'Certificate generation summary',
                '',
                `ZIP file: ${zipName}`,
                `ZIP download: ${zipUrl}`,
                `Certificates created: ${generatedCount}`,
                `Ineligible participants: ${(invalidParticipants || []).length}`,
                `Template used: ${selectedTemplate.name}`,
                '',
                'Latest admin details',
                `Name: ${latestAdmin?.name || 'Unknown admin'}`,
                `Email: ${latestAdmin?.email || 'Not available'}`,
                `Phone: ${latestAdmin?.phone || 'Not available'}`,
                '',
                'Employee details',
                `Name: ${employee?.name || 'Unknown employee'}`,
                `Email: ${employee?.email || employeeEmail || 'Not provided'}`,
                `Phone: ${employee?.phone || 'Not available'}`,
                `Role: ${employee?.role || 'employee'}`,
                '',
                'Ineligible participant details',
                invalidLines
            ].join('\n'),
            attachments: [{
                filename: zipName,
                path: zipPath
            }]
        });
        return { sent: true, reason: `Email sent to: ${recipients.join(', ')}` };
    } catch {
        console.warn('Email notification skipped.');
        return { sent: false, reason: 'Email sending failed. Check EMAIL_USER, EMAIL_PASS, and Gmail app password.' };
    }
}

// This draws one full certificate page and adds a QR code for verification.
function drawCertificate(doc, student, verifyUrl) {
    const w = doc.page.width;
    const h = doc.page.height;
    const cardW = 520;
    const x = (w - cardW) / 2;
    const detailW = 360;
    const detailX = (w - detailW) / 2;
    doc.image(selectedTemplate.path, 0, 0, { width: w, height: doc.page.height });
    doc.save();
    doc.roundedRect(x - 28, 56, cardW + 56, 306, 22).fillOpacity(0.82).fill('#fffdf8');
    doc.roundedRect(detailX - 24, 380, detailW + 48, 116, 18).fillOpacity(0.76).fill('#fffdf8');
    doc.restore();
    doc.fillColor('#13284b').font('Times-Bold').fontSize(18).text('CERTIFICATE', x, 76, { width: cardW, align: 'center' });
    doc.font('Times-Bold').fontSize(34).text('Of Completion', x, 104, { width: cardW, align: 'center' });
    doc.fillColor('#536685').font('Helvetica-Oblique').fontSize(15).text('We hereby proudly announce that', x, 164, { width: cardW, align: 'center' });
    doc.fillColor('#0d1e39').font('Times-Bold').fontSize(30).text(student.name, x, 208, { width: cardW, align: 'center', underline: true });
    doc.fillColor('#536685').font('Helvetica').fontSize(16).text('has successfully completed the course of', x, 262, { width: cardW, align: 'center' });
    doc.fillColor('#13284b').font('Times-Roman').fontSize(25).text(student.course_name, x, 302, { width: cardW, align: 'center' });
    doc.fillColor('#20385f').font('Helvetica-Bold').fontSize(14).text(`Course Type: ${student.course_type}`, detailX, 396, { width: detailW, align: 'center' });
    doc.font('Helvetica').fontSize(13).text(`Start Date: ${student.start_date}`, detailX, 426, { width: detailW, align: 'center' });
    doc.text(`End Date: ${student.end_date}`, detailX, 452, { width: detailW, align: 'center' });
    doc.text(`Score Achieved: ${student.score}`, detailX, 478, { width: detailW, align: 'center' });
    doc.strokeColor('#7f93bc').lineWidth(1);
    [[90, 230], [336, 506], [620, 760]].forEach(([a, b]) => doc.moveTo(a, h - 78).lineTo(b, h - 78).stroke());
    doc.fillColor('#223a62').font('Helvetica-Bold').fontSize(12).text('Authorized Sign', 100, 542);
    doc.text(`Reg. No: ${student.reg_no}`, 340, 542, { width: 170, align: 'center' });
    doc.text('QR Verification', 620, 542, { width: 140, align: 'center' });
    return QRCode.toBuffer(verifyUrl, { margin: 1, width: 120 }).then(qr => doc.image(qr, 646, 394, { width: 88 }));
}

// This checks login details and sends back the employee role.
app.post('/login', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id,name,email,password,role FROM employees WHERE email=? LIMIT 1', [req.body.email]);
        const user = rows[0];
        if (!user || !verifyPassword(req.body.password, user.password)) return res.json({ success: false });
        if (!String(user.password || '').startsWith('pbkdf2$')) await upgradePlainPassword(user.email, req.body.password);
        const { password: _password, ...employee } = user;
        res.json({ success: true, role: employee.role || 'employee', employee });
    } catch {
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

app.get('/healthz', async (_, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true });
    } catch {
        res.status(503).json({ ok: false });
    }
});

// This gives the frontend the full template list.
app.get('/templates-list', (_, res) => res.json(templateList()));

// This saves the template chosen by the employee.
app.post('/select-template', (req, res) => {
    const dir = req.body.source === 'uploaded' ? DIRS.uploaded : DIRS.templates;
    const filePath = path.join(dir, req.body.template || '');
    if (!req.body.template || !fs.existsSync(filePath)) return res.status(400).json({ success: false, message: 'Template not found' });
    selectedTemplate = { name: req.body.template, source: req.body.source === 'uploaded' ? 'uploaded' : 'built_in', path: filePath };
    res.json({ success: true, selectedTemplate });
});

// This uploads a custom template image and selects it right away.
app.post('/upload-template', templateUpload.single('template'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Template file is required' });
    selectedTemplate = { name: req.file.filename, source: 'uploaded', path: req.file.path };
    res.json({ success: true, template: { name: req.file.filename, source: 'uploaded', url: `/uploaded_templates/${encodeURIComponent(req.file.filename)}` } });
});

// This uploads the Excel file, reads the first sheet, and keeps valid rows.
app.post('/upload-excel', excelUpload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'Excel file is required' });
        const workbook = xlsx.readFile(req.file.path, { cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const mapped = mapStudents(xlsx.utils.sheet_to_json(sheet, { defval: '' }));
        uploadedStudents = mapped.students;
        uploadSummary = mapped.summary;
        res.json({ success: true, total: uploadSummary.totalRows, valid: uploadSummary.validRows, invalid: uploadSummary.invalidRows, courseNames: uploadSummary.courseNames });
    } catch (error) {
        console.error('Excel upload failed:', error?.message || error);
        res.status(500).json({ success: false, message: 'Failed to process Excel file' });
    } finally {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

// This creates all certificate PDFs, zips them, and stores the latest batch info.
app.post('/generate', async (req, res) => {
    try {
        if (!uploadedStudents.length) return res.status(400).json({ success: false, message: 'Upload a valid Excel sheet first' });
        const zipName = `certificates_${Date.now()}.zip`;
        const zipPath = path.join(DIRS.certificates, zipName);
        const batchDir = path.join(DIRS.certificates, `batch_${Date.now()}`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        fs.mkdirSync(batchDir, { recursive: true });
        archive.pipe(output);

        for (const student of uploadedStudents) {
            await upsertCertificate(student);

            const pdfName = `${safeName(student.name)}_${safeName(student.reg_no)}.pdf`;
            const pdfPath = path.join(batchDir, pdfName);
            const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
            const pdfStream = fs.createWriteStream(pdfPath);
            doc.pipe(pdfStream);
            await new Promise((resolve, reject) => {
                pdfStream.on('finish', resolve);
                pdfStream.on('error', reject);
                doc.on('error', reject);
                drawCertificate(doc, student, `${baseUrl(req)}/verify/${encodeURIComponent(student.reg_no)}`).then(() => doc.end()).catch(reject);
            });
            archive.file(pdfPath, { name: pdfName });
        }

        await archive.finalize();
        await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
        fs.rmSync(batchDir, { recursive: true, force: true });
        lastGeneration = {
            zipName,
            zipUrl: `/download-zip/${encodeURIComponent(zipName)}`,
            createdAt: new Date().toISOString(),
            generatedCount: uploadedStudents.length,
            failedCount: uploadSummary.invalidRows
        };
        const emailStatus = await sendGenerationMail({
            employeeEmail: req.body.employeeEmail,
            zipName,
            zipPath,
            zipUrl: `${baseUrl(req)}${lastGeneration.zipUrl}`,
            generatedCount: uploadedStudents.length,
            invalidParticipants: uploadSummary.invalidParticipants
        });
        res.json({
            success: true,
            generatedCount: uploadedStudents.length,
            failedCount: uploadSummary.invalidRows,
            zipUrl: lastGeneration.zipUrl,
            emailSent: Boolean(emailStatus?.sent),
            emailMessage: emailStatus?.reason || 'Email status unavailable.'
        });
    } catch (error) {
        console.error('Generation failed:', error?.message || error);
        console.error('Stack:', error?.stack);
        res.status(500).json({ success: false, message: `Failed to generate certificates: ${error?.message || 'Unknown error'}` });
    }
});

// This downloads the ZIP file for the latest certificate batch.
app.get('/download-zip/:zipName', (req, res) => {
    const file = path.join(DIRS.certificates, path.basename(req.params.zipName || ''));
    if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'ZIP file not found' });
    res.download(file);
});

// This opens the certificate verification page.
app.get('/verify/:reg_no', (_, res) => res.sendFile(path.join(FRONTEND_DIR, 'verify.html')));

// This checks one registration number in the database.
app.get('/api/verify/:reg_no', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM certificates WHERE reg_no=? LIMIT 1', [req.params.reg_no]);
        if (!rows.length) return res.status(404).json({ verified: false, reg_no: req.params.reg_no, message: 'No valid certificate record was found.' });
        res.json({ verified: true, certificate: rows[0] });
    } catch {
        res.status(500).json({ verified: false, reg_no: req.params.reg_no, message: 'Verification failed' });
    }
});

// This sends dashboard numbers like totals, chart data, and last upload info.
app.get('/stats', async (_, res) => {
    try {
        const [totalResult, typesResult, coursesResult] = await Promise.all([
            db.query('SELECT COUNT(*) count FROM certificates'),
            db.query('SELECT course_type label, COUNT(*) value FROM certificates GROUP BY course_type ORDER BY value DESC'),
            db.query('SELECT course_name label, COUNT(*) value FROM certificates GROUP BY course_name ORDER BY value DESC')
        ]);
        const total = totalResult[0];
        const types = typesResult[0];
        const courses = coursesResult[0];
        res.json({
            totalCertificatesGenerated: Number(total[0]?.count) || 0,
            totalCandidatesNotCreated: uploadSummary.invalidRows || 0,
            courseTypes: types,
            courseNames: courses,
            currentUpload: uploadSummary,
            selectedTemplate,
            latestGeneration: lastGeneration
        });
    } catch {
        res.status(500).json({ success: false, message: 'Failed to load dashboard stats' });
    }
});

// This adds a new employee account from the admin page.
app.post('/add-employee', async (req, res) => {
    try {
        await db.query('INSERT INTO employees (name,email,password,phone,role) VALUES (?, ?, ?, ?, ?)', [req.body.name, req.body.email, hashPassword(req.body.password), req.body.phone, 'employee']);
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, message: 'Failed to add employee' });
    }
});

// This loads the employee list for the admin page.
app.get('/employees', async (_, res) => {
    try {
        const [rows] = await db.query("SELECT id,name,email,phone,role FROM employees WHERE role <> 'admin' OR role IS NULL ORDER BY id DESC");
        res.json(rows);
    } catch {
        res.status(500).json({ success: false, message: 'Failed to load employees' });
    }
});

// This deletes an employee account, but keeps admin accounts protected.
app.delete('/delete-employee/:id', async (req, res) => {
    try {
        await db.query("DELETE FROM employees WHERE id=? AND (role <> 'admin' OR role IS NULL)", [req.params.id]);
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, message: 'Failed to delete employee' });
    }
});

// This starts the backend server and prepares default accounts for first-time use.
app.listen(PORT, HOST, async () => {
    try {
        await ensureSchema();
        await ensureDefaultUsers();
    } catch (error) {
        console.warn('Database startup setup failed:', error.message);
    }
    console.log(`Server running on http://localhost:${PORT}`);
});