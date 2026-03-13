-- ====================================================
-- SMART BILLIARD BOOKING - PostgreSQL Schema
-- Jalankan file ini sekali di psql atau pgAdmin
-- ====================================================

-- Buat database (jalankan di psql sebagai superuser)
-- CREATE DATABASE billiard_booking;

-- Tabel meja billiard
CREATE TABLE IF NOT EXISTS meja_billiard (
    id SERIAL PRIMARY KEY,
    nama_meja VARCHAR(50) NOT NULL,
    status_lampu BOOLEAN DEFAULT FALSE
);

-- Tabel bookings
CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    nama VARCHAR(100) NOT NULL,
    meja_id INTEGER NOT NULL REFERENCES meja_billiard(id),
    jam_mulai TIME NOT NULL,
    jam_selesai TIME NOT NULL,
    tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
    durasi INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    kode_aktivasi VARCHAR(20) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index biar query cepat
CREATE INDEX IF NOT EXISTS idx_bookings_tanggal ON bookings(tanggal);
CREATE INDEX IF NOT EXISTS idx_bookings_meja ON bookings(meja_id);
CREATE INDEX IF NOT EXISTS idx_bookings_kode ON bookings(kode_aktivasi);

-- Insert data awal meja
INSERT INTO meja_billiard (nama_meja, status_lampu)
VALUES 
    ('Meja 1', FALSE),
    ('Meja 2', FALSE)
ON CONFLICT DO NOTHING;

-- Verifikasi
SELECT 'Schema berhasil dibuat!' AS info;
SELECT * FROM meja_billiard;
