//====================================================================
// SMART BILLIARD SERVER - FINAL (MIDNIGHT + RESET + SHAKE SENSOR + KODE AKTIVASI)
//====================================================================

const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// LOG SYSTEM
// ======================================================
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

process.on("uncaughtException", err => log("❌ Uncaught: " + err));
process.on("unhandledRejection", err => log("❌ Unhandled: " + err));

// ======================================================
// ADMIN AUTH
// ======================================================
const ADMIN = { username: "admin", password: "billiard123" };
let adminSessions = new Set();

function makeToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ✨ BARU — Generate kode aktivasi format: BIL-001-2025
function makeKodeAktivasi(bookingId) {
    const pad = String(bookingId).padStart(3, "0");
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
// ADMIN LOGIN API (FRONTEND COMPATIBLE)
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

// ======================================================
// ADMIN VERIFY TOKEN
// ======================================================
app.post("/api/admin/verify", (req, res) => {
    const { token } = req.body;
    if (adminSessions.has(token)) return res.json({ valid: true });
    res.status(401).json({ error: "Token tidak valid" });
});

// ======================================================
// MYSQL CONNECTION
// ======================================================
let db;

async function initDB() {
    db = await mysql.createPool({
        host: process.env.DB_HOST || "localhost",
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_DATABASE || "billiard_booking",
        connectionLimit: 20
    });

    log("✅ MySQL Connected (POOL)");

    // ✨ BARU — Auto-migrate: tambah kolom kode_aktivasi kalau belum ada
    try {
        await db.query(`
            ALTER TABLE bookings 
            ADD COLUMN IF NOT EXISTS kode_aktivasi VARCHAR(20) DEFAULT NULL
        `);
        log("✅ Kolom kode_aktivasi siap");
    } catch (e) {
        log("ℹ️ kode_aktivasi: " + e.message);
    }
}
initDB();

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
// API — BOOKINGS
// ======================================================
app.get("/api/bookings", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT * FROM bookings
            WHERE tanggal = CURDATE()
            ORDER BY jam_mulai ASC
        `);
        res.json(rows);
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

        const start = new Date(`1970-01-01T${jam_mulai}:00`);
        const end = new Date(start.getTime() + durasi * 3600000);
        const jam_selesai = end.toTimeString().slice(0, 5);

        const [result] = await db.query(
            `INSERT INTO bookings (nama, meja_id, jam_mulai, jam_selesai, tanggal, durasi)
             VALUES (?, ?, ?, ?, CURDATE(), ?)`,
            [nama, meja_id, jam_mulai, jam_selesai, durasi]
        );

        // ✨ BARU — Generate dan simpan kode aktivasi
        const bookingId = result.insertId;
        const kodeAktivasi = makeKodeAktivasi(bookingId);

        await db.query(
            `UPDATE bookings SET kode_aktivasi = ? WHERE id = ?`,
            [kodeAktivasi, bookingId]
        );

        log(`📅 Booking → Meja ${meja_id} (${jam_mulai} - ${jam_selesai}) | Kode: ${kodeAktivasi}`);

        // ✨ BARU — Response sekarang include data lengkap untuk struk
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
// ✨ BARU — API AKTIVASI KODE (Customer Telat)
// ======================================================
app.post("/api/aktivasi", async (req, res) => {
    try {
        const { kode } = req.body;

        if (!kode) return res.status(400).json({ error: "Kode tidak boleh kosong" });

        // Cari booking berdasarkan kode hari ini yang belum selesai
        const [rows] = await db.query(`
            SELECT * FROM bookings
            WHERE kode_aktivasi = ?
              AND tanggal = CURDATE()
              AND status != 'completed'
            LIMIT 1
        `, [kode.trim().toUpperCase()]);

        if (!rows.length) {
            return res.status(404).json({
                error: "Kode tidak ditemukan atau booking sudah selesai"
            });
        }

        const booking = rows[0];
        const now = new Date().toTimeString().slice(0, 5);

        // Cek apakah sudah melewati jam mulai
        if (now < booking.jam_mulai) {
            return res.status(400).json({
                error: `Booking belum waktunya. Jadwal mulai: ${booking.jam_mulai}`
            });
        }

        // Nyalakan lampu meja
        pushCommand(`ON${booking.meja_id}`);
        await db.query(
            "UPDATE meja_billiard SET status_lampu = 1 WHERE id = ?",
            [booking.meja_id]
        );
        await db.query(
            "UPDATE bookings SET status = 'active' WHERE id = ?",
            [booking.id]
        );

        // Reset timer sensor agar tidak langsung auto-off lagi
        lastShake[booking.meja_id] = Date.now();

        log(`🔑 AKTIVASI KODE → ${kode} | Meja ${booking.meja_id} ON`);

        res.json({
            message: `✅ Lampu Meja ${booking.meja_id} berhasil dinyalakan!`,
            meja_id: booking.meja_id,
            nama: booking.nama,
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
        const [rows] = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API — STATUS MEJA
// ======================================================
app.get("/api/status-meja", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT 
                m.id,
                m.nama_meja,
                m.status_lampu,
                COALESCE(
                    (SELECT status FROM bookings 
                     WHERE meja_id = m.id
                     AND tanggal = CURDATE()
                     AND status = 'active'
                     LIMIT 1),
                    'idle'
                ) AS status_booking
            FROM meja_billiard m
            ORDER BY m.id ASC
        `);

        res.json(rows);

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
        await db.query("UPDATE meja_billiard SET status_lampu = 0");

        await db.query(`
            UPDATE bookings 
            SET status = 'completed'
            WHERE tanggal = CURDATE()
        `);

        commandQueue[1] = "OFF1";
        commandQueue[2] = "OFF2";

        log("♻ RESET MEJA → Semua lampu OFF, booking completed");
        res.json({ message: "Berhasil reset semua meja!" });

    } catch (err) {
        log("❌ RESET ERROR: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ✨ BARU — GLOBAL LAMPU CONTROL (endpoint yang tadinya hilang)
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const { action } = req.body;

        if (!["ON", "OFF"].includes(action)) {
            return res.status(400).json({ error: "Action harus ON atau OFF" });
        }

        const status = action === "ON" ? 1 : 0;
        await db.query("UPDATE meja_billiard SET status_lampu = ?", [status]);

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
// SENSOR GETAR API
// ======================================================
let lastShake = { 1: Date.now(), 2: Date.now() };

// ✨ BARU — Timeout diubah ke 15 menit (dari 60 detik)
const SHAKE_TIMEOUT_MS = 15 * 60 * 1000;

app.post("/api/shake", async (req, res) => {
    try {
        const { meja_id } = req.body;

        if (!meja_id || ![1, 2].includes(meja_id)) {
            return res.status(400).json({ error: "meja_id tidak valid" });
        }

        lastShake[meja_id] = Date.now();
        log("🔔 GETAR TERDETEKSI → Meja " + meja_id);

        pushCommand(`ON${meja_id}`);
        await db.query("UPDATE meja_billiard SET status_lampu=1 WHERE id=?", [meja_id]);

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

        const status = action === "ON" ? 1 : 0;

        await db.query("UPDATE meja_billiard SET status_lampu=? WHERE id=?", [
            status, meja_id,
        ]);

        pushCommand(`${action}${meja_id}`);

        log(`💡 MANUAL → Meja ${meja_id} ${action}`);
        res.json({ message: `Lampu meja ${meja_id} ${action}` });

    } catch (err) {
        log("❌ Manual meja error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ESP COMMAND FETCHER
// ======================================================
app.get("/api/esp-command", (req, res) => {
    try {
        const meja = parseInt(req.query.meja || "0");
        const cmd = commandQueue[meja] || "";

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
        const t = now.toTimeString().slice(0, 5);
        const d = now.toISOString().slice(0, 10);

        log(`⏱ CRON CHECK → ${d} ${t}`);

        const [mejaList] = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");

        for (const meja of mejaList) {

            const [bks] = await db.query(
                `SELECT * FROM bookings 
                 WHERE meja_id=? AND tanggal=? AND status!='completed'`,
                [meja.id, d]
            );

            let aktif = false;
            let activeId = null;

            for (const b of bks) {
                const start = b.jam_mulai;
                const end = b.jam_selesai;

                let active =
                    start < end
                        ? (t >= start && t < end)
                        : (t >= start || t < end);

                if (active) {
                    aktif = true;
                    activeId = b.id;
                    break;
                }
            }

            if (aktif) {
                pushCommand(`ON${meja.id}`);
                await db.query("UPDATE meja_billiard SET status_lampu=1 WHERE id=?", [meja.id]);
                await db.query("UPDATE bookings SET status='active' WHERE id=?", [activeId]);
                log(`💡 AUTO ON → Meja ${meja.id}`);
            } else {
                pushCommand(`OFF${meja.id}`);
                await db.query("UPDATE meja_billiard SET status_lampu=0 WHERE id=?", [meja.id]);

                await db.query(
                    `UPDATE bookings SET status='completed'
                     WHERE meja_id=? AND tanggal=? AND jam_selesai <= ?`,
                    [meja.id, d, t]
                );

                log(`⚫ AUTO OFF → Meja ${meja.id}`);
            }
        }

    } catch (err) {
        log("❌ CRON ERROR: " + err);
    }
});

// ======================================================
// ✨ CRON SENSOR GETAR — Auto OFF jika 15 menit tidak ada getaran
// Berlaku saat ada booking aktif → customer diasumsikan belum datang
// Customer bisa nyalakan lagi pakai kode aktivasi dari struk
// ======================================================
cron.schedule("* * * * * *", async () => {
    const now = Date.now();

    for (let meja = 1; meja <= 2; meja++) {
        const diff = now - lastShake[meja];

        if (diff > SHAKE_TIMEOUT_MS) {
            try {
                const t = new Date().toTimeString().slice(0, 5);
                const d = new Date().toISOString().slice(0, 10);

                // Hanya matikan kalau ada booking aktif
                const [bks] = await db.query(`
                    SELECT id FROM bookings
                    WHERE meja_id = ? AND tanggal = ?
                      AND status = 'active'
                      AND jam_mulai <= ? AND jam_selesai > ?
                    LIMIT 1
                `, [meja, d, t, t]);

                if (bks.length > 0) {
                    log(`⚫ TIMEOUT 15 MENIT → Meja ${meja} (customer belum datang, gunakan kode aktivasi)`);
                    pushCommand(`OFF${meja}`);
                    await db.query(
                        "UPDATE meja_billiard SET status_lampu=0 WHERE id=?",
                        [meja]
                    );
                    // Status booking TETAP 'active' agar bisa aktivasi pakai kode
                }

                lastShake[meja] = now;

            } catch (err) {
                log("❌ SENSOR CRON ERROR: " + err);
            }
        }
    }
});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => {
    log(`🚀 SERVER READY → http://localhost:${PORT}`);
});