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
    }
}

// ====== TAMPILKAN JADWAL ======
function displaySchedule() {
    const scheduleList = document.getElementById("scheduleList");
    if (!scheduleList) return;

    if (bookings.length === 0) {
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
                    <h4>👤 ${booking.nama}</h4>
                    <p>⏰ ${formatTime(booking.jam_mulai)} - ${formatTime(
                booking.jam_selesai
            )}</p>
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
        if (!lampuData.length) return;

        const newStatus = lampuData[0].status_lampu;
        lampuStatus = newStatus;

        const lampuStatusEl = document.getElementById("lampuStatus");

        if (lampuStatusEl) {
            lampuStatusEl.textContent = lampuStatus
                ? "🔴 Lampu: ON"
                : "⚫ Lampu: OFF";

            lampuStatusEl.parentElement.classList.toggle(
                "active",
                lampuStatus
            );
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
        nama: formData.get("nama").trim(),
        jam_mulai: formData.get("jamMulai"),
        durasi: Number(formData.get("durasi")),
        meja_id: Number(formData.get("meja")),
    };

    // Validasi
    if (!bookingData.nama || !bookingData.jam_mulai || !bookingData.durasi) {
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
    const [h, m] = bookingData.jam_mulai.split(":");
    bookingTime.setHours(h, m, 0, 0);

    if (bookingTime < now) {
        showAlert("❌ Tidak bisa booking waktu yang sudah lewat!", "error");
        return;
    }

    // Cek bentrok
    const conflict = checkBookingConflict(
        bookingData.jam_mulai,
        bookingData.durasi
    );
    if (conflict) {
        showAlert(
            `❌ Bentrok dengan booking ${conflict.nama} (${conflict.jam_mulai} - ${conflict.jam_selesai})`,
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
            showAlert(
                `🎉 Booking berhasil! Lampu akan otomatis nyala jam ${formatTime(
                    bookingData.jam_mulai
                )}`,
                "success"
            );

            e.target.reset();
            loadBookings();
        } else {
            showAlert("❌ " + (result.error || "Booking gagal"), "error");
        }
    } catch (err) {
        showAlert("❌ Tidak bisa menghubungi server", "error");
    }
}

// ====== CEK BENTROK BOOKING ======
function checkBookingConflict(jamMulai, durasi) {
    const newStart = timeToMinutes(jamMulai);
    const newEnd = newStart + durasi * 60;

    return bookings.find((b) => {
        if (b.status === "completed") return false;

        const start = timeToMinutes(b.jam_mulai);
        const end = timeToMinutes(b.jam_selesai);

        return newStart < end && newEnd > start;
    });
}

function timeToMinutes(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
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
    const container = document.querySelector(".booking-wrapper");

    if (!container) return;

    const old = container.querySelector(".alert");
    if (old) old.remove();

    const alert = document.createElement("div");
    alert.className = `alert alert-${type}`;
    alert.textContent = message;

    const header = container.querySelector("header");
    container.insertBefore(alert, header.nextSibling);

    setTimeout(() => alert.remove(), 5000);
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// ====== FORMAT TIME/DATE ======
function formatTime(t) {
    if (!t) return "--:--";
    const [h, m] = t.split(":");
    return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

function formatDate(d) {
    if (!d) return "--";
    return new Date(d).toLocaleDateString("id-ID", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

// ====== DEBUG ======
window.debugBilliard = () => {
    console.log({
        bookings,
        lampuStatus,
        time: new Date().toTimeString(),
    });
};
