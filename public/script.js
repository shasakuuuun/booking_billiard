// Global variables
let bookings = [];
let lampuStatus = false;

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Smart Billiard System loaded');
    
    // Load initial data
    loadBookings();
    updateLampuStatus();
    updateCurrentTime();
    
    // Setup form submission
    const bookingForm = document.getElementById('bookingForm');
    if (bookingForm) {
        bookingForm.addEventListener('submit', handleBookingSubmit);
    }

    // Auto refresh every 30 seconds
    setInterval(() => {
        loadBookings();
        updateLampuStatus();
        updateCurrentTime();
    }, 30000);

    // Update time every second
    setInterval(updateCurrentTime, 1000);

    console.log('✅ All event listeners attached');
});

// Load bookings from server
async function loadBookings() {
    try {
        console.log('📡 Loading bookings...');
        const response = await fetch('/api/bookings');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        bookings = await response.json();
        console.log(`📋 Loaded ${bookings.length} bookings`);
        
        displaySchedule();
        
    } catch (error) {
        console.error('❌ Error loading bookings:', error);
        showAlert('Error loading bookings: ' + error.message, 'error');
    }
}

// Display schedule on main page
function displaySchedule() {
    const scheduleList = document.getElementById('scheduleList');
    if (!scheduleList) return;

    if (bookings.length === 0) {
        scheduleList.innerHTML = `
            <div class="empty-state">
                <h3>📭 Belum ada booking hari ini</h3>
                <p>Jadilah yang pertama booking billiard!</p>
            </div>
        `;
        return;
    }

    const currentTime = new Date().toTimeString().slice(0, 5);
    const currentDateTime = new Date();
    
    scheduleList.innerHTML = bookings.map(booking => {
        const isActive = booking.status === 'active' || 
                        (booking.jam_mulai <= currentTime && booking.jam_selesai > currentTime);
        const isCompleted = booking.status === 'completed' || booking.jam_selesai <= currentTime;
        
        let statusClass = 'status-pending';
        let statusText = '⏱️ Menunggu';
        
        if (isCompleted) {
            statusClass = 'status-completed';
            statusText = '✅ Selesai';
        } else if (isActive) {
            statusClass = 'status-active';
            statusText = '🔴 Sedang Main';
        }
        
        const itemClass = isCompleted ? 'schedule-item completed' : 
                         isActive ? 'schedule-item active' : 'schedule-item';
        
        return `
            <div class="${itemClass}">
                <h4>👤 ${booking.nama}</h4>
                <p>⏰ ${formatTime(booking.jam_mulai)} - ${formatTime(booking.jam_selesai)}</p>
                <p>⏱️ Durasi: ${booking.durasi} jam</p>
                <p>📅 Tanggal: ${formatDate(booking.tanggal)}</p>
                <span class="schedule-status ${statusClass}">${statusText}</span>
            </div>
        `;
    }).join('');
}

// Update lampu status
async function updateLampuStatus() {
    try {
        const response = await fetch('/api/lampu/status');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const lampuData = await response.json();
        
        if (lampuData.length > 0) {
            const newStatus = lampuData[0].status_lampu;
            
            // Only update if status changed
            if (newStatus !== lampuStatus) {
                lampuStatus = newStatus;
                console.log(`💡 Lampu status changed: ${lampuStatus ? 'ON' : 'OFF'}`);
            }
            
            // Update status indicators
            const statusText = lampuStatus ? '🔴 Lampu: ON' : '⚫ Lampu: OFF';
            const lampuStatusEl = document.getElementById('lampuStatus');
            
            if (lampuStatusEl) {
                lampuStatusEl.textContent = statusText;
                const indicator = lampuStatusEl.parentElement;
                if (lampuStatus) {
                    indicator.classList.add('active');
                } else {
                    indicator.classList.remove('active');
                }
            }
        }
    } catch (error) {
        console.error('❌ Error updating lampu status:', error);
    }
}

// Handle booking form submission
async function handleBookingSubmit(e) {
    e.preventDefault();
    
    console.log('📝 Submitting booking form...');
    
    const formData = new FormData(e.target);
    const bookingData = {
        nama: formData.get('nama').trim(),
        jam_mulai: formData.get('jamMulai'),
        durasi: parseInt(formData.get('durasi'))
    };

    // Validasi input
    if (!bookingData.nama || !bookingData.jam_mulai || !bookingData.durasi) {
        showAlert('❌ Semua field harus diisi!', 'error');
        return;
    }

    // Validasi nama minimal 2 karakter
    if (bookingData.nama.length < 2) {
        showAlert('❌ Nama minimal 2 karakter!', 'error');
        return;
    }

    // Validasi waktu booking
    const now = new Date();
    const bookingTime = new Date();
    const [hours, minutes] = bookingData.jam_mulai.split(':');
    bookingTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    // Cek apakah booking untuk hari ini dan waktu sudah lewat
    if (bookingTime < now) {
        showAlert('❌ Tidak bisa booking untuk waktu yang sudah lewat!', 'error');
        return;
    }

    // Cek konflik dengan booking yang sudah ada
    const conflict = checkBookingConflict(bookingData.jam_mulai, bookingData.durasi);
    if (conflict) {
        showAlert(`❌ Waktu bentrok dengan booking ${conflict.nama} (${conflict.jam_mulai}-${conflict.jam_selesai})!`, 'error');
        return;
    }

    try {
        showAlert('⏳ Memproses booking...', 'info');
        
        const response = await fetch('/api/booking', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bookingData)
        });

        const result = await response.json();
        
        if (response.ok) {
            console.log('✅ Booking successful:', result);
            showAlert(`🎉 Booking berhasil! Lampu akan otomatis nyala pada ${formatTime(bookingData.jam_mulai)}`, 'success');
            
            // Reset form
            e.target.reset();
            
            // Refresh booking list
            setTimeout(() => {
                loadBookings();
            }, 1000);
            
        } else {
            console.error('❌ Booking failed:', result);
            showAlert(`❌ ${result.error || 'Booking gagal!'}`, 'error');
        }
    } catch (error) {
        console.error('❌ Error submitting booking:', error);
        showAlert('❌ Error: Tidak bisa menghubungi server', 'error');
    }
}

// Check booking conflict
function checkBookingConflict(jamMulai, durasi) {
    const newStart = timeToMinutes(jamMulai);
    const newEnd = newStart + (durasi * 60);
    
    return bookings.find(booking => {
        if (booking.status === 'completed') return false;
        
        const existingStart = timeToMinutes(booking.jam_mulai);
        const existingEnd = timeToMinutes(booking.jam_selesai);
        
        // Check overlap
        return (newStart < existingEnd && newEnd > existingStart);
    });
}

// Convert time to minutes for comparison
function timeToMinutes(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + minutes;
}

// Update current time display
function updateCurrentTime() {
    const currentTimeEl = document.getElementById('currentTime');
    if (currentTimeEl) {
        const now = new Date();
        const timeString = now.toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        currentTimeEl.textContent = timeString;
    }
}

// Show alert messages
function showAlert(message, type = 'info') {
    console.log(`Alert [${type}]: ${message}`);
    
    // Remove existing alerts
    const existingAlert = document.querySelector('.alert');
    if (existingAlert) {
        existingAlert.remove();
    }

    // Create new alert
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;

    // Insert alert at the top of container
    const container = document.querySelector('.container');
    const header = container.querySelector('header');
    container.insertBefore(alert, header.nextSibling);

    // Auto remove after 5 seconds
    setTimeout(() => {
        if (alert.parentNode) {
            alert.remove();
        }
    }, 5000);

    // Scroll to top to show alert
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Utility function to format time
function formatTime(timeString) {
    if (!timeString) return '--:--';
    
    try {
        const [hours, minutes] = timeString.split(':');
        return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
    } catch (error) {
        console.error('Error formatting time:', error);
        return timeString;
    }
}

// Utility function to format date
function formatDate(dateString) {
    if (!dateString) return '--';
    
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('id-ID', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (error) {
        console.error('Error formatting date:', error);
        return dateString;
    }
}

// Debug function - can be called from browser console
window.debugBilliard = function() {
    console.log('🔍 Debug Info:');
    console.log('Bookings:', bookings);
    console.log('Lampu Status:', lampuStatus);
    console.log('Current Time:', new Date().toTimeString().slice(0, 5));
};