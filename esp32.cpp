#include <WiFi.h>
#include <HTTPClient.h>

// ================== WIFI CONFIG ==================
const char* ssid     = "";
const char* password = "";

// ================== SERVER CONFIG ==================
// IP laptop saat pakai USB Tethering
// Cek ulang dengan: buka CMD → ipconfig → lihat Ethernet 2
String serverUrl = "";

// Kunci rahasia ESP32 — harus SAMA dengan ESP_API_KEY di file .env server
// (kosongkan kalau ESP_API_KEY di server tidak dipakai)
const char* espKey = "";

// ================== RELAY ==================
#define RELAY1 18  // GPIO18 → Relay Channel 1 → Lampu Meja 1
#define RELAY2 19  // GPIO19 → Relay Channel 2 → Lampu Meja 2

// ================== SENSOR ==================
// Hanya Meja 1 yang ada hardware sensor
#define SENSOR1 34  // GPIO34 → Sensor getar Meja 1

// ================== SENSOR CONFIG ==================
#define SHAKE_DEBOUNCE_MS 500   // Debounce antar getaran (ms)
#define SHAKE_COOLDOWN_MS 5000  // Cooldown kirim ke server (ms)

// ================== TIMER ==================
const unsigned long SERVER_INTERVAL = 2000; // Polling server tiap 2 detik
const unsigned long WIFI_INTERVAL   = 5000; // Cek WiFi tiap 5 detik

// ================== STATE ==================
unsigned long lastShakeTime1  = 0;
unsigned long lastSendReset1  = 0;
unsigned long lastServerCheck = 0;
unsigned long lastWifiCheck   = 0;

//====================================================
// SET RELAY (Aktif LOW)
//====================================================
void setRelay(uint8_t relayPin, bool on) {
    digitalWrite(relayPin, on ? LOW : HIGH);
}

//====================================================
// SETUP
//====================================================
void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println();
    Serial.println("========================================");
    Serial.println(" SMART BILLIARD ESP32");
    Serial.println("========================================");

    // Setup Relay — default OFF
    pinMode(RELAY1, OUTPUT);
    pinMode(RELAY2, OUTPUT);
    setRelay(RELAY1, false);
    setRelay(RELAY2, false);

    // Setup Sensor Getar Meja 1
    pinMode(SENSOR1, INPUT);

    Serial.println("✅ Relay dan Sensor siap");
    Serial.println("💡 Relay  : MEJA1=GPIO18 | MEJA2=GPIO19");
    Serial.println("🔔 Sensor : MEJA1=GPIO34 (aktif)");
    Serial.println("📌 Sensor HANYA reset timer (tidak nyalain lampu)");

    // Koneksi WiFi
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    Serial.print("📡 Menghubungkan ke WiFi");

    const int MAX_RETRY = 30;
    int retry = 0;

    while (WiFi.status() != WL_CONNECTED && retry < MAX_RETRY) {
        delay(500);
        Serial.print(".");
        retry++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println();
        Serial.println("========================================");
        Serial.println("✅ WiFi Connected!");
        Serial.print("📍 IP Address : ");
        Serial.println(WiFi.localIP());
        Serial.print("📶 Signal     : ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
        Serial.print("🌐 Server     : ");
        Serial.println(serverUrl);
        Serial.println("========================================");
    } else {
        Serial.println();
        Serial.println("❌ Gagal konek WiFi! Restarting...");
        delay(3000);
        ESP.restart();
    }
}

//====================================================
// LOOP
//====================================================
void loop() {
    // Cek WiFi tiap 5 detik
    if (millis() - lastWifiCheck >= WIFI_INTERVAL) {
        lastWifiCheck = millis();
        if (WiFi.status() != WL_CONNECTED) {
            reconnectWiFi();
        }
    }

    if (WiFi.status() != WL_CONNECTED) return;

    // Sensor Meja 1 selalu aktif
    // HANYA reset timer di server — tidak nyalain lampu
    checkShakeSensor(1, SENSOR1, lastShakeTime1, lastSendReset1);

    // Polling command server tiap 2 detik
    if (millis() - lastServerCheck >= SERVER_INTERVAL) {
        lastServerCheck = millis();
        checkCommandForMeja(1);
        checkCommandForMeja(2);
    }
}

//====================================================
// CEK SENSOR GETAR
// HANYA kirim reset timer ke server
// Lampu TIDAK akan nyala dari sini
//====================================================
void checkShakeSensor(int mejaId, int pin, unsigned long &lastShake, unsigned long &lastSend) {
    if (digitalRead(pin) == LOW) {
        unsigned long now = millis();

        // Debounce — abaikan getaran terlalu cepat
        if (now - lastShake < SHAKE_DEBOUNCE_MS) return;
        lastShake = now;

        Serial.print("🔔 Aktivitas terdeteksi → Meja ");
        Serial.println(mejaId);

        // Cooldown — tidak spam server
        if (now - lastSend >= SHAKE_COOLDOWN_MS) {
            lastSend = now;
            sendResetTimer(mejaId);
        }
    }
}

//====================================================
// KIRIM RESET TIMER KE SERVER
// Server reset countdown 25 detik (demo) / 15 menit (produksi)
// Lampu TIDAK dinyalakan dari sini
//====================================================
void sendResetTimer(int mejaId) {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    String url = serverUrl + "/api/shake";

    http.setConnectTimeout(3000);
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-esp-key", espKey);

    // reset_only: true → hanya reset timer, lampu tidak berubah
    String body = "{\"meja_id\":" + String(mejaId) + ",\"reset_only\":true}";

    int httpCode = http.POST(body);

    if (httpCode == 200) {
        Serial.print("✅ Timer direset → Meja ");
        Serial.print(mejaId);
        Serial.println(" (lampu tidak berubah)");
    } else {
        Serial.print("❌ Reset timer gagal. HTTP: ");
        Serial.println(httpCode);
    }

    http.end();
}

//====================================================
// CEK COMMAND DARI SERVER
// Server yang memutuskan ON/OFF berdasarkan jadwal booking
//====================================================
void checkCommandForMeja(int mejaID) {
    HTTPClient http;
    String url = serverUrl + "/api/esp-command?meja=" + String(mejaID);

    http.setConnectTimeout(3000);
    http.begin(url);
    http.addHeader("x-esp-key", espKey);
    http.setTimeout(3000);

    int httpCode = http.GET();

    if (httpCode == 200) {
        String cmd = http.getString();
        cmd.trim();

        if (cmd == "") {
            http.end();
            return;
        }

        Serial.print("📨 Command Meja ");
        Serial.print(mejaID);
        Serial.print(" → ");
        Serial.println(cmd);

        if (cmd == "ON1") {
            setRelay(RELAY1, true);
            Serial.println("💡 Lampu Meja 1 NYALA");
        } else if (cmd == "OFF1") {
            setRelay(RELAY1, false);
            Serial.println("⚫ Lampu Meja 1 MATI");
        } else if (cmd == "ON2") {
            setRelay(RELAY2, true);
            Serial.println("💡 Lampu Meja 2 NYALA");
        } else if (cmd == "OFF2") {
            setRelay(RELAY2, false);
            Serial.println("⚫ Lampu Meja 2 MATI");
        }
    } else {
        Serial.print("❌ HTTP Error Meja ");
        Serial.print(mejaID);
        Serial.print(": ");
        Serial.println(httpCode);
    }

    http.end();
}

//====================================================
// WIFI RECONNECT
//====================================================
void reconnectWiFi() {
    Serial.println();
    Serial.println("========================================");
    Serial.println("🔄 Reconnecting WiFi...");
    Serial.println("========================================");

    WiFi.disconnect(true);
    delay(300);
    WiFi.begin(ssid, password);

    int retry = 0;
    while (WiFi.status() != WL_CONNECTED && retry < 20) {
        delay(500);
        Serial.print(".");
        retry++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println();
        Serial.println("✅ WiFi Reconnected!");
        Serial.print("📍 IP: ");
        Serial.println(WiFi.localIP());
        Serial.print("📶 RSSI: ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
    } else {
        Serial.println();
        Serial.println("❌ Reconnect gagal — akan coba lagi...");
    }
}