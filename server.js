//====================================================================
 //SMART BILLIARD SERVER - FINAL MIDNIGHT + RESET MEJA FIX (2025)
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

function requireAdmin(req, res, next) {
    const token = req.headers["authorization"];
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

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

        log(`📅 Booking → Meja ${meja_id} (${jam_mulai} - ${jam_selesai})`);
        res.json({ message: "Booking berhasil!", booking_id: result.insertId });

    } catch (err) {
        log("❌ Add booking: " + err);
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
// API — STATUS MEJA (RESET FIX)
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
                     ORDER BY jam_mulai ASC LIMIT 1),
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
// API — RESET MEJA (FIX 100% WORKING)
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
// ADMIN LOGIN
// ======================================================
app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN.username && password === ADMIN.password) {
        const token = makeToken();
        adminSessions.add(token);
        log(`🔐 ADMIN LOGIN → ${username}`);
        return res.json({ message: "Login berhasil", token });
    }
    res.status(401).json({ error: "Username atau password salah" });
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
// GLOBAL CONTROL
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const { action } = req.body;
        const status = action === "ON" ? 1 : 0;

        await db.query("UPDATE meja_billiard SET status_lampu=?", [status]);

        pushCommand(`${action}1`);
        pushCommand(`${action}2`);

        log(`🧠 GLOBAL CONTROL → ${action}`);
        res.json({ message: `Semua lampu ${action}` });

    } catch (err) {
        log("❌ Global control error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ESP COMMAND
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
// CRON JOB — AUTO LAMPU (MIDNIGHT OK)
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
                        : (t >= start || t < end); // lewat tengah malam

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
// START SERVER
// ======================================================
app.listen(PORT, () => {
    log(`🚀 SERVER READY → http://localhost:${PORT}`);
});
