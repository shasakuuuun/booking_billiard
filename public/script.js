// ====== GLOBAL STATE ======
let bookings = [];
let lampuStatus = false;

// ====== HARGA ======
const HARGA_PER_JAM = 30000;

// ====== INFO PEMBAYARAN (sesuaikan dengan data asli) ======
const INFO_BAYAR = {
    bank: "BCA",
    noRek: "1234567890",
    atasNama: "Genzyeeeh Billiard",
    qrisUrl: "" // kosongkan jika tidak punya gambar QRIS
};

// ====== FORMAT RUPIAH ======
function formatRupiah(angka) {
    return "Rp " + Number(angka).toLocaleString("id-ID");
}

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

    // Update harga otomatis saat durasi berubah
    const durasiSelect = document.getElementById("durasi");
    if (durasiSelect) {
        durasiSelect.addEventListener("change", updateHargaPreview);
    }

    // Refresh data tiap 30 detik
    setInterval(() => {
        loadBookings();
        updateLampuStatus();
    }, 30000);

    // Update jam tiap detik
    setInterval(updateCurrentTime, 1000);
});

// ====== UPDATE PREVIEW HARGA ======
function updateHargaPreview() {
    const durasi = Number(document.getElementById("durasi")?.value || 0);
    const preview = document.getElementById("hargaPreview");
    if (!preview) return;

    if (durasi > 0) {
        const total = durasi * HARGA_PER_JAM;
        preview.innerHTML = `
            <div class="harga-preview">
                💰 ${durasi} jam × ${formatRupiah(HARGA_PER_JAM)} = 
                <strong>${formatRupiah(total)}</strong>
            </div>
        `;
        preview.style.display = "block";
    } else {
        preview.style.display = "none";
    }
}

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

    scheduleList.innerHTML = bookings.map((booking) => {
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
                <span class="schedule-status ${status.class}">${status.text}</span>
            </div>
        `;
    }).join("");
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
            lampuStatusEl.textContent = lampuStatus ? "🔴 Lampu: ON" : "⚫ Lampu: OFF";
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
        nama:     (formData.get("nama") || "").trim(),
        jam_mulai: formData.get("jamMulai"),
        durasi:   Number(formData.get("durasi")),
        meja_id:  Number(formData.get("meja")),
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

    // Refresh bookings terbaru sebelum cek bentrok
    await loadBookings();

    const conflict = checkBookingConflict(bookingData.jam_mulai, bookingData.durasi, bookingData.meja_id);
    if (conflict) {
        showAlert(
            `❌ Bentrok dengan booking ${escapeHtml(conflict.nama)} (Meja ${escapeHtml(String(conflict.meja_id))}) — ${formatTime(conflict.jam_mulai)} - ${formatTime(conflict.jam_selesai)}`,
            "error"
        );
        return;
    }

    // Hitung total harga
    const totalHarga = bookingData.durasi * HARGA_PER_JAM;

    // Tampilkan modal konfirmasi pembayaran dulu
    showKonfirmasiPembayaran(bookingData, totalHarga, e.target);
}

// ====== MODAL KONFIRMASI PEMBAYARAN ======
function showKonfirmasiPembayaran(bookingData, totalHarga, form) {
    const old = document.getElementById("modalPembayaran");
    if (old) old.remove();

    const tanggal = new Date().toLocaleDateString("id-ID", {
        weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    // Hitung jam selesai untuk preview
    const [h, m] = bookingData.jam_mulai.split(":").map(Number);
    const startMs = (h * 60 + m) * 60000;
    const endMs   = startMs + bookingData.durasi * 3600000;
    const endH    = String(Math.floor(endMs / 3600000) % 24).padStart(2, "0");
    const endM    = String(Math.floor((endMs % 3600000) / 60000)).padStart(2, "0");
    const jamSelesai = `${endH}:${endM}`;

    const modal = document.createElement("div");
    modal.id = "modalPembayaran";
    modal.innerHTML = `
        <div class="struk-overlay" onclick="tutupPembayaran()"></div>
        <div class="struk-modal">
            <div class="bayar-header">
                <h2>💳 Konfirmasi Pembayaran</h2>
                <p>Periksa detail booking dan lakukan pembayaran</p>
            </div>

            <!-- DETAIL BOOKING -->
            <div class="bayar-detail">
                <div class="struk-row"><span>Nama</span><span>${escapeHtml(bookingData.nama)}</span></div>
                <div class="struk-row"><span>Meja</span><span>Meja ${bookingData.meja_id}</span></div>
                <div class="struk-row"><span>Tanggal</span><span>${tanggal}</span></div>
                <div class="struk-row"><span>Jam Mulai</span><span>${formatTime(bookingData.jam_mulai)}</span></div>
                <div class="struk-row"><span>Jam Selesai</span><span>${formatTime(jamSelesai)}</span></div>
                <div class="struk-row"><span>Durasi</span><span>${bookingData.durasi} Jam</span></div>
                <div class="struk-row struk-row-total">
                    <span>Total Bayar</span>
                    <span class="total-harga">${formatRupiah(totalHarga)}</span>
                </div>
            </div>

            <hr style="border:1px dashed #cbd5e0;margin:14px 0">

            <!-- INFO PEMBAYARAN -->
            <div class="bayar-info">
                <p class="bayar-label">📱 Scan QRIS atau Transfer ke:</p>
                
                ${INFO_BAYAR.qrisUrl ? `
                <div class="qris-wrap">
                    <img src="${INFO_BAYAR.qrisUrl}" alt="QRIS" class="qris-img">
                    <small>Scan QR di atas untuk bayar</small>
                </div>
                ` : `
                <div class="qris-wrap">
                    <div class="qris-placeholder">📱 QRIS</div>
                    <small>Tempel gambar QRIS di sini</small>
                </div>
                `}

                <div class="rek-info">
                    <div class="rek-row">
                        <span>🏦 Bank</span>
                        <strong>${INFO_BAYAR.bank}</strong>
                    </div>
                    <div class="rek-row">
                        <span>💳 No. Rekening</span>
                        <strong class="no-rek" onclick="copyRek()">${INFO_BAYAR.noRek} 📋</strong>
                    </div>
                    <div class="rek-row">
                        <span>👤 Atas Nama</span>
                        <strong>${INFO_BAYAR.atasNama}</strong>
                    </div>
                    <div class="rek-row rek-nominal">
                        <span>💰 Nominal</span>
                        <strong class="total-harga">${formatRupiah(totalHarga)}</strong>
                    </div>
                </div>
            </div>

            <p class="bayar-note">
                ⚠️ Lakukan pembayaran sebelum atau saat tiba di tempat.
            </p>

            <!-- TOMBOL -->
            <div class="struk-actions">
                <button onclick="konfirmasiBooking()" class="btn-print">✅ Sudah / Akan Bayar</button>
                <button onclick="tutupPembayaran()" class="btn-tutup">✕ Batal</button>
            </div>
        </div>
    `;

    // Simpan data booking untuk dipakai saat konfirmasi
    window._pendingBooking = bookingData;
    window._pendingForm    = form;

    document.body.appendChild(modal);
}

function tutupPembayaran() {
    const modal = document.getElementById("modalPembayaran");
    if (modal) modal.remove();
    window._pendingBooking = null;
}

function copyRek() {
    navigator.clipboard.writeText(INFO_BAYAR.noRek).then(() => {
        showAlert("✅ Nomor rekening disalin!", "success");
    });
}

// ====== KONFIRMASI → KIRIM BOOKING KE SERVER ======
async function konfirmasiBooking() {
    const bookingData = window._pendingBooking;
    const form        = window._pendingForm;

    if (!bookingData) return;

    tutupPembayaran();

    try {
        showAlert("⏳ Memproses booking...", "info");

        const response = await fetch("/api/booking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bookingData),
        });

        const result = await response.json();

        if (response.ok) {
            // Tambahkan total harga ke result untuk struk
            result.total_harga = bookingData.durasi * HARGA_PER_JAM;

            if (form) form.reset();
            updateHargaPreview();

            // Tampilkan struk
            showStruk(result);

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

// ====== STRUK BOOKING ======
function showStruk(data) {
    const old = document.getElementById("modalStruk");
    if (old) old.remove();

    const tanggal = new Date().toLocaleDateString("id-ID", {
        weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    const totalHarga = data.total_harga || (data.durasi * HARGA_PER_JAM);

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
                    <div class="struk-row"><span>Nama</span><span>${escapeHtml(data.nama)}</span></div>
                    <div class="struk-row"><span>Meja</span><span>Meja ${data.meja_id}</span></div>
                    <div class="struk-row"><span>Tanggal</span><span>${tanggal}</span></div>
                    <div class="struk-row"><span>Jam Mulai</span><span>${formatTime(data.jam_mulai)}</span></div>
                    <div class="struk-row"><span>Jam Selesai</span><span>${formatTime(data.jam_selesai)}</span></div>
                    <div class="struk-row"><span>Durasi</span><span>${data.durasi} Jam</span></div>
                    <div class="struk-row"><span>Metode Bayar</span><span>Transfer/QRIS</span></div>
                    <div class="struk-row struk-row-total">
                        <span>Total Bayar</span>
                        <span class="total-harga">${formatRupiah(totalHarga)}</span>
                    </div>
                    <hr>
                    <div class="struk-kode">
                        <p>🔑 Kode Aktivasi Anda:</p>
                        <h1>${escapeHtml(data.kode_aktivasi)}</h1>
                        <small>
                            Simpan kode ini! Gunakan jika Anda terlambat datang.<br>
                            Lampu otomatis mati jika tidak ada aktivitas 15 menit.
                        </small>
                    </div>
                </div>
                <div class="struk-footer">
                    <small>Terima kasih telah booking di Genzyeeeh Billiard! 🎱</small>
                </div>
            </div>
            <div class="struk-actions">
                <button onclick="simpanPDF('${data.kode_aktivasi}', ${totalHarga}, '${data.nama}', '${data.meja_id}', '${tanggal}', '${formatTime(data.jam_mulai)}', '${formatTime(data.jam_selesai)}', ${data.durasi})" class="btn-print">💾 Simpan PDF</button>
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

// ====== SIMPAN PDF ======
async function simpanPDF(kode, totalHarga, nama, meja, tanggal, jamMulai, jamSelesai, durasi) {
    if (!window.jspdf) {
        await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [80, 170] });

    const W = 80;
    let y = 10;

    // HEADER
    doc.setFontSize(14);
    doc.setFont("courier", "bold");
    doc.text("Genzyeeeh Billiard", W / 2, y, { align: "center" });
    y += 6;
    doc.setFontSize(9);
    doc.setFont("courier", "normal");
    doc.text("Bukti Booking Resmi", W / 2, y, { align: "center" });
    y += 5;
    doc.setLineDash([1, 1]);
    doc.line(5, y, W - 5, y);
    y += 6;

    // DATA BOOKING
    const rows = [
        ["Nama",        nama],
        ["Meja",        "Meja " + meja],
        ["Tanggal",     tanggal],
        ["Jam Mulai",   jamMulai],
        ["Jam Selesai", jamSelesai],
        ["Durasi",      durasi + " Jam"],
        ["Metode",      "Transfer/QRIS"],
    ];

    doc.setFontSize(9);
    rows.forEach(([label, value]) => {
        doc.setFont("courier", "normal");
        doc.setTextColor(100, 100, 100);
        doc.text(label, 6, y);
        doc.setFont("courier", "bold");
        doc.setTextColor(20, 20, 20);
        doc.text(String(value), W - 6, y, { align: "right" });
        y += 7;
    });

    // TOTAL BAYAR
    doc.setLineDash([1, 1]);
    doc.line(5, y, W - 5, y);
    y += 5;
    doc.setFontSize(10);
    doc.setFont("courier", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text("Total Bayar", 6, y);
    doc.setFont("courier", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(formatRupiah(totalHarga), W - 6, y, { align: "right" });
    y += 5;

    // INFO TRANSFER
    doc.setLineDash([1, 1]);
    doc.line(5, y, W - 5, y);
    y += 6;
    doc.setFontSize(8);
    doc.setFont("courier", "bold");
    doc.setTextColor(20, 20, 20);
    doc.text("Info Pembayaran:", 6, y);
    y += 5;
    doc.setFont("courier", "normal");
    doc.setTextColor(60, 60, 60);
    doc.text(`Bank  : ${INFO_BAYAR.bank}`, 6, y); y += 5;
    doc.text(`No.Rek: ${INFO_BAYAR.noRek}`, 6, y); y += 5;
    doc.text(`A/N   : ${INFO_BAYAR.atasNama}`, 6, y); y += 5;
    doc.setFont("courier", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(`Nominal: ${formatRupiah(totalHarga)}`, 6, y);
    y += 7;

    // KODE AKTIVASI
    doc.setLineDash([1, 1]);
    doc.line(5, y, W - 5, y);
    y += 6;
    doc.setFontSize(9);
    doc.setFont("courier", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text("Kode Aktivasi Anda:", W / 2, y, { align: "center" });
    y += 7;
    doc.setDrawColor(37, 99, 235);
    doc.setLineWidth(0.5);
    doc.setLineDash([2, 1]);
    doc.roundedRect(10, y - 5, W - 20, 12, 2, 2);
    doc.setFontSize(16);
    doc.setFont("courier", "bold");
    doc.setTextColor(37, 99, 235);
    doc.text(kode, W / 2, y + 3, { align: "center" });
    y += 16;
    doc.setFontSize(7.5);
    doc.setFont("courier", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text("Gunakan kode ini jika terlambat datang.", W / 2, y, { align: "center" });
    y += 8;

    // FOOTER
    doc.setLineDash([1, 1]);
    doc.line(5, y, W - 5, y);
    y += 5;
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text("Terima kasih telah booking di", W / 2, y, { align: "center" });
    y += 4;
    doc.text("Genzyeeeh Billiard!", W / 2, y, { align: "center" });

    const fileName = `Struk-${kode}-${new Date().toLocaleDateString("id-ID").replace(/\//g, "-")}.pdf`;
    doc.save(fileName);
}

// ====== CEK BENTROK ======
function checkBookingConflict(jamMulai, durasi, mejaId) {
    const newStart = timeToMinutes(jamMulai);
    const newEnd   = newStart + durasi * 60;
    return bookings.find((b) => {
        if (b.status === "completed") return false;
        if (Number(b.meja_id) !== Number(mejaId)) return false;
        const start = timeToMinutes(b.jam_mulai);
        const end   = timeToMinutes(b.jam_selesai);
        return newStart < end && newEnd > start;
    });
}

function timeToMinutes(t) {
    const [h, m] = String(t).split(":").map(Number);
    return (Number(h) || 0) * 60 + (Number(m) || 0);
}

// ====== AKTIVASI KODE ======
async function aktivasiKode() {
    const input = document.getElementById("inputKodeAktivasi");
    const kode  = input ? input.value.trim().toUpperCase() : "";

    if (!kode) { showAlert("❌ Masukkan kode aktivasi dulu!", "error"); return; }

    const formatValid = /^BIL-\d{3}-\d{4}$/.test(kode);
    if (!formatValid) { showAlert("❌ Format kode salah. Contoh: BIL-001-2025", "error"); return; }

    try {
        showAlert("⏳ Mengaktifkan lampu...", "info");
        const response = await fetch("/api/aktivasi", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kode })
        });
        const result = await response.json();
        if (response.ok) {
            showAlert(`🎉 ${result.message} Selesai jam ${formatTime(result.jam_selesai)}`, "success");
            if (input) input.value = "";
            await updateLampuStatus();
            await loadBookings();
        } else {
            showAlert("❌ " + result.error, "error");
        }
    } catch (err) {
        showAlert("❌ Tidak bisa menghubungi server", "error");
    }
}

// ====== JAM REALTIME ======
function updateCurrentTime() {
    const el = document.getElementById("currentTime");
    if (el) {
        el.textContent = new Date().toLocaleTimeString("id-ID", {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    }
}

// ====== ALERT ======
function showAlert(message, type = "info") {
    let container = document.querySelector(".booking-wrapper") || document.body;
    const header  = container.querySelector ? container.querySelector("header") : null;
    const old     = container.querySelector ? container.querySelector(".alert") : null;
    if (old) old.remove();

    const alert = document.createElement("div");
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    alert.style.zIndex = 9999;

    if (header && container.insertBefore) container.insertBefore(alert, header.nextSibling);
    else container.appendChild(alert);

    setTimeout(() => { if (alert && alert.parentNode) alert.remove(); }, 5000);
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ====== FORMAT ======
function formatTime(t) {
    if (!t) return "--:--";
    const [h, m] = String(t).split(":");
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDate(d) {
    if (!d) return "--";
    try {
        return new Date(d).toLocaleDateString("id-ID", {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
        });
    } catch { return d; }
}

function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(/[&<>"']/g, (m) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
}

window.debugBilliard = () => console.log({ bookings, lampuStatus, time: new Date().toTimeString() });