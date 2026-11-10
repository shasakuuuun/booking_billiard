const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const cron = require("node-cron");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// KONFIGURASI
// ======================================================
const TIME_ZONE = "Asia/Jakarta";
const SESSION_HOURS = 12;
const MAX_DURASI_JAM = 5;
const JAM_BUKA = 9 * 60;
const JAM_TUTUP = 23 * 60;
const SHAKE_TIMEOUT_MS = 25 * 1000;

const ESP_API_KEY = process.env.ESP_API_KEY || "";

const ADMIN = {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "billiard123"
};

const db = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "billiard_booking",
    options: "-c timezone=Asia/Jakarta"
});

// ======================================================
// WAKTU WIB
// ======================================================
function getWibParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date());

    const result = {};

    for (const p of parts) {
        if (p.type !== "literal") {
            result[p.type] = p.value;
        }
    }

    return result;
}

function getWibDate() {
    const p = getWibParts();
    return `${p.year}-${p.month}-${p.day}`;
}

function getWibTime() {
    const p = getWibParts();
    return `${p.hour}:${p.minute}`;
}

function hhmm(value) {
    return String(value).slice(0, 5);
}

function addDays(dateString, days) {
    const [y, m, d] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));

    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");
}

function isValidDateRange(from, to) {
    const pattern = /^\d{4}-\d{2}-\d{2}$/;

    if (
        typeof from !== "string" ||
        typeof to !== "string" ||
        !pattern.test(from) ||
        !pattern.test(to) ||
        from > to
    ) {
        return false;
    }

    function validDate(value) {
        const [y, m, d] = value.split("-").map(Number);
        const date = new Date(Date.UTC(y, m - 1, d));

        return (
            date.getUTCFullYear() === y &&
            date.getUTCMonth() === m - 1 &&
            date.getUTCDate() === d
        );
    }

    return validDate(from) && validDate(to);
}

// ======================================================
// LOG
// ======================================================
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

async function saveIotLog(
    eventType,
    mejaId = null,
    action = "",
    details = ""
) {
    try {
        await db.query(
            `INSERT INTO iot_logs
                (event_type, meja_id, action, details)
             VALUES ($1, $2, $3, $4)`,
            [
                String(eventType).slice(0, 40),
                mejaId == null ? null : Number(mejaId),
                String(action || "").slice(0, 80),
                String(details || "").slice(0, 2000)
            ]
        );
    } catch (err) {
        log("Simpan log IoT: " + err.message);
    }
}

function csvCell(value) {
    const s = value == null ? "" : String(value);
    return '"' + s.replace(/"/g, '""') + '"';
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.disable("x-powered-by");

app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin"
    });

    next();
});

app.use(cors({
    origin: process.env.CORS_ORIGIN || false
}));

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

process.on("uncaughtException", err => {
    log("Uncaught Exception: " + err.message);
});

process.on("unhandledRejection", err => {
    log("Unhandled Rejection: " + err);
});

// ======================================================
// KEAMANAN
// ======================================================
function safeEqual(a, b) {
    const ha = crypto.createHash("sha256")
        .update(String(a))
        .digest();

    const hb = crypto.createHash("sha256")
        .update(String(b))
        .digest();

    return crypto.timingSafeEqual(ha, hb);
}

if (
    (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) &&
    process.env.NODE_ENV === "production"
) {
    console.error("ADMIN_USERNAME dan ADMIN_PASSWORD wajib diisi.");
    process.exit(1);
}

if (!ESP_API_KEY) {
    log("PERINGATAN: ESP_API_KEY belum diatur.");
}

function requireEsp(req, res, next) {
    if (!ESP_API_KEY) return next();

    const key = req.headers["x-esp-key"];

    if (
        typeof key === "string" &&
        safeEqual(key, ESP_API_KEY)
    ) {
        return next();
    }

    return res.status(401).json({
        error: "Unauthorized"
    });
}

// ======================================================
// RATE LIMITER
// ======================================================
function rateLimit({ windowMs, max, message }) {
    const hits = new Map();

    setInterval(() => {
        const now = Date.now();

        for (const [key, value] of hits) {
            if (value.reset <= now) {
                hits.delete(key);
            }
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const now = Date.now();
        let entry = hits.get(req.ip);

        if (!entry || entry.reset <= now) {
            entry = {
                count: 0,
                reset: now + windowMs
            };

            hits.set(req.ip, entry);
        }

        entry.count++;

        if (entry.count > max) {
            res.set(
                "Retry-After",
                String(Math.ceil((entry.reset - now) / 1000))
            );

            return res.status(429).json({
                error: message
            });
        }

        next();
    };
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Terlalu banyak percobaan login."
});

const aktivasiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: "Terlalu banyak percobaan aktivasi."
});

const bookingLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: "Terlalu banyak booking."
});

// ======================================================
// TOKEN DAN KODE AKTIVASI
// ======================================================
function makeToken() {
    return crypto.randomBytes(32).toString("hex");
}

const KODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeKodeAktivasi() {
    let result = "";

    for (let i = 0; i < 8; i++) {
        result += KODE_CHARS[
            crypto.randomInt(KODE_CHARS.length)
        ];
    }

    return `BIL-${result}`;
}

// ======================================================
// DATABASE INITIALIZATION
// ======================================================
async function initializeDatabase() {
    try {
        await db.query("SELECT NOW()");
        log("PostgreSQL Connected");

        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_sessions (
                id SERIAL PRIMARY KEY,
                token VARCHAR(100) NOT NULL UNIQUE,
                username VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS iot_logs (
                id BIGSERIAL PRIMARY KEY,
                event_type VARCHAR(40) NOT NULL,
                meja_id INTEGER,
                action VARCHAR(80),
                details TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_iot_logs_created_at
            ON iot_logs (created_at DESC)
        `);

        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS status_bayar
            VARCHAR(20) DEFAULT 'belum'
        `);

        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS total_harga
            INTEGER DEFAULT 0
        `);

        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS activated_at
            TIMESTAMPTZ
        `);

        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS waiting_started_at
            TIMESTAMPTZ
        `);

        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS waiting_timeout_at
            TIMESTAMPTZ
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_bookings_meja_tanggal
            ON bookings (meja_id, tanggal)
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_bookings_kode_aktivasi
            ON bookings (kode_aktivasi)
        `);

        await cleanupSessions();

        setInterval(cleanupSessions, 60 * 60 * 1000).unref();

        log("Database initialization selesai.");
    } catch (err) {
        log("Database initialization gagal: " + err.message);
        process.exit(1);
    }
}

// ======================================================
// SESSION ADMIN
// ======================================================
function getToken(req) {
    const raw = req.headers["authorization"];

    if (typeof raw !== "string") return "";

    return raw.replace(/^Bearer\s+/i, "").trim();
}

async function cleanupSessions() {
    try {
        await db.query(
            `DELETE FROM admin_sessions
             WHERE created_at <
             NOW() - ($1 * INTERVAL '1 hour')`,
            [SESSION_HOURS]
        );
    } catch (err) {
        log("Cleanup session: " + err.message);
    }
}

async function requireAdmin(req, res, next) {
    const token = getToken(req);

    if (!token) {
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    try {
        const result = await db.query(
            `SELECT id
             FROM admin_sessions
             WHERE token=$1
               AND created_at >
               NOW() - ($2 * INTERVAL '1 hour')
             LIMIT 1`,
            [token, SESSION_HOURS]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "Unauthorized"
            });
        }

        next();
    } catch (err) {
        log("Require admin: " + err.message);

        return res.status(500).json({
            error: "Server Error"
        });
    }
}

// ======================================================
// STATE ADMIN
// ======================================================
let manualMode = {
    1: false,
    2: false
};

// ======================================================
// LOGIN ADMIN
// ======================================================
app.post("/api/admin/login", loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.length > 100 ||
            password.length > 200
        ) {
            return res.status(400).json({
                error: "Username dan password harus diisi."
            });
        }

        if (
            !safeEqual(username, ADMIN.username) ||
            !safeEqual(password, ADMIN.password)
        ) {
            log("ADMIN LOGIN FAILED");

            return res.status(401).json({
                error: "Username atau Password salah"
            });
        }

        const token = makeToken();

        await db.query(
            `INSERT INTO admin_sessions(token, username)
             VALUES($1, $2)`,
            [token, username]
        );

        log("ADMIN LOGIN SUCCESS");

        res.json({
            token,
            username
        });
    } catch (err) {
        log("Login Error: " + err.message);

        res.status(500).json({
            error: "Server Error"
        });
    }
});

// ======================================================
// VERIFY TOKEN
// ======================================================
app.post("/api/admin/verify", async (req, res) => {
    try {
        const { token } = req.body || {};

        if (typeof token !== "string" || !token) {
            return res.json({ valid: false });
        }

        const result = await db.query(
            `SELECT id
             FROM admin_sessions
             WHERE token=$1
               AND created_at >
               NOW() - ($2 * INTERVAL '1 hour')
             LIMIT 1`,
            [token, SESSION_HOURS]
        );

        res.json({
            valid: result.rows.length > 0
        });
    } catch (err) {
        log("Verify Error: " + err.message);

        res.status(500).json({
            valid: false
        });
    }
});

// ======================================================
// LOGOUT
// ======================================================
app.post("/api/admin/logout", requireAdmin, async (req, res) => {
    try {
        await db.query(
            "DELETE FROM admin_sessions WHERE token=$1",
            [getToken(req)]
        );

        log("ADMIN LOGOUT");

        res.json({ success: true });
    } catch (err) {
        log("Logout Error: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// BOOKING PUBLIK
// ======================================================
app.get("/api/bookings", async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, nama, meja_id, jam_mulai,
                    jam_selesai, tanggal, durasi, status
             FROM bookings
             WHERE tanggal=$1::date
             ORDER BY jam_mulai ASC`,
            [getWibDate()]
        );

        res.json(result.rows);
    } catch (err) {
        log("Load Booking: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// BOOKING ADMIN
// ======================================================
app.get("/api/admin/bookings", requireAdmin, async (req, res) => {
    try {
        const today = getWibDate();

        const from = req.query.from || today;
        const to = req.query.to || today;

        if (!isValidDateRange(from, to)) {
            return res.status(400).json({
                error: "Rentang tanggal tidak valid."
            });
        }

        const result = await db.query(
            `SELECT *
             FROM bookings
             WHERE tanggal >= $1::date
               AND tanggal <= $2::date
             ORDER BY tanggal ASC, jam_mulai ASC`,
            [from, to]
        );

        res.json(result.rows);
    } catch (err) {
        log("Load Booking Admin: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// TAMBAH BOOKING
// ======================================================
app.post("/api/booking", bookingLimiter, async (req, res) => {
    let client;

    try {
        const body = req.body || {};

        const nama = typeof body.nama === "string"
            ? body.nama
                .replace(/[\u0000-\u001F\u007F]/g, "")
                .replace(/\s+/g, " ")
                .trim()
            : "";

        const jamMulai = typeof body.jam_mulai === "string"
            ? body.jam_mulai.trim()
            : "";

        const durasi = Number(body.durasi);
        const mejaId = Number(body.meja_id);

        if (!nama || !jamMulai || !body.durasi || !body.meja_id) {
            return res.status(400).json({
                error: "Semua field wajib diisi."
            });
        }

        if (nama.length < 2 || nama.length > 100) {
            return res.status(400).json({
                error: "Nama harus 2-100 karakter."
            });
        }

        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(jamMulai)) {
            return res.status(400).json({
                error: "Format jam mulai tidak valid."
            });
        }

        if (
            !Number.isInteger(durasi) ||
            durasi < 1 ||
            durasi > MAX_DURASI_JAM
        ) {
            return res.status(400).json({
                error: `Durasi harus 1-${MAX_DURASI_JAM} jam.`
            });
        }

        if (!Number.isInteger(mejaId) || mejaId < 1) {
            return res.status(400).json({
                error: "Meja tidak valid."
            });
        }

        const [hour, minute] = jamMulai.split(":").map(Number);
        const menitMulai = hour * 60 + minute;
        const menitSelesai = menitMulai + durasi * 60;

        if (menitMulai < JAM_BUKA) {
            return res.status(400).json({
                error: "Booking hanya dapat dimulai mulai pukul 09:00 WIB."
            });
        }

        if (menitSelesai > JAM_TUTUP) {
            return res.status(400).json({
                error: "Booking harus selesai paling lambat pukul 23:00 WIB."
            });
        }

        const jamSelesai =
            `${String(Math.floor(menitSelesai / 60)).padStart(2, "0")}:` +
            `${String(menitSelesai % 60).padStart(2, "0")}`;

        const tanggal = getWibDate();
        const totalHarga = durasi * 30000;

        client = await db.connect();
        await client.query("BEGIN");

        await client.query(
            "SELECT pg_advisory_xact_lock(1001, $1)",
            [mejaId]
        );

        const meja = await client.query(
            "SELECT id FROM meja_billiard WHERE id=$1",
            [mejaId]
        );

        if (!meja.rows.length) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Meja tidak ditemukan."
            });
        }

        const conflict = await client.query(
            `SELECT id, jam_mulai, jam_selesai
             FROM bookings
             WHERE meja_id=$1
               AND tanggal=$2::date
               AND status != 'completed'
               AND jam_mulai < $3
               AND jam_selesai > $4
             LIMIT 1`,
            [mejaId, tanggal, jamSelesai, jamMulai]
        );

        if (conflict.rows.length) {
            await client.query("ROLLBACK");

            const c = conflict.rows[0];

            return res.status(409).json({
                error:
                    `Meja sudah dibooking pukul ` +
                    `${hhmm(c.jam_mulai)}-${hhmm(c.jam_selesai)}`
            });
        }

        let kode = "";
        let unik = false;

        for (let i = 0; i < 10; i++) {
            kode = makeKodeAktivasi();

            const check = await client.query(
                "SELECT 1 FROM bookings WHERE kode_aktivasi=$1",
                [kode]
            );

            if (!check.rows.length) {
                unik = true;
                break;
            }
        }

        if (!unik) {
            throw new Error("Gagal menghasilkan kode aktivasi unik.");
        }

        const insert = await client.query(
            `INSERT INTO bookings
                (nama, meja_id, jam_mulai, jam_selesai,
                 tanggal, durasi, status_bayar,
                 total_harga, kode_aktivasi)
             VALUES
                ($1, $2, $3, $4, $5::date, $6, 'belum', $7, $8)
             RETURNING id`,
            [
                nama,
                mejaId,
                jamMulai,
                jamSelesai,
                tanggal,
                durasi,
                totalHarga,
                kode
            ]
        );

        await client.query("COMMIT");

        log(
            `BOOKING -> Meja ${mejaId} | ${jamMulai}-${jamSelesai}`
        );

        res.json({
            success: true,
            booking_id: insert.rows[0].id,
            kode_aktivasi: kode,
            nama,
            meja_id: mejaId,
            jam_mulai: jamMulai,
            jam_selesai: jamSelesai,
            durasi,
            total_harga: totalHarga
        });
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        log("Booking Error: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    } finally {
        if (client) client.release();
    }
});

// ======================================================
// AKTIVASI KODE
// ======================================================
app.post("/api/aktivasi", aktivasiLimiter, async (req, res) => {
    let client;

    try {
        const kode = typeof req.body?.kode === "string"
            ? req.body.kode.trim().toUpperCase()
            : "";

        if (!/^BIL-[A-HJ-NP-Z2-9]{8}$/.test(kode)) {
            return res.status(400).json({
                error: "Format kode aktivasi salah."
            });
        }

        const tanggal = getWibDate();
        const sekarang = getWibTime();

        client = await db.connect();
        await client.query("BEGIN");

        const result = await client.query(
            `SELECT *
             FROM bookings
             WHERE kode_aktivasi=$1
               AND tanggal=$2::date
               AND status != 'completed'
             FOR UPDATE`,
            [kode, tanggal]
        );

        if (!result.rows.length) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Kode tidak ditemukan atau booking telah selesai."
            });
        }

        const booking = result.rows[0];
        const meja = Number(booking.meja_id);

        if (sekarang < hhmm(booking.jam_mulai)) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: `Booking dimulai pukul ${hhmm(booking.jam_mulai)}`
            });
        }

        if (sekarang >= hhmm(booking.jam_selesai)) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Waktu booking sudah berakhir."
            });
        }

        await client.query(
            `UPDATE bookings
             SET status='active',
                 activated_at=NOW(),
                 waiting_timeout_at=NULL
             WHERE id=$1`,
            [booking.id]
        );

        await client.query(
            `UPDATE meja_billiard
             SET status_lampu=TRUE
             WHERE id=$1`,
            [meja]
        );

        await client.query("COMMIT");

        manualMode[meja] = false;

        log(`AKTIVASI -> ${kode} | Meja ${meja}`);

        await saveIotLog(
            "ACTIVATION",
            meja,
            "ON",
            `Aktivasi booking #${booking.id}`
        );

        res.json({
            success: true,
            meja_id: meja,
            nama: booking.nama,
            jam_selesai: booking.jam_selesai,
            message: `Lampu Meja ${meja} berhasil dinyalakan.`
        });
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        log("Aktivasi Error: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    } finally {
        if (client) client.release();
    }
});

// ======================================================
// STATUS LAMPU
// ======================================================
app.get("/api/lampu/status", async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM meja_billiard ORDER BY id ASC"
        );

        res.json(result.rows);
    } catch (err) {
        log("Status Lampu: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// STATUS MEJA
// ======================================================
app.get("/api/status-meja", async (req, res) => {
    try {
        const today = getWibDate();

        const result = await db.query(
            `SELECT
                m.id,
                m.nama_meja,
                m.status_lampu,
                COALESCE(
                    (
                        SELECT status
                        FROM bookings
                        WHERE meja_id=m.id
                          AND tanggal=$1::date
                          AND status='active'
                        LIMIT 1
                    ),
                    'idle'
                ) AS status_booking
             FROM meja_billiard m
             ORDER BY m.id ASC`,
            [today]
        );

        res.json(result.rows);
    } catch (err) {
        log("Status Meja: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});


// ======================================================
// RESET MEJA
// Mengakhiri seluruh booking hari ini dan mematikan lampu.
// ======================================================
app.post("/api/reset-meja", requireAdmin, async (req, res) => {
    try {
        await db.query("BEGIN");

        // Matikan seluruh lampu melalui PostgreSQL.
        await db.query(
            "UPDATE meja_billiard SET status_lampu = FALSE"
        );

        // Selesaikan seluruh booking hari ini.
        await db.query(
            `UPDATE bookings
             SET status = 'completed'
             WHERE tanggal = $1::date
               AND status != 'completed'`,
            [getWibDate()]
        );

        await db.query("COMMIT");

        // Nonaktifkan mode manual.
        manualMode = {
            1: false,
            2: false
        };

        // Tidak perlu pushCommand().
        // ESP32 membaca status lampu langsung dari database.

        await saveIotLog(
            "ADMIN",
            null,
            "RESET_ALL",
            "Reset seluruh meja dan lampu"
        );

        log("RESET SEMUA MEJA");

        return res.json({
            success: true,
            message: "Reset berhasil. Semua booking hari ini diselesaikan dan lampu dimatikan."
        });

    } catch (err) {
        try {
            await db.query("ROLLBACK");
        } catch (_) {}

        log("Reset Error: " + err.message);

        return res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});


// ======================================================
// GLOBAL CONTROL
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const action = req.body?.action;

        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({
                error: "Action harus ON/OFF."
            });
        }

        const status = action === "ON";

        await db.query(
            "UPDATE meja_billiard SET status_lampu=$1",
            [status]
        );

        manualMode[1] = status;
        manualMode[2] = status;

        await saveIotLog(
            "LAMP",
            null,
            action,
            "Kontrol lampu global oleh admin"
        );

        log(`GLOBAL ${action}`);

        res.json({
            success: true,
            message: `Semua lampu ${action}`
        });
    } catch (err) {
        log("Global Control: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// MANUAL CONTROL
// ======================================================
app.post("/api/manual-control", requireAdmin, async (req, res) => {
    try {
        const meja = Number(req.body?.meja_id);
        const action = req.body?.action;

        if (![1, 2].includes(meja)) {
            return res.status(400).json({
                error: "Meja tidak valid."
            });
        }

        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({
                error: "Action harus ON/OFF."
            });
        }

        const status = action === "ON";

        await db.query(
            "UPDATE meja_billiard SET status_lampu=$1 WHERE id=$2",
            [status, meja]
        );

        manualMode[meja] = status;

        await saveIotLog(
            "LAMP",
            meja,
            action,
            "Kontrol manual oleh admin"
        );

        log(`MANUAL ${action} -> Meja ${meja}`);

        res.json({
            success: true,
            message: `Lampu Meja ${meja} ${action}`
        });
    } catch (err) {
        log("Manual Control: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// SENSOR GETAR
// Sensor hanya mencatat getaran dan mereset timer.
// Tidak pernah menyalakan lampu.
// Tidak dapat membatalkan timeout.
// ======================================================
app.post("/api/shake", requireEsp, async (req, res) => {
    let client;

    try {
        const meja = Number(req.body?.meja_id);

        if (meja !== 1) {
            return res.status(400).json({
                error: "Sensor hanya tersedia pada Meja 1."
            });
        }

        client = await db.connect();
        await client.query("BEGIN");

        const today = getWibDate();
        const now = getWibTime();

        const result = await client.query(
            `SELECT *
             FROM bookings
             WHERE meja_id=1
               AND tanggal=$1::date
               AND status='active'
               AND jam_mulai <= $2
               AND jam_selesai > $2
             LIMIT 1
             FOR UPDATE`,
            [today, now]
        );

        if (!result.rows.length) {
            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Tidak ada booking aktif."
            });
        }

        const booking = result.rows[0];

        // Jika pelanggan sudah aktivasi, sensor tidak lagi
        // mengubah timer.
        if (booking.activated_at) {
            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Pelanggan sudah melakukan aktivasi."
            });
        }

        // Jika sudah timeout, getaran tidak boleh
        // menghidupkan lampu atau membuka timeout.
        if (booking.waiting_timeout_at) {
            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Timeout aktif. Masukkan kode aktivasi."
            });
        }

        const lamp = await client.query(
            `SELECT status_lampu
             FROM meja_billiard
             WHERE id=1
             FOR UPDATE`
        );

        if (!lamp.rows.length || !lamp.rows[0].status_lampu) {
            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Lampu tidak menyala."
            });
        }

        // Reset timer menunggu 25 detik.
        await client.query(
            `UPDATE bookings
             SET waiting_started_at=NOW()
             WHERE id=$1
               AND activated_at IS NULL
               AND waiting_timeout_at IS NULL`,
            [booking.id]
        );

        await client.query("COMMIT");

        await saveIotLog(
            "SENSOR",
            1,
            "SHAKE",
            `Aktivitas booking #${booking.id}; timer direset.`
        );

        log(`SENSOR RESET TIMER -> Booking #${booking.id}`);

        res.json({
            success: true,
            message: "Aktivitas sensor tercatat."
        });
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        log("Shake Error: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    } finally {
        if (client) client.release();
    }
});

// ======================================================
// ESP32 COMMAND
// PostgreSQL menjadi sumber kebenaran status lampu.
// Setiap polling selalu mengirim ON1/OFF1/ON2/OFF2.
// ======================================================
app.get("/api/esp-command", requireEsp, async (req, res) => {
    try {
        const meja = Number(req.query.meja);

        if (![1, 2].includes(meja)) {
            return res.status(400).send("");
        }

        const result = await db.query(
            `SELECT status_lampu
             FROM meja_billiard
             WHERE id=$1
             LIMIT 1`,
            [meja]
        );

        if (!result.rows.length) {
            return res.status(404).send("");
        }

        const isOn = result.rows[0].status_lampu === true;
        const command = `${isOn ? "ON" : "OFF"}${meja}`;

        res.set("Cache-Control", "no-store");

        return res.type("text/plain").send(command);
    } catch (err) {
        log("ESP COMMAND: " + err.message);

        res.status(500).send("");
    }
});

// ======================================================
// CRON BOOKING
// Booking mulai: lampu otomatis ON.
// Booking selesai: lampu otomatis OFF.
// Meja 1: mulai timer menunggu 25 detik.
// Meja 2: tidak menggunakan sensor.
// ======================================================
let cronBookingBusy = false;

cron.schedule("* * * * * *", async () => {
    if (cronBookingBusy) return;

    cronBookingBusy = true;

    let client;

    try {
        const today = getWibDate();
        const now = getWibTime();

        client = await db.connect();
        await client.query("BEGIN");

        for (const mejaId of [1, 2]) {
            const result = await client.query(
                `SELECT *
                 FROM bookings
                 WHERE meja_id=$1
                   AND tanggal=$2::date
                   AND status != 'completed'
                 ORDER BY jam_mulai ASC
                 FOR UPDATE`,
                [mejaId, today]
            );

            let bookingAktif = null;

            for (const booking of result.rows) {
                const mulai = hhmm(booking.jam_mulai);
                const selesai = hhmm(booking.jam_selesai);

                if (now >= selesai) {
                    await client.query(
                        `UPDATE bookings
                         SET status='completed'
                         WHERE id=$1`,
                        [booking.id]
                    );

                    log(`BOOKING COMPLETED -> #${booking.id}`);
                    continue;
                }

                if (now >= mulai && now < selesai) {
                    bookingAktif = booking;
                    break;
                }
            }

            if (!bookingAktif) {
                const lamp = await client.query(
                    `SELECT status_lampu
                     FROM meja_billiard
                     WHERE id=$1
                     FOR UPDATE`,
                    [mejaId]
                );

                if (lamp.rows.length && lamp.rows[0].status_lampu) {
                    await client.query(
                        `UPDATE meja_billiard
                         SET status_lampu=FALSE
                         WHERE id=$1`,
                        [mejaId]
                    );

                    log(`AUTO OFF -> Meja ${mejaId}`);
                }

                continue;
            }

            const bookingId = bookingAktif.id;

            // Meja 1: buat timer awal jika belum pernah dibuat.
            if (mejaId === 1) {
                await client.query(
                    `UPDATE bookings
                     SET status='active',
                         waiting_started_at=
                            COALESCE(waiting_started_at, NOW())
                     WHERE id=$1`,
                    [bookingId]
                );
            } else {
                await client.query(
                    `UPDATE bookings
                     SET status='active'
                     WHERE id=$1`,
                    [bookingId]
                );
            }

            let shouldLampOn = true;

            // Meja 1 tetap mati jika timeout sudah terjadi
            // dan pelanggan belum melakukan aktivasi.
            if (
                mejaId === 1 &&
                bookingAktif.waiting_timeout_at &&
                !bookingAktif.activated_at
            ) {
                shouldLampOn = false;
            }

            if (manualMode[mejaId]) {
                continue;
            }

            await client.query(
                `UPDATE meja_billiard
                 SET status_lampu=$1
                 WHERE id=$2`,
                [shouldLampOn, mejaId]
            );

            if (shouldLampOn && !bookingAktif.activated_at) {
                // Lampu otomatis ON pada awal booking.
                // Tidak mengubah waiting_started_at jika sudah ada.
                log(`BOOKING AKTIF -> Meja ${mejaId}`);
            }
        }

        await client.query("COMMIT");
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        log("CRON BOOKING: " + err.message);
    } finally {
        if (client) client.release();
        cronBookingBusy = false;
    }
});

// ======================================================
// CRON SENSOR TIMEOUT
// HANYA MEJA 1
// ======================================================
let sensorCronBusy = false;

cron.schedule("* * * * * *", async () => {
    if (sensorCronBusy) return;

    sensorCronBusy = true;

    let client;

    try {
        client = await db.connect();
        await client.query("BEGIN");

        const today = getWibDate();
        const now = getWibTime();

        const result = await client.query(
            `SELECT *
             FROM bookings
             WHERE meja_id=1
               AND tanggal=$1::date
               AND status='active'
               AND jam_mulai <= $2
               AND jam_selesai > $2
               AND activated_at IS NULL
               AND waiting_timeout_at IS NULL
               AND waiting_started_at IS NOT NULL
               AND waiting_started_at <=
                   NOW() - ($3 * INTERVAL '1 millisecond')
             LIMIT 1
             FOR UPDATE`,
            [today, now, SHAKE_TIMEOUT_MS]
        );

        if (!result.rows.length) {
            await client.query("COMMIT");
            return;
        }

        const booking = result.rows[0];

        await client.query(
            `UPDATE bookings
             SET waiting_timeout_at=NOW()
             WHERE id=$1
               AND activated_at IS NULL
               AND waiting_timeout_at IS NULL`,
            [booking.id]
        );

        await client.query(
            `UPDATE meja_billiard
             SET status_lampu=FALSE
             WHERE id=1`
        );

        await client.query("COMMIT");

        log(
            `SENSOR TIMEOUT -> Meja 1 | Booking #${booking.id}`
        );

        await saveIotLog(
            "SENSOR",
            1,
            "TIMEOUT",
            `Lampu dimatikan setelah ${SHAKE_TIMEOUT_MS / 1000} detik tanpa aktivitas. Booking #${booking.id}`
        );
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {}
        }

        log("SENSOR CRON: " + err.message);
    } finally {
        if (client) client.release();
        sensorCronBusy = false;
    }
});

// ======================================================
// STATISTIK
// ======================================================
app.get("/api/statistik", async (req, res) => {
    try {
        const days = Math.min(
            Math.max(parseInt(req.query.days, 10) || 30, 1),
            365
        );

        const today = getWibDate();

        const result = await db.query(
            `SELECT
                TO_CHAR(gs.tanggal::date, 'YYYY-MM-DD') AS tanggal,
                COUNT(b.id)::integer AS total_booking,
                COALESCE(SUM(b.durasi), 0)::integer AS total_jam
             FROM generate_series(
                $2::date - (($1 - 1) * INTERVAL '1 day'),
                $2::date,
                INTERVAL '1 day'
             ) AS gs(tanggal)
             LEFT JOIN bookings b
                ON b.tanggal=gs.tanggal::date
             GROUP BY gs.tanggal
             ORDER BY gs.tanggal`,
            [days, today]
        );

        res.json(result.rows);
    } catch (err) {
        log("Statistik: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// KONFIRMASI PEMBAYARAN
// ======================================================
app.post("/api/konfirmasi-bayar", requireAdmin, async (req, res) => {
    try {
        const bookingId = Number(req.body?.booking_id);

        if (!Number.isInteger(bookingId) || bookingId < 1) {
            return res.status(400).json({
                error: "Booking tidak valid."
            });
        }

        const result = await db.query(
            `UPDATE bookings
             SET status_bayar='lunas'
             WHERE id=$1
             RETURNING id`,
            [bookingId]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Booking tidak ditemukan."
            });
        }

        await saveIotLog(
            "PAYMENT",
            null,
            "LUNAS",
            `Pembayaran booking #${bookingId} dikonfirmasi`
        );

        log(`LUNAS -> Booking #${bookingId}`);

        res.json({
            success: true,
            message: "Pembayaran dikonfirmasi!"
        });
    } catch (err) {
        log("Konfirmasi Bayar: " + err.message);

        res.status(500).json({
            error: "Terjadi kesalahan pada server."
        });
    }
});

// ======================================================
// EXPORT CSV LOG IoT
// ======================================================
app.get("/api/admin/iot-export.csv", requireAdmin, async (req, res) => {
    try {
        const { from, to } = req.query;

        if (!isValidDateRange(from, to)) {
            return res.status(400).json({
                error: "Rentang tanggal tidak valid."
            });
        }

        const result = await db.query(
            `SELECT id, event_type, meja_id, action, details, created_at
             FROM iot_logs
             WHERE created_at >= $1::date
               AND created_at < ($2::date + INTERVAL '1 day')
             ORDER BY created_at ASC`,
            [from, to]
        );

        const lines = [
            [
                "id",
                "event_type",
                "meja_id",
                "action",
                "details",
                "created_at"
            ].map(csvCell).join(",")
        ];

        for (const row of result.rows) {
            lines.push([
                row.id,
                row.event_type,
                row.meja_id,
                row.action,
                row.details,
                row.created_at
                    ? new Date(row.created_at).toISOString()
                    : ""
            ].map(csvCell).join(","));
        }

        res.set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
                `attachment; filename="log-iot-${from}-${to}.csv"`,
            "Cache-Control": "no-store"
        });

        res.send("\uFEFF" + lines.join("\r\n"));
    } catch (err) {
        log("Export CSV: " + err.message);

        res.status(500).json({
            error: "Gagal mengekspor log IoT."
        });
    }
});

// ======================================================
// EXPORT EXCEL
// ======================================================
app.get("/api/admin/laporan.xlsx", requireAdmin, async (req, res) => {
    try {
        const today = getWibDate();

        const from = req.query.from || addDays(today, -6);
        const to = req.query.to || today;

        if (!isValidDateRange(from, to)) {
            return res.status(400).json({
                error: "Rentang tanggal laporan tidak valid."
            });
        }

        const [summaryResult, bookingResult, logResult] =
            await Promise.all([
                db.query(
                    `SELECT
                        TO_CHAR(gs.tanggal::date, 'YYYY-MM-DD') AS tanggal,
                        COUNT(b.id)::integer AS total_booking,
                        COALESCE(SUM(b.durasi), 0)::integer AS total_jam,
                        COALESCE(SUM(b.total_harga), 0)::integer AS total_nilai,
                        COALESCE(
                            SUM(
                                CASE
                                    WHEN b.status_bayar='lunas'
                                    THEN b.total_harga
                                    ELSE 0
                                END
                            ), 0
                        )::integer AS pendapatan_lunas
                     FROM generate_series(
                        $1::date,
                        $2::date,
                        INTERVAL '1 day'
                     ) AS gs(tanggal)
                     LEFT JOIN bookings b
                        ON b.tanggal=gs.tanggal::date
                     GROUP BY gs.tanggal
                     ORDER BY gs.tanggal`,
                    [from, to]
                ),

                db.query(
                    `SELECT
                        id, nama, meja_id,
                        TO_CHAR(tanggal, 'YYYY-MM-DD') AS tanggal,
                        jam_mulai, jam_selesai, durasi,
                        status, status_bayar, total_harga
                     FROM bookings
                     WHERE tanggal >= $1::date
                       AND tanggal <= $2::date
                     ORDER BY tanggal ASC, jam_mulai ASC`,
                    [from, to]
                ),

                db.query(
                    `SELECT
                        id, event_type, meja_id,
                        action, details, created_at
                     FROM iot_logs
                     WHERE created_at >= $1::date
                       AND created_at < ($2::date + INTERVAL '1 day')
                     ORDER BY created_at ASC`,
                    [from, to]
                )
            ]);

        const workbook = new ExcelJS.Workbook();

        workbook.creator = "Smart Billiard";
        workbook.subject = "Laporan Booking dan IoT";
        workbook.title = "Laporan Smart Billiard";

        // SHEET RINGKASAN
        const summary = workbook.addWorksheet("Ringkasan");

        summary.columns = [
            { header: "Tanggal", key: "tanggal", width: 18 },
            { header: "Total Booking", key: "booking", width: 18 },
            { header: "Total Jam", key: "jam", width: 15 },
            { header: "Total Nilai Booking", key: "nilai", width: 23 },
            { header: "Pendapatan Lunas", key: "lunas", width: 22 }
        ];

        summary.mergeCells("A1:E1");
        summary.getCell("A1").value = "LAPORAN SMART BILLIARD";
        summary.getCell("A1").font = { bold: true, size: 16 };
        summary.getCell("A1").alignment = {
            horizontal: "center"
        };

        summary.mergeCells("A2:E2");
        summary.getCell("A2").value = `Periode: ${from} sampai ${to}`;

        summary.getRow(4).values = [
            "Tanggal",
            "Total Booking",
            "Total Jam",
            "Total Nilai Booking",
            "Pendapatan Lunas"
        ];

        summary.getRow(4).font = { bold: true };

        for (const row of summaryResult.rows) {
            summary.addRow({
                tanggal: row.tanggal,
                booking: Number(row.total_booking),
                jam: Number(row.total_jam),
                nilai: Number(row.total_nilai),
                lunas: Number(row.pendapatan_lunas)
            });
        }

        const totals = summaryResult.rows.reduce(
            (acc, row) => {
                acc.booking += Number(row.total_booking);
                acc.jam += Number(row.total_jam);
                acc.nilai += Number(row.total_nilai);
                acc.lunas += Number(row.pendapatan_lunas);
                return acc;
            },
            { booking: 0, jam: 0, nilai: 0, lunas: 0 }
        );

        summary.addRow([
            "TOTAL",
            totals.booking,
            totals.jam,
            totals.nilai,
            totals.lunas
        ]);

        summary.getColumn(4).numFmt = '"Rp" #,##0';
        summary.getColumn(5).numFmt = '"Rp" #,##0';

        // SHEET DETAIL BOOKING
        const bookingSheet = workbook.addWorksheet("Detail Booking");

        bookingSheet.addRow([
            "ID Booking",
            "Nama Pelanggan",
            "Meja",
            "Tanggal",
            "Jam Mulai",
            "Jam Selesai",
            "Durasi",
            "Status Booking",
            "Status Bayar",
            "Total Harga"
        ]);

        bookingSheet.columns = [
            { width: 15 },
            { width: 25 },
            { width: 12 },
            { width: 18 },
            { width: 15 },
            { width: 15 },
            { width: 12 },
            { width: 18 },
            { width: 18 },
            { width: 20 }
        ];

        bookingSheet.getRow(1).font = { bold: true };

        for (const row of bookingResult.rows) {
            bookingSheet.addRow([
                row.id,
                row.nama,
                `Meja ${row.meja_id}`,
                row.tanggal,
                hhmm(row.jam_mulai),
                hhmm(row.jam_selesai),
                Number(row.durasi),
                row.status,
                row.status_bayar,
                Number(row.total_harga || 0)
            ]);
        }

        bookingSheet.getColumn(10).numFmt = '"Rp" #,##0';

        // SHEET LOG IoT
        const iotSheet = workbook.addWorksheet("Log IoT");

        iotSheet.addRow([
            "ID Log",
            "Event",
            "Meja",
            "Action",
            "Details",
            "Waktu Kejadian"
        ]);

        iotSheet.columns = [
            { width: 15 },
            { width: 18 },
            { width: 12 },
            { width: 20 },
            { width: 55 },
            { width: 25 }
        ];

        iotSheet.getRow(1).font = { bold: true };

        for (const row of logResult.rows) {
            iotSheet.addRow([
                row.id,
                row.event_type,
                row.meja_id == null ? "-" : `Meja ${row.meja_id}`,
                row.action,
                row.details,
                row.created_at
                    ? new Date(row.created_at).toLocaleString("id-ID", {
                        timeZone: TIME_ZONE
                    })
                    : ""
            ]);
        }

        for (const sheet of [summary, bookingSheet, iotSheet]) {
            sheet.views = [
                { state: "frozen", ySplit: 1 }
            ];

            sheet.eachRow(row => {
                row.eachCell(cell => {
                    cell.alignment = {
                        vertical: "middle",
                        wrapText: true
                    };
                });
            });
        }

        res.set({
            "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition":
                `attachment; filename="laporan-smart-billiard-${from}-${to}.xlsx"`,
            "Cache-Control": "no-store"
        });

        await workbook.xlsx.write(res);
        res.end();

        log(`EXPORT EXCEL -> ${from} sampai ${to}`);
    } catch (err) {
        log("Export Excel: " + err.message);

        if (!res.headersSent) {
            res.status(500).json({
                error: "Gagal membuat laporan Excel."
            });
        } else {
            res.end();
        }
    }
});

// ======================================================
// ERROR HANDLER
// ======================================================
app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
        return res.status(400).json({
            error: "Format JSON tidak valid."
        });
    }

    if (err?.type === "entity.too.large") {
        return res.status(413).json({
            error: "Data terlalu besar."
        });
    }

    log("Middleware Error: " + err);

    res.status(500).json({
        error: "Terjadi kesalahan pada server."
    });
});

// ======================================================
// START SERVER
// ======================================================
async function startServer() {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
        log("SERVER RUNNING");
        log(`http://localhost:${PORT}`);
        log(`Zona waktu: ${TIME_ZONE}`);
        log("Jam operasional: 09:00-23:00 WIB");
        log(`Sensor timeout: ${SHAKE_TIMEOUT_MS / 1000} detik`);
    });
}

startServer();