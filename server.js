const express = require("express");
const { Pool } = require("pg");
const cors    = require("cors");
const cron    = require("node-cron");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// LOG
// ======================================================
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

process.on("uncaughtException",  err => log("❌ Uncaught    : " + err));
process.on("unhandledRejection", err => log("❌ Unhandled   : " + err));

// ======================================================
// ADMIN CREDENTIALS
// ======================================================
const ADMIN = {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "billiard123"
};

// ======================================================
// GENERATE TOKEN
// ======================================================
function makeToken() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// ======================================================
// GENERATE KODE AKTIVASI — Format: BIL-001-2025
// ======================================================
function makeKodeAktivasi(bookingId) {
    const pad  = String(bookingId).padStart(3, "0");
    const year = new Date().getFullYear();
    return `BIL-${pad}-${year}`;
}

// ======================================================
// POSTGRESQL CONNECTION
// ======================================================
const db = new Pool({
    host:     process.env.DB_HOST     || "localhost",
    port:     process.env.DB_PORT     || 5432,
    user:     process.env.DB_USER     || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "billiard_booking"
});

db.connect()
    .then(async client => {
        log("✅ PostgreSQL Connected");
        client.release();

        // Auto-migrate: buat tabel admin_sessions kalau belum ada
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_sessions (
                id SERIAL PRIMARY KEY,
                token VARCHAR(100) NOT NULL UNIQUE,
                username VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        log("✅ Tabel admin_sessions siap");

        // Auto-migrate kolom status_bayar & total_harga
        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS status_bayar VARCHAR(20) DEFAULT 'belum'
        `).catch(() => {});
        await db.query(`
            ALTER TABLE bookings
            ADD COLUMN IF NOT EXISTS total_harga INTEGER DEFAULT 0
        `).catch(() => {});
        log("✅ Kolom status_bayar & total_harga siap");
    })
    .catch(err => {
        log("❌ PostgreSQL Failed : " + err.message);
    });

// ======================================================
// AUTH MIDDLEWARE — Token dicek ke database
// ======================================================
async function requireAdmin(req, res, next) {
    const token = req.headers["authorization"] || req.headers["Authorization"];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        const result = await db.query(
            "SELECT id FROM admin_sessions WHERE token=$1 LIMIT 1",
            [token]
        );
        if (!result.rows.length) return res.status(401).json({ error: "Unauthorized" });
        next();
    } catch (err) {
        log("❌ requireAdmin : " + err);
        return res.status(500).json({ error: "Server Error" });
    }
}

// ======================================================
// ESP COMMAND QUEUE
// ======================================================
let commandQueue = { 1: "", 2: "" };

function pushCommand(cmd) {
    if (!cmd) return;
    const meja = Number(cmd.replace(/\D/g, ""));
    if (meja !== 1 && meja !== 2) return;
    commandQueue[meja] = cmd;
    log(`📡 QUEUE -> ${cmd}`);
}

// ======================================================
// STATE VARIABLES
// ======================================================

// Mode manual: true = cron tidak override lampu
let manualMode = { 1: false, 2: false };

// Sensor timeout: true = lampu dimatikan sensor, tunggu aktivasi kode
let sensorTimeout = { 1: false, 2: false };

// Waktu terakhir ada getaran
let lastShake = { 1: Date.now(), 2: Date.now() };

// Timeout sensor (25 detik untuk demo, 15 menit untuk produksi)
// Untuk produksi ganti ke: 15 * 60 * 1000
const SHAKE_TIMEOUT_MS = 25 * 1000;

// ======================================================
// ADMIN LOGIN
// ======================================================
app.post("/api/admin/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (username !== ADMIN.username || password !== ADMIN.password) {
            log("❌ ADMIN LOGIN FAILED");
            return res.status(401).json({ error: "Username atau Password salah" });
        }

        const token = makeToken();

        await db.query(
            "INSERT INTO admin_sessions(token, username) VALUES($1,$2)",
            [token, username]
        );

        log("🔐 ADMIN LOGIN SUCCESS");
        return res.json({ token, username });

    } catch (err) {
        log("❌ Login Error : " + err);
        return res.status(500).json({ error: "Server Error" });
    }
});

// ======================================================
// VERIFY TOKEN
// ======================================================
app.post("/api/admin/verify", async (req, res) => {
    try {
        const { token } = req.body;
        const result = await db.query(
            "SELECT id FROM admin_sessions WHERE token=$1 LIMIT 1",
            [token]
        );
        return res.json({ valid: result.rows.length > 0 });
    } catch (err) {
        log("❌ Verify Error : " + err);
        return res.status(500).json({ valid: false });
    }
});

// ======================================================
// GET BOOKINGS HARI INI
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
        log("❌ Load Booking : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// TAMBAH BOOKING
// ======================================================
app.post("/api/booking", async (req, res) => {
    try {
        const { nama, jam_mulai, durasi, meja_id } = req.body;

        if (!nama || !jam_mulai || !durasi || !meja_id) {
            return res.status(400).json({ error: "Semua field wajib diisi." });
        }
        if (durasi <= 0) {
            return res.status(400).json({ error: "Durasi tidak valid." });
        }

        // Hitung jam selesai
        const start       = new Date(`1970-01-01T${jam_mulai}:00`);
        const end         = new Date(start.getTime() + durasi * 3600000);
        const jam_selesai = end.toTimeString().slice(0, 5);

        // Total harga
        const totalHarga = durasi * 30000;

        // Insert booking
        const insert = await db.query(`
            INSERT INTO bookings
                (nama, meja_id, jam_mulai, jam_selesai, tanggal, durasi, status_bayar, total_harga)
            VALUES
                ($1, $2, $3, $4, CURRENT_DATE, $5, 'belum', $6)
            RETURNING id
        `, [nama, meja_id, jam_mulai, jam_selesai, durasi, totalHarga]);

        const bookingId    = insert.rows[0].id;
        const kodeAktivasi = makeKodeAktivasi(bookingId);

        await db.query(
            "UPDATE bookings SET kode_aktivasi=$1 WHERE id=$2",
            [kodeAktivasi, bookingId]
        );

        // FIX: Reset sensor timeout untuk meja ini saat ada booking baru
        sensorTimeout[meja_id] = false;

        log(`📅 BOOKING -> Meja ${meja_id} | ${jam_mulai}-${jam_selesai} | Kode: ${kodeAktivasi}`);

        res.json({
            success:       true,
            booking_id:    bookingId,
            kode_aktivasi: kodeAktivasi,
            nama,
            meja_id,
            jam_mulai,
            jam_selesai,
            durasi,
            total_harga:   totalHarga
        });

    } catch (err) {
        log("❌ Booking Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// AKTIVASI KODE (Customer Telat)
// ======================================================
app.post("/api/aktivasi", async (req, res) => {
    try {
        const { kode } = req.body;

        if (!kode) {
            return res.status(400).json({ error: "Kode aktivasi tidak boleh kosong." });
        }

        const result = await db.query(`
            SELECT * FROM bookings
            WHERE kode_aktivasi = $1
              AND tanggal = CURRENT_DATE
              AND status != 'completed'
            LIMIT 1
        `, [kode.trim().toUpperCase()]);

        if (!result.rows.length) {
            return res.status(404).json({ error: "Kode tidak ditemukan atau booking telah selesai." });
        }

        const booking = result.rows[0];
        const now     = new Date().toTimeString().slice(0, 5);

        if (now < booking.jam_mulai) {
            return res.status(400).json({ error: `Booking dimulai pukul ${booking.jam_mulai}` });
        }

        // FIX: Reset sensorTimeout dan manualMode saat aktivasi kode
        sensorTimeout[booking.meja_id] = false;
        manualMode[booking.meja_id]    = false;

        // Reset timer sensor agar 25 detik/15 menit dihitung ulang
        lastShake[booking.meja_id] = Date.now();

        pushCommand(`ON${booking.meja_id}`);

        await db.query(
            "UPDATE meja_billiard SET status_lampu=TRUE WHERE id=$1",
            [booking.meja_id]
        );
        await db.query(
            "UPDATE bookings SET status='active' WHERE id=$1",
            [booking.id]
        );

        log(`🔑 AKTIVASI -> ${kode} | Meja ${booking.meja_id}`);

        res.json({
            success:     true,
            meja_id:     booking.meja_id,
            nama:        booking.nama,
            jam_selesai: booking.jam_selesai,
            message:     `Lampu Meja ${booking.meja_id} berhasil dinyalakan`
        });

    } catch (err) {
        log("❌ Aktivasi Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// STATUS LAMPU
// ======================================================
app.get("/api/lampu/status", async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");
        res.json(result.rows);
    } catch (err) {
        log("❌ Status Lampu : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// STATUS MEJA
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
                     WHERE meja_id=m.id AND tanggal=CURRENT_DATE AND status='active'
                     LIMIT 1),
                    'idle'
                ) AS status_booking
            FROM meja_billiard m
            ORDER BY m.id ASC
        `);
        res.json(result.rows);
    } catch (err) {
        log("❌ Status Meja : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// RESET MEJA
// ======================================================
app.post("/api/reset-meja", requireAdmin, async (req, res) => {
    try {
        // Reset semua state
        manualMode    = { 1: false, 2: false };
        sensorTimeout = { 1: false, 2: false };
        lastShake     = { 1: Date.now(), 2: Date.now() };

        await db.query("UPDATE meja_billiard SET status_lampu=FALSE");
        await db.query(`
            UPDATE bookings SET status='completed'
            WHERE tanggal=CURRENT_DATE
        `);

        pushCommand("OFF1");
        pushCommand("OFF2");

        log("♻ RESET SEMUA MEJA");
        res.json({ success: true, message: "Reset berhasil." });

    } catch (err) {
        log("❌ Reset Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// GLOBAL CONTROL
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const { action } = req.body;

        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({ error: "Action harus ON/OFF" });
        }

        const status = action === "ON";

        manualMode[1] = status;
        manualMode[2] = status;

        await db.query("UPDATE meja_billiard SET status_lampu=$1", [status]);

        pushCommand(`${action}1`);
        pushCommand(`${action}2`);

        log(`💡 GLOBAL ${action}`);
        res.json({ success: true, message: `Semua lampu ${action}` });

    } catch (err) {
        log("❌ Global Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// SENSOR GETAR
// reset_only=true  → hanya reset timer, lampu tidak berubah
// reset_only=false → reset timer + nyalain lampu
// ======================================================
app.post("/api/shake", async (req, res) => {
    try {
        const { meja_id, reset_only } = req.body;

        if (![1, 2].includes(Number(meja_id))) {
            return res.status(400).json({ error: "Meja tidak valid" });
        }

        // FIX: Selalu update lastShake saat ada getaran
        lastShake[meja_id] = Date.now();

        // FIX: Reset sensorTimeout saat ada aktivitas
        // Ini penting agar cron booking bisa nyalain lampu lagi
        sensorTimeout[meja_id] = false;

        log(`🔔 SENSOR -> Meja ${meja_id} | reset_only=${reset_only}`);

        if (!reset_only) {
            // Mode lama: nyalain lampu + reset timer
            manualMode[meja_id] = false;
            pushCommand(`ON${meja_id}`);
            await db.query(
                "UPDATE meja_billiard SET status_lampu=TRUE WHERE id=$1",
                [meja_id]
            );
            log(`💡 Lampu ON -> Meja ${meja_id}`);
        } else {
            // Mode baru: HANYA reset timer, lampu tidak berubah
            log(`⏱ Timer Reset -> Meja ${meja_id} (lampu tidak berubah)`);
        }

        res.json({ success: true });

    } catch (err) {
        log("❌ Shake Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// MANUAL CONTROL
// ======================================================
app.post("/api/manual-control", requireAdmin, async (req, res) => {
    try {
        const { meja_id, action } = req.body;

        if (![1, 2].includes(Number(meja_id))) {
            return res.status(400).json({ error: "Meja tidak valid" });
        }
        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({ error: "Action harus ON/OFF" });
        }

        const status = action === "ON";

        manualMode[meja_id] = status;

        await db.query(
            "UPDATE meja_billiard SET status_lampu=$1 WHERE id=$2",
            [status, meja_id]
        );

        pushCommand(`${action}${meja_id}`);

        log(`💡 MANUAL ${action} -> Meja ${meja_id}`);
        res.json({ success: true, message: `Lampu meja ${meja_id} ${action}` });

    } catch (err) {
        log("❌ Manual Error : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ESP32 COMMAND FETCHER
// ======================================================
app.get("/api/esp-command", (req, res) => {
    try {
        const meja = parseInt(req.query.meja || "0");
        const cmd  = commandQueue[meja] || "";

        if (cmd) {
            log(`📤 SEND -> ${cmd}`);
            commandQueue[meja] = "";
            return res.send(cmd);
        }

        return res.send("");
    } catch (err) {
        log("❌ ESP COMMAND : " + err);
        res.send("");
    }
});

// ======================================================
// CRON BOOKING — Cek tiap detik (demo)
// Produksi ganti ke: "* * * * *" (tiap menit)
// ======================================================
cron.schedule("* * * * * *", async () => {
    try {
        const now = new Date();
        const t   = now.toTimeString().slice(0, 5);
        const d   = now.toISOString().slice(0, 10);

        const mejaList = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");

        for (const meja of mejaList.rows) {

            // Skip jika mode manual aktif
            if (manualMode[meja.id]) continue;

            // FIX: Skip jika lampu dimatikan sensor
            // Tunggu customer input kode aktivasi
            if (sensorTimeout[meja.id]) continue;

            const booking = await db.query(`
                SELECT * FROM bookings
                WHERE meja_id=$1 AND tanggal=$2 AND status!='completed'
            `, [meja.id, d]);

            let aktif    = false;
            let activeId = null;

            for (const b of booking.rows) {
                const active = b.jam_mulai < b.jam_selesai
                    ? (t >= b.jam_mulai && t < b.jam_selesai)
                    : (t >= b.jam_mulai || t < b.jam_selesai);

                if (active) {
                    aktif    = true;
                    activeId = b.id;
                    break;
                }
            }

            if (aktif) {
                // FIX: Hanya nyalain dan reset timer saat lampu baru pertama menyala
                if (!meja.status_lampu) {
                    pushCommand(`ON${meja.id}`);

                    // FIX: Reset timer sensor saat booking mulai
                    lastShake[meja.id]     = Date.now();
                    sensorTimeout[meja.id] = false;

                    log(`🟢 AUTO ON -> Meja ${meja.id} | Timer sensor dimulai`);
                }

                await db.query(
                    "UPDATE meja_billiard SET status_lampu=TRUE WHERE id=$1",
                    [meja.id]
                );
                await db.query(
                    "UPDATE bookings SET status='active' WHERE id=$1",
                    [activeId]
                );

            } else {
                // Tidak ada booking aktif → matikan lampu
                if (meja.status_lampu) {
                    pushCommand(`OFF${meja.id}`);
                    log(`⚫ AUTO OFF -> Meja ${meja.id}`);
                }

                await db.query(
                    "UPDATE meja_billiard SET status_lampu=FALSE WHERE id=$1",
                    [meja.id]
                );
                await db.query(`
                    UPDATE bookings SET status='completed'
                    WHERE meja_id=$1 AND tanggal=$2 AND jam_selesai<=$3
                `, [meja.id, d, t]);

                // FIX: Reset sensorTimeout saat booking selesai
                sensorTimeout[meja.id] = false;
            }
        }

    } catch (err) {
        log("❌ CRON BOOKING : " + err);
    }
});

// ======================================================
// CRON SENSOR — Auto OFF jika tidak ada getaran
// FIX: Tidak reset lastShake setelah timeout
//      agar tidak langsung trigger ulang
// ======================================================
cron.schedule("* * * * * *", async () => {
    try {
        const now = Date.now();

        for (let meja = 1; meja <= 2; meja++) {

            // Skip jika mode manual aktif
            if (manualMode[meja]) continue;

            // Skip jika sudah timeout (sudah dimatikan)
            if (sensorTimeout[meja]) continue;

            // Cek apakah sudah melewati batas waktu
            if ((now - lastShake[meja]) > SHAKE_TIMEOUT_MS) {

                const t = new Date().toTimeString().slice(0, 5);
                const d = new Date().toISOString().slice(0, 10);

                // Cek apakah ada booking aktif
                const aktif = await db.query(`
                    SELECT id FROM bookings
                    WHERE meja_id=$1
                      AND tanggal=$2
                      AND status='active'
                      AND jam_mulai<=$3
                      AND jam_selesai>$3
                    LIMIT 1
                `, [meja, d, t]);

                if (aktif.rows.length) {

                    // Cek apakah lampu masih nyala
                    const lampu = await db.query(
                        "SELECT status_lampu FROM meja_billiard WHERE id=$1",
                        [meja]
                    );

                    if (lampu.rows[0].status_lampu) {

                        log(`⌛ SENSOR TIMEOUT -> Meja ${meja} | Tidak ada aktivitas ${SHAKE_TIMEOUT_MS/1000} detik`);

                        // FIX: Set sensorTimeout = true SEBELUM matiin lampu
                        // agar cron booking tidak langsung nyalain lagi
                        sensorTimeout[meja] = true;

                        pushCommand(`OFF${meja}`);

                        await db.query(
                            "UPDATE meja_billiard SET status_lampu=FALSE WHERE id=$1",
                            [meja]
                        );

                        log(`⚫ AUTO OFF SENSOR -> Meja ${meja} | Gunakan kode aktivasi untuk menyalakan`);

                        // FIX: TIDAK update lastShake di sini
                        // lastShake hanya diupdate saat ada getaran dari ESP32
                        // atau saat customer aktivasi kode
                    }
                }
            }
        }

    } catch (err) {
        log("❌ SENSOR CRON : " + err);
    }
});

// ======================================================
// STATISTIK BOOKING
// ======================================================
app.get("/api/statistik", async (req, res) => {
    try {
        const days = parseInt(req.query.days || 30);

        const result = await db.query(`
            SELECT
                gs.tanggal::date AS tanggal,
                COALESCE(COUNT(b.id), 0)   AS total_booking,
                COALESCE(SUM(b.durasi), 0) AS total_jam
            FROM generate_series(
                CURRENT_DATE - INTERVAL '1 day' * ($1-1),
                CURRENT_DATE,
                INTERVAL '1 day'
            ) AS gs(tanggal)
            LEFT JOIN bookings b ON b.tanggal = gs.tanggal::date
            GROUP BY gs.tanggal
            ORDER BY gs.tanggal
        `, [days]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// KONFIRMASI PEMBAYARAN
// ======================================================
app.post("/api/konfirmasi-bayar", requireAdmin, async (req, res) => {
    try {
        const { booking_id } = req.body;

        await db.query(
            "UPDATE bookings SET status_bayar='lunas' WHERE id=$1",
            [booking_id]
        );

        log(`💰 LUNAS -> Booking #${booking_id}`);
        res.json({ success: true, message: "Pembayaran dikonfirmasi!" });

    } catch (err) {
        log("❌ Konfirmasi Bayar : " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => {
    log("🚀 SERVER RUNNING");
    log(`🌐 http://localhost:${PORT}`);
    log(`⏱ Sensor timeout: ${SHAKE_TIMEOUT_MS/1000} detik`);
});