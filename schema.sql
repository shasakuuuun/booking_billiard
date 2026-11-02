-- SMART BILLIARD BOOKING + IoT
-- Jalankan pada database billiard_booking. Script aman dijalankan ulang.
-- Tidak menghapus data booking yang sudah ada.

CREATE TABLE IF NOT EXISTS meja_billiard (
    id SERIAL PRIMARY KEY,
    nama_meja VARCHAR(50) NOT NULL,
    status_lampu BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    nama VARCHAR(100) NOT NULL,
    meja_id INTEGER NOT NULL REFERENCES meja_billiard(id),
    jam_mulai TIME NOT NULL,
    jam_selesai TIME NOT NULL,
    tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
    durasi INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    status_bayar VARCHAR(20) DEFAULT 'belum',
    total_harga INTEGER DEFAULT 0,
    kode_aktivasi VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW(),
    activated_at TIMESTAMP NULL,
    waiting_started_at TIMESTAMP NULL,
    waiting_timeout_at TIMESTAMP NULL
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status_bayar VARCHAR(20) DEFAULT 'belum';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS total_harga INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS kode_aktivasi VARCHAR(20);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS waiting_started_at TIMESTAMP NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS waiting_timeout_at TIMESTAMP NULL;

CREATE TABLE IF NOT EXISTS admin_sessions (
    id SERIAL PRIMARY KEY,
    token VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Log sensor SW-420. Sensor fisik hanya berada di Meja 1.
CREATE TABLE IF NOT EXISTS sensor_logs (
    id BIGSERIAL PRIMARY KEY,
    meja_id INTEGER NOT NULL,
    event_type VARCHAR(40) NOT NULL DEFAULT 'vibration',
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(30) NOT NULL DEFAULT 'esp32'
);

CREATE TABLE IF NOT EXISTS lamp_logs (
    id BIGSERIAL PRIMARY KEY,
    meja_id INTEGER NOT NULL,
    is_on BOOLEAN NOT NULL,
    reason VARCHAR(60) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_logs (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL DEFAULT 'esp32-01',
    event_type VARCHAR(40) NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_tanggal ON bookings(tanggal);
CREATE INDEX IF NOT EXISTS idx_bookings_meja ON bookings(meja_id);
CREATE INDEX IF NOT EXISTS idx_bookings_kode ON bookings(kode_aktivasi);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token);
CREATE INDEX IF NOT EXISTS idx_sensor_logs_time ON sensor_logs(detected_at);
CREATE INDEX IF NOT EXISTS idx_sensor_logs_meja_time ON sensor_logs(meja_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_lamp_logs_time ON lamp_logs(created_at);

-- Pertahankan 10 meja sesuai UI lama, tanpa menggandakan baris saat script diulang.
INSERT INTO meja_billiard (nama_meja, status_lampu)
SELECT v.nama, FALSE
FROM (VALUES ('Meja 1'),('Meja 2'),('Meja 3'),('Meja 4'),('Meja 5'),
             ('Meja 6'),('Meja 7'),('Meja 8'),('Meja 9'),('Meja 10')) AS v(nama)
WHERE NOT EXISTS (SELECT 1 FROM meja_billiard m WHERE m.nama_meja=v.nama);

SELECT 'Schema Smart Billiard siap' AS info;
SELECT * FROM meja_billiard ORDER BY id;
