const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

db.connect((err) => {
    if (err) {
        console.error('❌ Database connection failed:', err);
        return;
    }
    console.log('✅ Connected to MySQL database');
});

// API Routes
app.get('/api/bookings', (req, res) => {
    const query = 'SELECT * FROM bookings WHERE tanggal = CURDATE() ORDER BY jam_mulai';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(results);
    });
});

app.post('/api/booking', (req, res) => {
    const { nama, jam_mulai, durasi } = req.body;
    
    // Validasi input
    if (!nama || !jam_mulai || !durasi) {
        return res.status(400).json({ error: 'Semua field harus diisi' });
    }

    // Hitung jam selesai
    const jamMulai = new Date(`1970-01-01T${jam_mulai}:00`);
    const jamSelesai = new Date(jamMulai.getTime() + (durasi * 60 * 60 * 1000));
    const jamSelesaiStr = jamSelesai.toTimeString().slice(0, 5);

    const query = `
        INSERT INTO bookings (nama, jam_mulai, jam_selesai, tanggal, durasi) 
        VALUES (?, ?, ?, CURDATE(), ?)
    `;
    
    db.query(query, [nama, jam_mulai, jamSelesaiStr, durasi], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        
        console.log(`📅 New booking: ${nama} - ${jam_mulai} (${durasi}h)`);
        res.json({ 
            message: 'Booking berhasil!', 
            booking_id: result.insertId 
        });
    });
});

app.get('/api/lampu/status', (req, res) => {
    const query = 'SELECT * FROM meja_billiard';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(results);
    });
});

// Cron job untuk kontrol lampu otomatis (jalan setiap menit)
cron.schedule('* * * * *', () => {
    const currentTime = new Date().toTimeString().slice(0, 5);
    const currentDate = new Date().toISOString().slice(0, 10);
    
    // Cek booking yang seharusnya aktif sekarang
    const query = `
        SELECT * FROM bookings 
        WHERE tanggal = ? 
        AND jam_mulai <= ? 
        AND jam_selesai > ? 
        AND status != 'completed'
    `;
    
    db.query(query, [currentDate, currentTime, currentTime], (err, activeBookings) => {
        if (err) {
            console.error('Cron job error:', err);
            return;
        }

        // Update status lampu berdasarkan booking aktif
        const shouldLightOn = activeBookings.length > 0;
        
        if (shouldLightOn) {
            // Nyalakan lampu dan update status booking
            db.query('UPDATE meja_billiard SET status_lampu = TRUE WHERE id = 1');
            
            activeBookings.forEach(booking => {
                db.query('UPDATE bookings SET status = "active" WHERE id = ?', [booking.id]);
            });
            
            console.log(`🔴 LAMPU NYALA - Ada ${activeBookings.length} booking aktif (${currentTime})`);
            sendCommandToESP('ON');
            
        } else {
            // Matikan lampu
            db.query('UPDATE meja_billiard SET status_lampu = FALSE WHERE id = 1');
            console.log(`⚫ LAMPU MATI - Tidak ada booking aktif (${currentTime})`);
            sendCommandToESP('OFF');
        }

        // Update booking yang sudah selesai
        const completeQuery = `
            UPDATE bookings 
            SET status = 'completed' 
            WHERE tanggal = ? AND jam_selesai <= ? AND status != 'completed'
        `;
        db.query(completeQuery, [currentDate, currentTime]);
    });
});

// Function untuk kirim command ke ESP32 (nanti akan diimplementasi)
function sendCommandToESP(command) {
    console.log(`📡 Sending to ESP32: ${command}`);
    
    // Nanti akan diimplementasi untuk komunikasi dengan ESP32
    // const axios = require('axios');
    // axios.post('http://ESP32_IP/control', { action: command })
    //   .catch(err => console.log('ESP32 connection error:', err.message));
}

// Route untuk manual control (admin)
app.post('/api/lampu/control', (req, res) => {
    const { action } = req.body;
    
    if (action !== 'ON' && action !== 'OFF') {
        return res.status(400).json({ error: 'Action harus ON atau OFF' });
    }
    
    const status = action === 'ON' ? 1 : 0;
    const query = 'UPDATE meja_billiard SET status_lampu = ? WHERE id = 1';
    
    db.query(query, [status], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        
        console.log(`🔧 Manual control: ${action}`);
        sendCommandToESP(action);
        res.json({ message: `Lampu berhasil di-${action}` });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Database: ${process.env.DB_DATABASE}`);
    console.log(`⏰ Cron job: Checking every minute for automatic lighting`);
}); 