#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>

// ================== WIFI CONFIG ==================
// Isi kedua jaringan. ESP32 otomatis memakai jaringan yang tersedia.
WiFiMulti wifiMulti;

const char* WIFI_RUMAH_SSID = "NAMA_WIFI_RUMAH";
const char* WIFI_RUMAH_PASS = "PASSWORD_WIFI_RUMAH";

const char* WIFI_HOTSPOT_SSID = "NAMA_HOTSPOT_HP";
const char* WIFI_HOTSPOT_PASS = "PASSWORD_HOTSPOT_HP";

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

    // Daftarkan Wi-Fi rumah dan hotspot sidang.
    WiFi.mode(WIFI_STA);
    wifiMulti.addAP(WIFI_RUMAH_SSID, WIFI_RUMAH_PASS);
    wifiMulti.addAP(WIFI_HOTSPOT_SSID, WIFI_HOTSPOT_PASS);

    Serial.println("📡 Mencari Wi-Fi rumah atau hotspot...");
    unsigned long wifiStart = millis();
    while (wifiMulti.run() != WL_CONNECTED && millis() - wifiStart < 20000) {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println();
        Serial.println("========================================");
        Serial.println("✅ WiFi Connected!");
        Serial.print("📶 SSID        : ");
        Serial.println(WiFi.SSID());