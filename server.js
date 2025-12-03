// ======================================================
//  SMART BILLIARD SERVER - FINAL BOSSSS
// ======================================================

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
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    console.log(line.trim());
    fs.appendFileSync("./logs/server.log", line, "utf8");
}

if (!fs.existsSync("logs")) fs.mkdirSync("logs");

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
        connectionLimit: 15,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    });

    log("✅ MySQL Connected (POOL MODE)");
}
initDB();

// ======================================================
// ESP COMMAND QUEUE (FINAL)
// ======================================================
let commandQueue = {
    1: "",
    2: ""
};

function pushCommand(cmd) {
    const meja = Number(cmd.replace(/\D/g, ""));
    if (meja === 1 || meja === 2) {
        commandQueue[meja] = cmd;
        log(`📡 QUEUE → ${cmd}`);
    }
}

// ======================================================
// API - BOOKINGS
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

        const sql = `
            INSERT INTO bookings (nama, meja_id, jam_mulai, jam_selesai, tanggal, durasi)
            VALUES (?, ?, ?, ?, CURDATE(), ?)
        `;

        const [result] = await db.query(sql, [
            nama, meja_id, jam_mulai, jam_selesai, durasi
        ]);

        log(`📅 Booking → Meja ${meja_id} (${jam_mulai}-${jam_selesai})`);

        res.json({ message: "Booking berhasil!", booking_id: result.insertId });

    } catch (err) {
        log("❌ Add booking: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// API - STATUS LAMPU
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
// ADMIN LOGIN
// ======================================================
app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN.username && password === ADMIN.password) {
        const token = makeToken();
        adminSessions.add(token);
        log(`🔐 ADMIN LOGIN → ${username}`);
        return res.json({ message: "Login berhasil", token, username });
    }

    res.status(401).json({ error: "Username atau password salah" });
});

app.post("/api/admin/logout", (req, res) => {
    const { token } = req.body;
    if (token) adminSessions.delete(token);
    res.json({ message: "Logout berhasil" });
});

// ======================================================
// MANUAL GLOBAL CONTROL
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req, res) => {
    try {
        const { action } = req.body;

        if (!["ON", "OFF"].includes(action))
            return res.status(400).json({ error: "Invalid action" });

        const status = action === "ON" ? 1 : 0;

        await db.query("UPDATE meja_billiard SET status_lampu = ?", [status]);

        // Kirim per meja
        pushCommand(`${action}1`);
        pushCommand(`${action}2`);

        log(`🧠 GLOBAL CONTROL → ${action}`);

        res.json({ message: `Semua lampu ${action}` });
    } catch (err) {
        log("❌ Manual global error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// MANUAL PER MEJA
// ======================================================
app.post("/api/manual-control", async (req, res) => {
    try {
        const { meja_id, action } = req.body;

        if (!meja_id || !action)
            return res.status(400).json({ error: "Data tidak lengkap" });

        const status = action === "ON" ? 1 : 0;

        await db.query("UPDATE meja_billiard SET status_lampu = ? WHERE id = ?", [
            status, meja_id
        ]);

        pushCommand(`${action}${meja_id}`);

        log(`💡 MANUAL → Meja ${meja_id} ${action}`);

        res.json({ message: `Lampu Meja ${meja_id} ${action}` });

    } catch (err) {
        log("❌ Manual meja error: " + err);
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// ESP COMMAND — FINAL STABLE VERSION
// ======================================================
app.get("/api/esp-command", (req, res) => {
    try {
        const meja = parseInt(req.query.meja || "0");

        if (!meja) {
            log("⚠ ESP mengakses tanpa parameter meja");
            return res.send("");
        }

        const cmd = commandQueue[meja] || "";

        log(`🔎 ESP CHECK → meja ${meja}, command: "${cmd}"`);

        if (cmd.startsWith("ON") || cmd.startsWith("OFF")) {
            log(`📤 SEND TO ESP → ${cmd}`);

            setTimeout(() => {
                if (commandQueue[meja] === cmd) {
                    log(`♻ CLEAR COMMAND → ${cmd}`);
                    commandQueue[meja] = "";
                }
            }, 200);

            return res.send(cmd);
        }

        return res.send("");

    } catch (err) {
        log("❌ ESP COMMAND ERROR: " + err);
        return res.send("");
    }
});

// ======================================================
// ESP HEARTBEAT
// ======================================================
app.post("/api/esp-heartbeat", (req, res) => {
    const { status, ip } = req.body;
    log(`💓 HEARTBEAT → ${status} (${ip})`);
    res.json({ message: "OK" });
});

// ======================================================
// CRON JOB — SETIAP 1 MENIT
// ======================================================
cron.schedule("* * * * *", async () => {
    try {
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5);
        const currentDate = now.toISOString().slice(0, 10);

        log(`⏱ CRON CHECK → ${currentDate} ${currentTime}`);

        const [mejaList] = await db.query("SELECT * FROM meja_billiard ORDER BY id ASC");

        for (const meja of mejaList) {
            const [booking] = await db.query(
                `SELECT * FROM bookings
                 WHERE tanggal = ?
                 AND meja_id = ?
                 AND jam_mulai <= ?
                 AND jam_selesai > ?
                 AND status != 'completed'`,
                [currentDate, meja.id, currentTime, currentTime]
            );

            if (booking.length > 0) {
                log(`💡 AUTO ON → Meja ${meja.id}`);

                pushCommand(`ON${meja.id}`);

                await db.query(`UPDATE meja_billiard SET status_lampu = 1 WHERE id=?`, [meja.id]);

                for (const b of booking) {
                    await db.query(`UPDATE bookings SET status='active' WHERE id=?`, [b.id]);
                }

            } else {
                log(`⚫ AUTO OFF → Meja ${meja.id}`);

                pushCommand(`OFF${meja.id}`);

                await db.query(`UPDATE meja_billiard SET status_lampu = 0 WHERE id=?`, [meja.id]);

                await db.query(
                    `UPDATE bookings SET status='completed'
                     WHERE meja_id=? AND tanggal=? AND jam_selesai <= ?`,
                    [meja.id, currentDate, currentTime]
                );
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
    log(`🔐 ADMIN → admin / billiard123`);
});
