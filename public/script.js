// ====== GLOBAL STATE ======
let bookings = [];
let lampuStatus = false;

// ====== INITIALIZE ======
document.addEventListener("DOMContentLoaded", () => {
    console.log("🚀 Smart Billiard System Loaded");

    loadBookings();
    updateLampuStatus();
    updateCurrentTime();

    const bookingForm = document.getElementById("bookingForm");
    if (bookingForm) {
        bookingForm.addEventListener("submit", handleBookingSubmit);
    }

    // Refresh data tiap 30 detik
    setInterval(() => {
        loadBookings();
        updateLampuStatus();
    }, 30000);

    // Update jam tiap detik
    setInterval(updateCurrentTime, 1000);
});

// ====== FETCH BOOKING DATA ======
async function loadBookings() {
    try {
        const response = await fetch("/api/bookings");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        bookings = await response.json();
        displaySchedule();

    } catch (error) {
        showAlert("Error load bookings: " + error.message, "error");
        console.error("loadBookings error:", error);
    }
}

// ====== TAMPILKAN JADWAL ======
function displaySchedule() {
    const scheduleList = document.getElementById("scheduleList");
    if (!scheduleList) return;

    if (!bookings || bookings.length === 0) {
        scheduleList.innerHTML = `
            <div class="empty-state">
                <h3>📭 Belum ada booking hari ini</h3>
                <p>Jadilah yang pertama booking!</p>
            </div>
        `;
        return;
    }

    const now = new Date().toTimeString().slice(0, 5);

    scheduleList.innerHTML = bookings
        .map((booking) => {
            const isActive =
                booking.status === "active" ||
                (booking.jam_mulai <= now && booking.jam_selesai > now);

            const isCompleted =
                booking.status === "completed" ||
                booking.jam_selesai <= now;

            const status = isCompleted
                ? { class: "status-completed", text: "✅ Selesai" }
                : isActive
                ? { class: "status-active", text: "🔴 Sedang Main" }
                : { class: "status-pending", text: "⏱️ Menunggu" };

            const itemClass = isCompleted
                ? "schedule-item completed"
                : isActive
                ? "schedule-item active"
                : "schedule-item";

            return `
                <div class="${itemClass}">
                    <h4>👤 ${escapeHtml(booking.nama)} • Meja ${escapeHtml(String(booking.meja_id || "-"))}</h4>
                    <p>⏰ ${formatTime(booking.jam_mulai)} - ${formatTime(booking.jam_selesai)}</p>
                    <p>⏱️ Durasi: ${booking.durasi} jam</p>
                    <p>📅 Tanggal: ${formatDate(booking.tanggal)}</p>
                    <span class="schedule-status ${status.class}">
                        ${status.text}
                    </span>
                </div>
            `;
        })
        .join("");
}

// ====== LAMPU STATUS ======
async function updateLampuStatus() {
    try {
        const response = await fetch("/api/lampu/status");
        if (!response.ok) throw new Error("Gagal fetch status lampu");

        const lampuData = await response.json();
        if (!Array.isArray(lampuData) || lampuData.length === 0) return;

        const newStatus = lampuData[0].status_lampu;
        lampuStatus = Boolean(newStatus);

        const lampuStatusEl = document.getElementById("lampuStatus");

        if (lampuStatusEl) {
            lampuStatusEl.textContent = lampuStatus
                ? "🔴 Lampu: ON"
                : "⚫ Lampu: OFF";

            if (lampuStatusEl.parentElement) {
                lampuStatusEl.parentElement.classList.toggle("active", lampuStatus);
            }
        }
    } catch (error) {
        console.error("Lampu status error:", error);
    }
}

// ====== HANDLE BOOKING FORM ======
async function handleBookingSubmit(e) {
    e.preventDefault();

    const formData = new FormData(e.target);
    const bookingData = {
        nama: (formData.get("nama") || "").trim(),
        jam_mulai: formData.get("jamMulai"),
        durasi: Number(formData.get("durasi")),
        meja_id: Number(formData.get("meja")),
    };

    // Validasi
    if (!bookingData.nama || !bookingData.jam_mulai || !bookingData.durasi || !bookingData.meja_id) {
        showAlert("❌ Semua field wajib diisi!", "error");
        return;
    }

    if (bookingData.nama.length < 2) {
        showAlert("❌ Nama minimal 2 karakter!", "error");
        return;
    }

    // Cek waktu lewat
    const now = new Date();
    const bookingTime = new Date();
    const [h, m] = String(bookingData.jam_mulai).split(":").map(Number);
    bookingTime.setHours(h, m, 0, 0);

    if (bookingTime < now) {
        showAlert("❌ Tidak bisa booking waktu yang sudah lewat!", "error");
        return;
    }

    // Pastikan kita punya data bookings terbaru sebelum cek bentrok
    await loadBookings();

    // Cek bentrok hanya pada meja yang sama
    const conflict = checkBookingConflict(
        bookingData.jam_mulai,
        bookingData.durasi,
        bookingData.meja_id
    );
    if (conflict) {
        showAlert(
            `❌ Bentrok dengan booking ${escapeHtml(conflict.nama)} (Meja ${escapeHtml(String(conflict.meja_id))}) — ${formatTime(conflict.jam_mulai)} - ${formatTime(conflict.jam_selesai)}`,
            "error"
        );
        return;
    }

    // Kirim ke server
    try {
        showAlert("⏳ Memproses booking...", "info");

        const response = await fetch("/api/booking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bookingData),
        });

        const result = await response.json();

        if (response.ok) {
            e.target.reset();

            // ✨ BARU — Tampilkan struk booking dengan kode aktivasi
            showStruk(result);

            // refresh data
            await loadBookings();
            await updateLampuStatus();
        } else {
            showAlert("❌ " + (result.error || "Booking gagal"), "error");
        }
    } catch (err) {
        console.error("submit booking error:", err);
        showAlert("❌ Tidak bisa menghubungi server", "error");
    }
}

// ====== CEK BENTROK BOOKING (PER MEJA) ======
function checkBookingConflict(jamMulai, durasi, mejaId) {
    const newStart = timeToMinutes(jamMulai);
    const newEnd = newStart + durasi * 60;

    return bookings.find((b) => {
        if (b.status === "completed") return false;
        if (Number(b.meja_id) !== Number(mejaId)) return false;

        const start = timeToMinutes(b.jam_mulai);
        const end = timeToMinutes(b.jam_selesai);

        return newStart < end && newEnd > start;
    });
}

function timeToMinutes(t) {
    const [h, m] = String(t).split(":").map(Number);
    return (Number(h) || 0) * 60 + (Number(m) || 0);
}

// ====== JAM REALTIME ======
function updateCurrentTime() {
    const el = document.getElementById("currentTime");
    if (el) {
        el.textContent = new Date().toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }
}

// ====== ALERT ======
function showAlert(message, type = "info") {
    let container = document.querySelector(".booking-wrapper") || document.querySelector(".container") || document.body;

    const header = container.querySelector ? container.querySelector("header") : null;

    const old = container.querySelector ? container.querySelector(".alert") : null;
    if (old) old.remove();

    const alert = document.createElement("div");
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    alert.style.zIndex = 9999;

    if (header && container.insertBefore) {
        container.insertBefore(alert, header.nextSibling);
    } else if (container.appendChild) {
        container.appendChild(alert);
    } else {
        document.body.appendChild(alert);
    }

    setTimeout(() => {
        if (alert && alert.parentNode) alert.remove();
    }, 5000);

    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ======================================================
// ✨ BARU — STRUK BOOKING
// ======================================================
function showStruk(data) {
    // Hapus modal lama kalau ada
    const old = document.getElementById("modalStruk");
    if (old) old.remove();

    const tanggal = new Date().toLocaleDateString("id-ID", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
    });

    const modal = document.createElement("div");
    modal.id = "modalStruk";
    modal.innerHTML = `
        <div class="struk-overlay" onclick="tutupStruk()"></div>
        <div class="struk-modal">
            <div id="strukContent">
                <div class="struk-header">
                    <h2>🎱 Genzyeeeh Billiard</h2>
                    <p>Bukti Booking Resmi</p>
                    <hr>
                </div>
                <div class="struk-body">
                    <div class="struk-row">
                        <span>Nama</span>
                        <span>${escapeHtml(data.nama)}</span>
                    </div>
                    <div class="struk-row">
                        <span>Meja</span>
                        <span>Meja ${data.meja_id}</span>
                    </div>
                    <div class="struk-row">
                        <span>Tanggal</span>
                        <span>${tanggal}</span>
                    </div>
                    <div class="struk-row">
                        <span>Jam Mulai</span>
                        <span>${formatTime(data.jam_mulai)}</span>
                    </div>
                    <div class="struk-row">
                        <span>Jam Selesai</span>
                        <span>${formatTime(data.jam_selesai)}</span>
                    </div>
                    <div class="struk-row">
                        <span>Durasi</span>
                        <span>${data.durasi} Jam</span>
                    </div>
                    <hr>
                    <div class="struk-kode">
                        <p>🔑 Kode Aktivasi Anda:</p>
                        <h1>${escapeHtml(data.kode_aktivasi)}</h1>
                        <small>
                            Simpan kode ini! Gunakan jika Anda terlambat datang.<br>
                            Lampu otomatis mati jika tidak ada aktivitas selama 15 menit.
                        </small>
                    </div>
                </div>
                <div class="struk-footer">
                    <small>Terima kasih telah booking di Genzyeeeh Billiard! 🎱</small>
                </div>
            </div>
            <div class="struk-actions">
                <button onclick="printStruk()" class="btn-print">🖨️ Print Struk</button>
                <button onclick="tutupStruk()" class="btn-tutup">✕ Tutup</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function tutupStruk() {
    const modal = document.getElementById("modalStruk");
    if (modal) modal.remove();
}

function printStruk() {
    const content = document.getElementById("strukContent").innerHTML;
    const win = window.open("", "_blank", "width=420,height=650");
    win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Struk Booking - Genzyeeeh Billiard</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Courier New', monospace;
                    padding: 24px;
                    max-width: 320px;
                    margin: 0 auto;
                    color: #1a202c;
                }
                .struk-header { text-align: center; margin-bottom: 14px; }
                .struk-header h2 { font-size: 18px; }
                .struk-header p { font-size: 12px; color: #718096; margin-top: 4px; }
                hr { border: none; border-top: 1px dashed #a0aec0; margin: 12px 0; }
                .struk-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 4px 0;
                    font-size: 13px;
                }
                .struk-row span:first-child { color: #718096; }
                .struk-row span:last-child { font-weight: 700; }
                .struk-kode {
                    text-align: center;
                    margin: 16px 0 10px;
                }
                .struk-kode p {
                    font-size: 12px;
                    color: #4a5568;
                    margin-bottom: 8px;
                }
                .struk-kode h1 {
                    font-size: 26px;
                    font-weight: 900;
                    letter-spacing: 4px;
                    border: 2px dashed #2563eb;
                    color: #2563eb;
                    padding: 8px 14px;
                    display: inline-block;
                    border-radius: 8px;
                }
                .struk-kode small {
                    display: block;
                    font-size: 11px;
                    color: #718096;
                    margin-top: 8px;
                    font-family: Arial, sans-serif;
                    line-height: 1.6;
                }
                .struk-footer {
                    text-align: center;
                    font-size: 11px;
                    color: #a0aec0;
                    margin-top: 14px;
                    font-family: Arial, sans-serif;
                }
            </style>
        </head>
        <body>
            ${content}
            <script>
                window.onload = function() {
                    window.print();
                    setTimeout(function() { window.close(); }, 500);
                };
            <\/script>
        </body>
        </html>
    `);
    win.document.close();
}

// ======================================================
// ✨ BARU — AKTIVASI KODE (Customer Telat)
// ======================================================
async function aktivasiKode() {
    const input = document.getElementById("inputKodeAktivasi");
    const kode = input ? input.value.trim().toUpperCase() : "";

    if (!kode) {
        showAlert("❌ Masukkan kode aktivasi dulu!", "error");
        return;
    }

    // Validasi format dasar BIL-XXX-YYYY
    const formatValid = /^BIL-\d{3}-\d{4}$/.test(kode);
    if (!formatValid) {
        showAlert("❌ Format kode salah. Contoh: BIL-001-2025", "error");
        return;
    }

    try {
        showAlert("⏳ Mengaktifkan lampu...", "info");

        const response = await fetch("/api/aktivasi", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kode })
        });

        const result = await response.json();

        if (response.ok) {
            showAlert(
                `🎉 ${result.message} Selesai jam ${formatTime(result.jam_selesai)}`,
                "success"
            );
            if (input) input.value = "";
            await updateLampuStatus();
            await loadBookings();
        } else {
            showAlert("❌ " + result.error, "error");
        }

    } catch (err) {
        console.error("aktivasi error:", err);
        showAlert("❌ Tidak bisa menghubungi server", "error");
    }
}

// ====== FORMAT TIME/DATE ======
function formatTime(t) {
    if (!t) return "--:--";
    const [h, m] = String(t).split(":");
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDate(d) {
    if (!d) return "--";
    try {
        return new Date(d).toLocaleDateString("id-ID", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });
    } catch {
        return d;
    }
}

// ====== HELPERS ======
function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(/[&<>"']/g, (m) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[m]));
}

// ====== DEBUG ======
window.debugBilliard = () => {
    console.log({
        bookings,
        lampuStatus,
        time: new Date().toTimeString(),
    });
};