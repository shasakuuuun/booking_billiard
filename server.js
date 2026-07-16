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
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// ======================================================
// MIDDLEWARE
// ======================================================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================
process.on("uncaughtException", (err) => {
    log("❌ Uncaught Exception : " + err);
});

process.on("unhandledRejection", (err) => {
    log("❌ Unhandled Rejection : " + err);
});

// ======================================================
// ADMIN AUTH
// ======================================================
const ADMIN = {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "billiard123"
};

// ======================================================
// GENERATE TOKEN
// ======================================================
function makeToken() {
    return (
        Math.random().toString(36).substring(2) +
        Date.now().toString(36)
    );
}

// ======================================================
// GENERATE KODE AKTIVASI
// ======================================================
function makeKodeAktivasi(bookingId) {
    const pad = String(bookingId).padStart(3, "0");
    const year = new Date().getFullYear();

    return `BIL-${pad}-${year}`;
}

// ======================================================
// AUTH MIDDLEWARE
// Session dicek ke database
// ======================================================
async function requireAdmin(req, res, next) {

    const token =
        req.headers["authorization"] ||
        req.headers["Authorization"];

    if (!token) {
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    try {

        const result = await db.query(
            `
            SELECT *
            FROM admin_sessions
            WHERE token = $1
            LIMIT 1
            `,
            [token]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "Unauthorized"
            });
        }

        next();

    } catch (err) {

        log("❌ requireAdmin : " + err);

        return res.status(500).json({
            error: "Server Error"
        });

    }

}

// ======================================================
// POSTGRESQL CONNECTION
// ======================================================
const db = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_DATABASE || "billiard_booking"
});

db.connect()
    .then(client => {
        log("✅ PostgreSQL Connected");
        client.release();
    })
    .catch(err => {
        log("❌ PostgreSQL Failed : " + err.message);
        log("💡 Cek PostgreSQL dan file .env");
    });

// ======================================================
// ESP COMMAND QUEUE
// ======================================================
let commandQueue = {
    1: "",
    2: ""
};

// ======================================================
// MODE MANUAL
// true  = Cron tidak mengubah lampu
// false = Cron bekerja normal
// ======================================================
let manualMode = {
    1: false,
    2: false
};
// ======================================================
// STATUS TIMEOUT SENSOR
// ======================================================
let sensorTimeout = {
    1: false,
    2: false
};

// ======================================================
// LAST SHAKE
// ======================================================
let lastShake = {
    1: Date.now(),
    2: Date.now()
};

// ======================================================
// SHAKE TIMEOUT
// Demo = 25 detik
// Produksi = 15 * 60 * 1000
// ======================================================
const SHAKE_TIMEOUT_MS = 25 * 1000;

// ======================================================
// PUSH COMMAND KE ESP32
// ======================================================
function pushCommand(cmd) {

    if (!cmd) return;

    const meja = Number(cmd.replace(/\D/g, ""));

    if (meja !== 1 && meja !== 2) {
        return;
    }

    commandQueue[meja] = cmd;

    log(`📡 QUEUE -> ${cmd}`);
}

// ======================================================
// ADMIN LOGIN
// ======================================================
app.post("/api/admin/login", async (req, res) => {

    try {

        const { username, password } = req.body;

        if (
            username !== ADMIN.username ||
            password !== ADMIN.password
        ) {
            log("❌ ADMIN LOGIN FAILED");

            return res.status(401).json({
                error: "Username atau Password salah"
            });
        }

        const token = makeToken();

        await db.query(
            `
            INSERT INTO admin_sessions(token,username)
            VALUES($1,$2)
            `,
            [token, username]
        );

        log("🔐 ADMIN LOGIN SUCCESS");

        return res.json({
            token,
            username
        });

    } catch (err) {

        log("❌ Login Error : " + err);

        return res.status(500).json({
            error: "Server Error"
        });

    }

});

// ======================================================
// VERIFY TOKEN
// ======================================================
app.post("/api/admin/verify", async (req, res) => {

    try {

        const { token } = req.body;

        const result = await db.query(
            `
            SELECT id
            FROM admin_sessions
            WHERE token=$1
            LIMIT 1
            `,
            [token]
        );

        return res.json({
            valid: result.rows.length > 0
        });

    } catch (err) {

        log("❌ Verify Error : " + err);

        return res.status(500).json({
            valid: false
        });

    }

});

// ======================================================
// GET BOOKINGS HARI INI
// ======================================================
app.get("/api/bookings", async (req, res) => {

    try {

        const result = await db.query(`
            SELECT *
            FROM bookings
            WHERE tanggal = CURRENT_DATE
            ORDER BY jam_mulai ASC
        `);

        res.json(result.rows);

    } catch (err) {

        log("❌ Load Booking : " + err);

        res.status(500).json({
            error: err.message
        });

    }

});

// ======================================================
// TAMBAH BOOKING
// ======================================================
app.post("/api/booking", async (req, res) => {

    try {

        const {
            nama,
            jam_mulai,
            durasi,
            meja_id
        } = req.body;

        // =====================
        // VALIDASI
        // =====================

        if (!nama || !jam_mulai || !durasi || !meja_id) {

            return res.status(400).json({
                error: "Semua field wajib diisi."
            });

        }

        if (durasi <= 0) {

            return res.status(400).json({
                error: "Durasi tidak valid."
            });

        }

        if (![1, 2].includes(Number(meja_id))) {

            return res.status(400).json({
                error: "Meja tidak tersedia."
            });

        }

        // =====================
        // HITUNG JAM SELESAI
        // =====================

        const start = new Date(`1970-01-01T${jam_mulai}:00`);

        const end = new Date(
            start.getTime() + (durasi * 60 * 60 * 1000)
        );

        const jam_selesai =
            end.toTimeString().slice(0, 5);

        // =====================
        // TOTAL HARGA
        // =====================

        const totalHarga = durasi * 30000;

        // =====================
        // INSERT BOOKING
        // =====================

        const insert = await db.query(
            `
            INSERT INTO bookings
            (
                nama,
                meja_id,
                jam_mulai,
                jam_selesai,
                tanggal,
                durasi,
                status_bayar,
                total_harga
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4,
                CURRENT_DATE,
                $5,
                'belum',
                $6
            )
            RETURNING id
            `,
            [
                nama,
                meja_id,
                jam_mulai,
                jam_selesai,
                durasi,
                totalHarga
            ]
        );

        const bookingId = insert.rows[0].id;

        const kodeAktivasi =
            makeKodeAktivasi(bookingId);

        await db.query(
            `
            UPDATE bookings
            SET kode_aktivasi=$1
            WHERE id=$2
            `,
            [
                kodeAktivasi,
                bookingId
            ]
        );

        log(
            `📅 BOOKING -> Meja ${meja_id} | ${jam_mulai}-${jam_selesai}`
        );

        res.json({

            success: true,

            booking_id: bookingId,

            kode_aktivasi: kodeAktivasi,

            nama,

            meja_id,

            jam_mulai,

            jam_selesai,

            durasi,

            total_harga: totalHarga

        });

    } catch (err) {

        log("❌ Booking Error : " + err);

        res.status(500).json({
            error: err.message
        });

    }

});

// ======================================================
// API — AKTIVASI BOOKING
// ======================================================
app.post("/api/aktivasi", async (req, res) => {

    try {

        const { kode } = req.body;

        if (!kode) {
            return res.status(400).json({
                error: "Kode aktivasi tidak boleh kosong."
            });
        }

        const result = await db.query(`
            SELECT *
            FROM bookings
            WHERE kode_aktivasi = $1
              AND tanggal = CURRENT_DATE
              AND status != 'completed'
            LIMIT 1
        `, [kode.trim().toUpperCase()]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Kode tidak ditemukan atau booking telah selesai."
            });
        }

        const booking = result.rows[0];

        const now = new Date().toTimeString().slice(0,5);

        if (now < booking.jam_mulai) {

            return res.status(400).json({
                error: `Booking dimulai pukul ${booking.jam_mulai}`
            });

        }

        // ======================================
        // Booking mengambil alih kontrol lampu
        // ======================================
        manualMode[booking.meja_id] = false;

        pushCommand(`ON${booking.meja_id}`);

        await db.query(
            `
            UPDATE meja_billiard
            SET status_lampu = TRUE
            WHERE id = $1
            `,
            [booking.meja_id]
        );

        await db.query(
            `
            UPDATE bookings
            SET status='active'
            WHERE id=$1
            `,
            [booking.id]
        );

        lastShake[booking.meja_id] = Date.now();

        log(
            `🔑 AKTIVASI -> ${booking.kode_aktivasi} | Meja ${booking.meja_id}`
        );

        res.json({

            success:true,

            meja_id:booking.meja_id,

            nama:booking.nama,

            jam_selesai:booking.jam_selesai,

            message:`Lampu Meja ${booking.meja_id} berhasil dinyalakan`

        });

    } catch(err){

        log("❌ Aktivasi Error : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// STATUS LAMPU
// ======================================================
app.get("/api/lampu/status", async(req,res)=>{

    try{

        const result=await db.query(`
            SELECT *
            FROM meja_billiard
            ORDER BY id ASC
        `);

        res.json(result.rows);

    }catch(err){

        log("❌ Status Lampu : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// STATUS MEJA
// ======================================================
app.get("/api/status-meja",async(req,res)=>{

    try{

        const result=await db.query(`

            SELECT

                m.id,

                m.nama_meja,

                m.status_lampu,

                COALESCE(

                    (

                        SELECT status

                        FROM bookings

                        WHERE meja_id=m.id

                        AND tanggal=CURRENT_DATE

                        AND status='active'

                        LIMIT 1

                    ),

                    'idle'

                ) AS status_booking

            FROM meja_billiard m

            ORDER BY m.id ASC

        `);

        res.json(result.rows);

    }catch(err){

        log("❌ Status Meja : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// API — RESET MEJA
// ======================================================
app.post("/api/reset-meja", requireAdmin, async (req, res) => {

    try {

        // keluar dari mode manual
        manualMode[1] = false;
        manualMode[2] = false;

        await db.query(`
            UPDATE meja_billiard
            SET status_lampu = FALSE
        `);

        await db.query(`
            UPDATE bookings
            SET status='completed'
            WHERE tanggal=CURRENT_DATE
        `);

        pushCommand("OFF1");
        pushCommand("OFF2");

        log("♻ RESET SEMUA MEJA");

        res.json({
            success:true,
            message:"Reset berhasil."
        });

    } catch(err){

        log("❌ Reset Error : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// GLOBAL CONTROL
// ======================================================
app.post("/api/lampu/control", requireAdmin, async (req,res)=>{

    try{

        const { action } = req.body;

        if(!["ON","OFF"].includes(action)){
            return res.status(400).json({
                error:"Action harus ON/OFF"
            });
        }

        const status = action==="ON";

        // ============================
        // GLOBAL = MODE MANUAL
        // ============================
        manualMode[1]=status;
        manualMode[2]=status;

        await db.query(
            `
            UPDATE meja_billiard
            SET status_lampu=$1
            `,
            [status]
        );

        pushCommand(`${action}1`);
        pushCommand(`${action}2`);

        log(`💡 GLOBAL ${action}`);

        res.json({
            success:true,
            message:`Semua lampu ${action}`
        });

    }catch(err){

        log("❌ Global Error : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// SENSOR GETAR
// ======================================================
app.post("/api/shake", async(req,res)=>{

    try{

        const { meja_id, reset_only } = req.body;

        if(![1,2].includes(Number(meja_id))){
            return res.status(400).json({
                error:"Meja tidak valid"
            });
        }

        lastShake[meja_id] = Date.now();

        // Reset status timeout karena ada aktivitas lagi
        sensorTimeout[meja_id] = false;

        log(`🔔 SENSOR -> Meja ${meja_id}`);

        if(!reset_only){

            manualMode[meja_id]=false;

            pushCommand(`ON${meja_id}`);

            lastShake[meja_id] = Date.now();
            sensorTimeout[meja_id] = false;

            log(`🟢 Booking Aktif -> Reset Timer Sensor Meja ${meja_id}`);
            
            await db.query(
                `
                UPDATE meja_billiard
                SET status_lampu=TRUE
                WHERE id=$1
                `,
                [meja_id]
            );

            log(`💡 Lampu ON -> Meja ${meja_id}`);

        }else{

            log(`⏱ Timer Reset -> Meja ${meja_id}`);

        }

        res.json({
            success:true
        });

    }catch(err){

        log("❌ Shake Error : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// MANUAL CONTROL
// ======================================================
app.post("/api/manual-control", requireAdmin, async (req, res) => {

    try {

        const { meja_id, action } = req.body;

        if (![1,2].includes(Number(meja_id))) {
            return res.status(400).json({
                error: "Meja tidak valid"
            });
        }

        if (!["ON","OFF"].includes(action)) {
            return res.status(400).json({
                error: "Action harus ON/OFF"
            });
        }

        const status = action === "ON";

        // ===============================
        // MANUAL MODE
        // ===============================
        manualMode[meja_id] = status;

        await db.query(
            `
            UPDATE meja_billiard
            SET status_lampu=$1
            WHERE id=$2
            `,
            [status, meja_id]
        );

        pushCommand(`${action}${meja_id}`);

        log(`💡 MANUAL ${action} -> Meja ${meja_id}`);

        res.json({
            success:true,
            message:`Lampu meja ${meja_id} ${action}`
        });

    } catch(err){

        log("❌ Manual Error : "+err);

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// ESP32 COMMAND
// ======================================================
app.get("/api/esp-command",(req,res)=>{

    try{

        const meja=parseInt(req.query.meja||"0");

        const cmd=commandQueue[meja]||"";

        if(cmd){

            log(`📤 SEND -> ${cmd}`);

            commandQueue[meja]="";

            return res.send(cmd);

        }

        return res.send("");

    }catch(err){

        log("❌ ESP COMMAND : "+err);

        res.send("");

    }

});

// ======================================================
// CRON BOOKING
// DEMO = TIAP DETIK
// PRODUKSI = "* * * * *"
// ======================================================
cron.schedule("* * * * * *", async()=>{

    try{

        const now=new Date();

        const t=now.toTimeString().slice(0,5);

        const d=now.toISOString().slice(0,10);

        const mejaList=await db.query(
            "SELECT * FROM meja_billiard ORDER BY id ASC"
        );

        for(const meja of mejaList.rows){

            // ==========================
            // MANUAL MODE
            // ==========================
            if(manualMode[meja.id]){
                continue;
            }
            // Jika lampu dimatikan oleh sensor,
            // jangan dinyalakan lagi selama booking yang sama.
            if(sensorTimeout[meja.id]){
                continue;
            }

            const booking=await db.query(`
                SELECT *
                FROM bookings
                WHERE meja_id=$1
                AND tanggal=$2
                AND status!='completed'
            `,[meja.id,d]);

            let aktif=false;

            let activeId=null;

            for(const b of booking.rows){

                const active=b.jam_mulai<b.jam_selesai
                ? (t>=b.jam_mulai && t<b.jam_selesai)
                : (t>=b.jam_mulai || t<b.jam_selesai);

                if(active){

                    aktif=true;

                    activeId=b.id;

                    break;

                }

            }

            if (aktif) {

                if (!meja.status_lampu) {

                    pushCommand(`ON${meja.id}`);

                    // Booking baru dimulai
                    // Mulai hitung timer sensor dari sekarang
                    lastShake[meja.id] = Date.now();

                    log(`🟢 Booking Aktif -> Reset Timer Sensor Meja ${meja.id}`);

                }

                await db.query(
                    `
                    UPDATE meja_billiard
                    SET status_lampu=TRUE
                    WHERE id=$1
                    `,
                    [meja.id]
                );

                await db.query(
                    `
                    UPDATE bookings
                    SET status='active'
                    WHERE id=$1
                    `,
                    [activeId]
                );



            }else{

                // ==========================
                // KIRIM OFF SEKALI SAJA
                // ==========================
                if(meja.status_lampu){

                    pushCommand(`OFF${meja.id}`);

                }

                await db.query(
                    `
                    UPDATE meja_billiard
                    SET status_lampu=FALSE
                    WHERE id=$1
                    `,
                    [meja.id]
                );

                await db.query(`
                    UPDATE bookings
                    SET status='completed'
                    WHERE meja_id=$1
                    AND tanggal=$2
                    AND jam_selesai<=$3
                `,[meja.id,d,t]);

            }

        }

    }catch(err){

        log("❌ CRON BOOKING : "+err);

    }

});

// ======================================================
// CRON SENSOR
// ======================================================
cron.schedule("* * * * * *",async()=>{

    try{

        const now=Date.now();

        for(let meja=1;meja<=2;meja++){

            // ==========================
            // JANGAN GANGGU MANUAL MODE
            // ==========================
            if(manualMode[meja]){
                continue;
            }

            if((now-lastShake[meja])>SHAKE_TIMEOUT_MS){

                const t=new Date().toTimeString().slice(0,5);

                const d=new Date().toISOString().slice(0,10);

                const aktif=await db.query(`
                    SELECT id
                    FROM bookings
                    WHERE meja_id=$1
                    AND tanggal=$2
                    AND status='active'
                    AND jam_mulai<=$3
                    AND jam_selesai>$3
                    LIMIT 1
                `,[meja,d,t]);

                if(aktif.rows.length){

                    const lampu=await db.query(
                        "SELECT status_lampu FROM meja_billiard WHERE id=$1",
                        [meja]
                    );

                    if(lampu.rows[0].status_lampu){

                        log(`⌛ Timeout Sensor Meja ${meja}`);

                        sensorTimeout[meja] = true;

                        pushCommand(`OFF${meja}`);

                        await db.query(
                            `
                            UPDATE meja_billiard
                            SET status_lampu=FALSE
                            WHERE id=$1
                            `,
                            [meja]
                        );

                        log(`⚫ AUTO OFF SENSOR -> Meja ${meja}`);

                    }

                }

                lastShake[meja]=now;

            }

        }

    }catch(err){

        log("❌ SENSOR CRON : "+err);

    }

});

// ======================================================
// STATISTIK
// ======================================================
app.get("/api/statistik",async(req,res)=>{

    try{

        const days=parseInt(req.query.days||30);

        const result=await db.query(`
            SELECT
            gs.tanggal::date AS tanggal,
            COALESCE(COUNT(b.id),0) AS total_booking,
            COALESCE(SUM(b.durasi),0) AS total_jam
            FROM generate_series(
                CURRENT_DATE-INTERVAL '1 day'*($1-1),
                CURRENT_DATE,
                INTERVAL '1 day'
            ) AS gs(tanggal)
            LEFT JOIN bookings b
            ON b.tanggal=gs.tanggal::date
            GROUP BY gs.tanggal
            ORDER BY gs.tanggal
        `,[days]);

        res.json(result.rows);

    }catch(err){

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// KONFIRMASI PEMBAYARAN
// ======================================================
app.post("/api/konfirmasi-bayar",requireAdmin,async(req,res)=>{

    try{

        const { booking_id }=req.body;

        await db.query(
            `
            UPDATE bookings
            SET status_bayar='lunas'
            WHERE id=$1
            `,
            [booking_id]
        );

        log(`💰 BOOKING ${booking_id} LUNAS`);

        res.json({
            success:true
        });

    }catch(err){

        res.status(500).json({
            error:err.message
        });

    }

});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT,()=>{

    log(`🚀 SERVER RUNNING`);

    log(`🌐 http://localhost:${PORT}`);

});