// ==================== DEPENDENCIES ====================
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== ADMIN CONFIG ====================
const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'billiard123'
};
let adminSessions = new Set();

// ==================== DATABASE CONNECTION ====================
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'billiard_booking'
});

db.connect(err => {
    if (err) {
        console.error('❌ Database connection failed:', err);
        process.exit(1);
    }
    console.log('✅ Connected to MySQL database');
});

// ==================== UTILITY FUNCTIONS ====================
function generateSessionToken() {
    return Math.random().toString(36).substr(2) + Date.now().toString(36);
}

function requireAdmin(req, res, next) {
    const token = req.headers['authorization'];
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ error: 'Unauthorized: Admin access required' });
    }
    next();
}

function sendCommandToESP(command) {
    console.log(`📡 Sending to ESP32: ${command}`);
    // Implementasi komunikasi ke ESP bisa pakai HTTP request:
    // const axios = require('axios');
    // axios.post('http://ESP_IP/control', { action: command });
}

// ==================== PUBLIC API ====================

// Ambil semua booking hari ini
app.get('/api/bookings', (req, res) => {
    const query = 'SELECT * FROM bookings WHERE tanggal = CURDATE() ORDER BY jam_mulai';
    db.query(query, (err, results) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// Tambah booking baru
app.post('/api/booking', (req, res) => {
    const { nama, jam_mulai, durasi, meja_id } = req.body;

    if (!nama || !jam_mulai || !durasi || !meja_id) {
        return res.status(400).json({ error: 'Semua field harus diisi' });
    }

    const jamMulai = new Date(`1970-01-01T${jam_mulai}:00`);
    const jamSelesai = new Date(jamMulai.getTime() + durasi * 60 * 60 * 1000);
    const jamSelesaiStr = jamSelesai.toTimeString().slice(0, 5);

    const query = `
        INSERT INTO bookings (nama, meja_id, jam_mulai, jam_selesai, tanggal, durasi)
        VALUES (?, ?, ?, ?, CURDATE(), ?)
    `;

    db.query(query, [nama, meja_id, jam_mulai, jamSelesaiStr, durasi], (err, result) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: err.message });
        }

        console.log(`📅 New booking: ${nama} (Meja ${meja_id}) ${jam_mulai}-${jamSelesaiStr}`);
        res.json({ message: 'Booking berhasil!', booking_id: result.insertId });
    });
});

// Ambil status semua lampu meja
app.get('/api/lampu/status', (req, res) => {
    db.query('SELECT * FROM meja_billiard ORDER BY id ASC', (err, results) => {
        if (err) {
            console.error('❌ Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// ==================== ADMIN AUTH ====================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        const token = generateSessionToken();
        adminSessions.add(token);
        console.log(`🔐 Admin login successful: ${username}`);
        res.json({ message: 'Login berhasil', token, username });
    } else {
        res.status(401).json({ error: 'Username atau password salah' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    const { token } = req.body;
    if (token) adminSessions.delete(token);
    console.log('🚪 Admin logged out');
    res.json({ message: 'Logout berhasil' });
});

// ==================== MANUAL CONTROL ====================

// Manual kontrol global (butuh login admin)
app.post('/api/lampu/control', requireAdmin, (req, res) => {
    const { action } = req.body;
    if (action !== 'ON' && action !== 'OFF') {
        return res.status(400).json({ error: 'Action harus ON atau OFF' });
    }

    const status = action === 'ON' ? 1 : 0;
    db.query('UPDATE meja_billiard SET status_lampu = ?', [status], err => {
        if (err) return res.status(500).json({ error: err.message });

        console.log(`🧠 Manual control: Semua lampu ${action}`);
        sendCommandToESP(action);
        res.json({ message: `Semua lampu berhasil di-${action}` });
    });
});

// Manual kontrol per meja (tanpa admin login)
app.post('/api/manual-control', (req, res) => {
    const { meja_id, action } = req.body;
    if (!meja_id || !action) {
        return res.status(400).json({ message: 'Data tidak lengkap.' });
    }

    const status = action === 'ON';
    db.query('UPDATE meja_billiard SET status_lampu = ? WHERE id = ?', [status, meja_id], err => {
        if (err) {
            console.error('❌ Gagal update status lampu:', err);
            return res.status(500).json({ message: 'Gagal update status lampu.' });
        }

        sendCommandToESP(`${action}${meja_id}`);
        console.log(`💡 Meja ${meja_id} ${action}`);
        res.json({ message: `Lampu Meja ${meja_id} ${action === 'ON' ? 'dinyalakan' : 'dimatikan'}.` });
    });
});

// ==================== STATUS MEJA (untuk admin.html) ====================
app.get('/api/status-meja', (req, res) => {
    const query = `
        SELECT 
            m.id,
            m.nama_meja,
            m.status_lampu,
            COALESCE(b.status, 'kosong') AS status_booking
        FROM meja_billiard m
        LEFT JOIN bookings b 
            ON m.id = b.meja_id
            AND b.tanggal = CURDATE()
            AND b.jam_mulai <= CURTIME()
            AND b.jam_selesai > CURTIME()
        ORDER BY m.id ASC
    `;
    db.query(query, (err, result) => {
        if (err) {
            console.error('❌ Error ambil status meja:', err);
            return res.status(500).json({ error: 'Gagal ambil data meja' });
        }
        res.json(result);
    });
});

// ==================== CRON JOB ====================
cron.schedule('* * * * *', () => {
    const now = new Date();
    const timeNow = now.toTimeString().slice(0, 5);
    const dateNow = now.toISOString().slice(0, 10);
    console.log(`⏰ Checking bookings at ${dateNow} ${timeNow}`);

    db.query('SELECT * FROM meja_billiard', (err, mejaList) => {
        if (err) return console.error('❌ Gagal ambil data meja:', err);

        mejaList.forEach(meja => {
            const q = `
                SELECT * FROM bookings
                WHERE tanggal = ? 
                AND meja_id = ? 
                AND jam_mulai <= ? 
                AND jam_selesai > ? 
                AND status != 'completed'
            `;
            db.query(q, [dateNow, meja.id, timeNow, timeNow], (err, active) => {
                if (err) return console.error(err);

                const lampuOn = active.length > 0;
                const status = lampuOn ? 1 : 0;

                db.query('UPDATE meja_billiard SET status_lampu = ? WHERE id = ?', [status, meja.id]);
                if (lampuOn) {
                    active.forEach(b => db.query('UPDATE bookings SET status="active" WHERE id=?', [b.id]));
                    sendCommandToESP(`ON${meja.id}`);
                    console.log(`💡 Meja ${meja.id} NYALA`);
                } else {
                    sendCommandToESP(`OFF${meja.id}`);
                    console.log(`⚫ Meja ${meja.id} MATI`);
                }

                db.query(`
                    UPDATE bookings 
                    SET status='completed'
                    WHERE tanggal=? AND meja_id=? AND jam_selesai <= ? AND status != 'completed'
                `, [dateNow, meja.id, timeNow]);
            });
        });
    });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Database: ${process.env.DB_DATABASE}`);
    console.log(`⏰ Cron job: Checking every minute`);
    console.log(`🔐 Admin login: admin / billiard123`);
});
