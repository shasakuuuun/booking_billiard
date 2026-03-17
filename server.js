//====================================================================
// SMART BILLIARD SERVER - PostgreSQL Version
// (FINAL: BOOKING + KODE AKTIVASI + SHAKE SENSOR + CRON)
//====================================================================

const express  = require("express");
const { Pool } = require("pg");
const cors     = require("cors");
const cron     = require("node-cron");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// LOG
// ======================================================
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

process.on("uncaughtException",  err => log("❌ Uncaught: "  + err));
process.on("unhandledRejection", err => log("❌ Unhandled: " + err));

// ======================================================
// ADMIN AUTH
// ======================================================
const ADMIN = {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "billiard123"
};
let adminSessions = new Set();

function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeKodeAktivasi(bookingId) {
    const pad  = String(bookingId).padStart(3, "0");
    const year = new Date().getFullYear();
    return `BIL-${pad}-${year}`;
}

function requireAdmin(req, res, next) {
    const token = req.headers["authorization"];
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// ======================================================
// POSTGRESQL CONNECTION
// ======================================================
const db = new Pool({
    host:     process.env.DB_HOST     || "localhost",
    port:     process.env.DB_PORT     || 5432,
    user:     process.env.DB_USER     || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "billiard_booking",
});

// Test koneksi saat startup
db.connect()
    .then(client => {
        log("✅ PostgreSQL Connected!");
        client.release();
    })
    .catch(err => {
        log("❌ PostgreSQL Connection FAILED: " + err.message);
        log("💡 Pastikan PostgreSQL jalan dan .env sudah benar");
    });

// ======================================================
// ESP COMMAND QUEUE
// ======================================================
let commandQueue = { 1: "", 2: "" };

function pushCommand(cmd) {
    const meja = Number(cmd.replace(/\D/g, ""));
    if (meja === 1 || meja === 2) {
        commandQueue[meja] = cmd;
        log(`📡 QUEUE → ${cmd}`);
    }
}

// ======================================================
// ADMIN LOGIN
// ======================================================
app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN.username && password === ADMIN.password) {
        const token = makeToken();
        adminSessions.add(token);
        log("🔐 ADMIN LOGIN SUCCESS");
        return res.json({ token, username });
    }
    log("❌ ADMIN LOGIN FAILED");
    res.status(401).json({ error: "Username atau password salah" });
});

app.post("/api/admin/verify", (req, res) => {
    const { token } = req.body;
    if (adminSessions.has(token)) return res.json({ valid: true });
    res.status(401).json({ error: "Token tidak valid" });
});

// ======================================================
// API — BOOKINGS
// ======================================================
app.get("/api/bookings", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM bookings
            WHERE tanggal = CURRENT_DATE
            ORDER BY jam_mulai ASC
        `);
        res.json(result.rows);
    } catch (err) {
        log("❌ Load bookings: " + err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/booking", async (req, res) => {
    try {
        const { nama, jam_mulai, durasi, meja_id } = req.body;

        if (!nama || !jam_mulai || !durasi || !meja_id)
            return res.status(400).json({ error: "Semua field harus diisi" });

        // Hitung jam selesai
        const start = new Date(`1970-01-01T${jam_mulai}:00`);
        const end   = new Date(start.getTime() + durasi * 3600000);
        const jam_selesai = end.toTimeString().slice(0, 5);

        // Insert booking
        const insertResult = await db.query(`
            INSERT INTO bookings (nama, meja_id, jam_mulai, jam_selesai, tanggal, durasi)
            VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
            RETURNING id
        `, [nama, meja_id, jam_mulai, jam_selesai, durasi]);

        const bookingId    = insertResult.rows[0].id;
        const kodeAktivasi = makeKodeAktivasi(bookingId);

        // Simpan kode aktivasi
        await db.query(
            `UPDATE bookings SET kode_aktivasi = $1 WHERE id = $2`,
            [kodeAktivasi, bookingId]
        );

        log(`📅 Booking → Meja ${meja_id} (${jam_mulai} - ${jam_selesai}) | Kode: ${kodeAktivasi}`);

        res.json({
            message: "Booking berhasil!",
            booking_id: bookingId,
            kode_aktivasi: kodeAktivasi,
            nama,
            meja_id,
            jam_mulai,
            jam_selesai,
            durasi
        });

    } catch (err) {
        log("❌ Add booking: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API — AKTIVASI KODE (Customer Telat)
// ======================================================
app.post("/api/aktivasi", async (req, res) => {
    try {
        const { kode } = req.body;

        if (!kode) return res.status(400).json({ error: "Kode tidak boleh kosong" });

        const result = await db.query(`
            SELECT * FROM bookings
            WHERE kode_aktivasi = $1
              AND tanggal = CURRENT_DATE
              AND status != 'completed'
            LIMIT 1
        `, [kode.trim().toUpperCase()]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Kode tidak ditemukan atau booking sudah selesai"
            });
        }

        const booking = result.rows[0];
        const now     = new Date().toTimeString().slice(0, 5);

        if (now < booking.jam_mulai) {
            return res.status(400).json({
                error: `Booking belum waktunya. Jadwal mulai: ${booking.jam_mulai}`
            });
        }

        pushCommand(`ON${booking.meja_id}`);

        await db.query(
            "UPDATE meja_billiard SET status_lampu = TRUE WHERE id = $1",
            [booking.meja_id]
        );
        await db.query(
            "UPDATE bookings SET status = 'active' WHERE id = $1",
            [booking.id]
        );

        lastShake[booking.meja_id] = Date.now();

        log(`🔑 AKTIVASI → ${kode} | Meja ${booking.meja_id} ON`);

        res.json({
            message: `✅ Lampu Meja ${booking.meja_id} berhasil dinyalakan!`,
            meja_id:    booking.meja_id,
            nama:       booking.nama,
            jam_selesai: booking.jam_selesai
        });

    } catch (err) {
        log("❌ Aktivasi error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API — STATUS LAMPU
// ======================================================
app.get("/api/lampu/status", async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API — STATUS MEJA
// ======================================================
app.get("/api/status-meja", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                m.id,
                m.nama_meja,
                m.status_lampu,
                COALESCE(
                    (SELECT status FROM bookings
                     WHERE meja_id = m.id
                       AND tanggal = CURRENT_DATE
                       AND status = 'active'
                     LIMIT 1),
                    'idle'
                ) AS status_booking
            FROM meja_billiard m
            ORDER BY m.id ASC
        `);
        res.json(result.rows);
    } catch (err) {
        log("❌ status-meja error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API — RESET MEJA
// ======================================================
app.post("/api/reset-meja", async (req, res) => {
    try {
        await db.query("UPDATE meja_billiard SET status_lampu = FALSE");
        await db.query(`
            UPDATE bookings SET status = 'completed'
            WHERE tanggal = CURRENT_DATE
        `);
        commandQueue[1] = "OFF1";
        commandQueue[2] = "OFF2";
        log("♻ RESET MEJA → Semua lampu OFF");
        res.json({ message: "Berhasil reset semua meja!" });
    } catch (err) {
        log("❌ RESET ERROR: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// GLOBAL LAMPU CONTROL (Admin)
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const { action } = req.body;
        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({ error: "Action harus ON atau OFF" });
        }
        const status = action === "ON";
        await db.query("UPDATE meja_billiard SET status_lampu = $1", [status]);
        commandQueue[1] = `${action}1`;
        commandQueue[2] = `${action}2`;
        log(`💡 GLOBAL ${action} → Semua meja`);
        res.json({ message: `Semua lampu ${action}` });
    } catch (err) {
        log("❌ Global control error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// SENSOR GETAR
// ======================================================
let lastShake         = { 1: Date.now(), 2: Date.now() };
const SHAKE_TIMEOUT_MS = 15 * 60 * 1000; // 15 menit

app.post("/api/shake", async (req, res) => {
    try {
        const { meja_id } = req.body;
        if (!meja_id || ![1, 2].includes(Number(meja_id))) {
            return res.status(400).json({ error: "meja_id tidak valid" });
        }
        lastShake[meja_id] = Date.now();
        log("🔔 GETAR → Meja " + meja_id);
        pushCommand(`ON${meja_id}`);
        await db.query("UPDATE meja_billiard SET status_lampu = TRUE WHERE id = $1", [meja_id]);
        return res.json({ message: "Shake recorded" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// MANUAL CONTROL
// ======================================================
app.post("/api/manual-control", async (req, res) => {
    try {
        const { meja_id, action } = req.body;
        const status = action === "ON";
        await db.query(
            "UPDATE meja_billiard SET status_lampu = $1 WHERE id = $2",
            [status, meja_id]
        );
        pushCommand(`${action}${meja_id}`);
        log(`💡 MANUAL → Meja ${meja_id} ${action}`);
        res.json({ message: `Lampu meja ${meja_id} ${action}` });
    } catch (err) {
        log("❌ Manual error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ESP COMMAND FETCHER
// ======================================================
app.get("/api/esp-command", (req, res) => {
    try {
        const meja = parseInt(req.query.meja || "0");
        const cmd  = commandQueue[meja] || "";
        if (cmd) {
            log(`📤 SEND → ${cmd}`);
            commandQueue[meja] = "";
            return res.send(cmd);
        }
        return res.send("");
    } catch (err) {
        log("❌ ESP COMMAND ERROR: " + err);
        res.send("");
    }
});

// ======================================================
// CRON — BOOKING AUTO ON/OFF (setiap menit)
// ======================================================
cron.schedule("* * * * *", async () => {
    try {
        const now = new Date();
        const t   = now.toTimeString().slice(0, 5);
        const d   = now.toISOString().slice(0, 10);

        log(`⏱ CRON CHECK → ${d} ${t}`);

        const mejaList = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");

        for (const meja of mejaList.rows) {
            const bks = await db.query(`
                SELECT * FROM bookings
                WHERE meja_id = $1 AND tanggal = $2 AND status != 'completed'
            `, [meja.id, d]);

            let aktif    = false;
            let activeId = null;

            for (const b of bks.rows) {
                const start  = b.jam_mulai;
                const end    = b.jam_selesai;
                const active = start < end
                    ? (t >= start && t < end)
                    : (t >= start || t < end);

                if (active) { aktif = true; activeId = b.id; break; }
            }

            if (aktif) {
                pushCommand(`ON${meja.id}`);
                await db.query("UPDATE meja_billiard SET status_lampu = TRUE  WHERE id = $1", [meja.id]);
                await db.query("UPDATE bookings SET status = 'active'    WHERE id = $1", [activeId]);
                log(`💡 AUTO ON → Meja ${meja.id}`);
            } else {
                pushCommand(`OFF${meja.id}`);
                await db.query("UPDATE meja_billiard SET status_lampu = FALSE WHERE id = $1", [meja.id]);
                await db.query(`
                    UPDATE bookings SET status = 'completed'
                    WHERE meja_id = $1 AND tanggal = $2 AND jam_selesai <= $3
                `, [meja.id, d, t]);
                log(`⚫ AUTO OFF → Meja ${meja.id}`);
            }
        }
    } catch (err) {
        log("❌ CRON ERROR: " + err);
    }
});

// ======================================================
// CRON SENSOR — Auto OFF 15 menit tidak ada getaran
// ======================================================
cron.schedule("* * * * * *", async () => {
    const now = Date.now();
    for (let meja = 1; meja <= 2; meja++) {
        if ((now - lastShake[meja]) > SHAKE_TIMEOUT_MS) {
            try {
                const t = new Date().toTimeString().slice(0, 5);
                const d = new Date().toISOString().slice(0, 10);

                const bks = await db.query(`
                    SELECT id FROM bookings
                    WHERE meja_id = $1 AND tanggal = $2
                      AND status = 'active'
                      AND jam_mulai <= $3 AND jam_selesai > $3
                    LIMIT 1
                `, [meja, d, t]);

                if (bks.rows.length > 0) {
                    log(`⚫ TIMEOUT 15 MENIT → Meja ${meja} (customer belum datang)`);
                    pushCommand(`OFF${meja}`);
                    await db.query(
                        "UPDATE meja_billiard SET status_lampu = FALSE WHERE id = $1",
                        [meja]
                    );
                    // Status booking tetap 'active' agar bisa aktivasi pakai kode
                }
                lastShake[meja] = now;
            } catch (err) {
                log("❌ SENSOR CRON ERROR: " + err);
            }
        }
    }
});
// ======================================================
// API — STATISTIK BOOKING
// ======================================================
app.get("/api/statistik", async (req, res) => {
    try {
        const days = parseInt(req.query.days || "30");

        const result = await db.query(`
            SELECT
                gs.tanggal::date AS tanggal,
                COALESCE(COUNT(b.id), 0)   AS total_booking,
                COALESCE(SUM(b.durasi), 0) AS total_jam
            FROM generate_series(
                CURRENT_DATE - INTERVAL '1 day' * ($1 - 1),
                CURRENT_DATE,
                INTERVAL '1 day'
            ) AS gs(tanggal)
            LEFT JOIN bookings b
                ON b.tanggal = gs.tanggal::date
            GROUP BY gs.tanggal
            ORDER BY gs.tanggal ASC
        `, [days]);

        res.json(result.rows);
    } catch (err) {
        log("❌ Statistik error: " + err);
        res.status(500).json({ error: err.message });
    }
});



// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => {
    log(`🚀 SERVER READY → http://localhost:${PORT}`);
});