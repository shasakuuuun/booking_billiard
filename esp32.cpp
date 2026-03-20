#include <WiFi.h>
#include <HTTPClient.h>

// ================== WIFI CONFIG ==================
const char* ssid     = "NAMA_WIFI_LO";
const char* password = "PASSWORD_WIFI_LO";

// ================== SERVER CONFIG ==================
String serverUrl = "http://10.56.202.200:3000";

// ================== RELAY PINS ==================
#define RELAY1 18  // GPIO18 → Relay Channel 1 → Lampu Meja 1
#define RELAY2 19  // GPIO19 → Relay Channel 2 → Lampu Meja 2

// ================== SENSOR GETAR SW-420 ==================
#define SENSOR1 34  // GPIO34 → Sensor getar Meja 1
#define SENSOR2 35  // GPIO35 → Sensor getar Meja 2

// ================== KONFIGURASI ==================
#define SHAKE_DEBOUNCE_MS   500    // Debounce antar getaran
#define SHAKE_COOLDOWN_MS   10000  // Cooldown reset timer ke server (10 detik)

// ================== STATE ==================
unsigned long lastShakeTime1 = 0;
unsigned long lastShakeTime2 = 0;
unsigned long lastSendReset1 = 0;
unsigned long lastSendReset2 = 0;

// ================== SETUP ==================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("========================================");
  Serial.println("   SMART BILLIARD ESP32 - STARTING");
  Serial.println("========================================");

  // Setup Relay — aktif LOW, default OFF
  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);
  digitalWrite(RELAY1, HIGH);
  digitalWrite(RELAY2, HIGH);

  // Setup Sensor Getar
  pinMode(SENSOR1, INPUT);
  pinMode(SENSOR2, INPUT);

  Serial.println("✅ Pin setup selesai");
  Serial.println("💡 Relay  : MEJA1=GPIO18 | MEJA2=GPIO19");
  Serial.println("🔔 Sensor : MEJA1=GPIO34 | MEJA2=GPIO35");
  Serial.println("📌 Mode   : Sensor HANYA reset timer (tidak nyalain lampu)");

  // Koneksi WiFi
  Serial.println("📡 Connecting WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 30) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    Serial.print("📍 IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("📶 Signal: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else {
    Serial.println("\n❌ WiFi Failed! Restarting...");
    delay(3000);
    ESP.restart();
  }
}

// ================== MAIN LOOP ==================
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    reconnectWiFi();
    return;
  }

  // Cek sensor getar — HANYA untuk reset timer, tidak nyalain lampu
  checkShakeSensor(1, SENSOR1, lastShakeTime1, lastSendReset1);
  checkShakeSensor(2, SENSOR2, lastShakeTime2, lastSendReset2);

  // Cek command dari server (ON/OFF)
  checkCommandForMeja(1);
  delay(300);
  checkCommandForMeja(2);
  delay(1500);
}

// ================== CEK SENSOR GETAR ==================
// Fungsi ini HANYA reset timer di server
// Lampu TIDAK akan nyala dari sini
// ======================================================
void checkShakeSensor(int mejaId, int pin, unsigned long &lastShake, unsigned long &lastSend) {
  int val = digitalRead(pin);

  // SW-420: LOW = ada getaran
  if (val == LOW) {
    unsigned long now = millis();

    // Debounce
    if (now - lastShake < SHAKE_DEBOUNCE_MS) return;
    lastShake = now;

    Serial.print("🔔 AKTIVITAS TERDETEKSI → Meja ");
    Serial.println(mejaId);

    // Kirim reset timer ke server (dengan cooldown supaya tidak spam)
    if (now - lastSend >= SHAKE_COOLDOWN_MS) {
      lastSend = now;
      sendResetTimer(mejaId);
    }
  }
}

// ================== KIRIM RESET TIMER KE SERVER ==================
// Server akan reset countdown 15 menit
// Lampu TIDAK dinyalakan dari sini
// ================================================================
void sendResetTimer(int mejaId) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = serverUrl + "/api/shake";

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"meja_id\":" + String(mejaId) + ",\"reset_only\":true}";
  int httpCode = http.POST(body);

  if (httpCode == 200) {
    Serial.print("✅ Timer direset → Meja ");
    Serial.print(mejaId);
    Serial.println(" (lampu tidak berubah)");
  } else {
    Serial.print("❌ Gagal reset timer, kode: ");
    Serial.println(httpCode);
  }

  http.end();
}

// ================== CHECK COMMAND per MEJA ==================
void checkCommandForMeja(int mejaID) {
  HTTPClient http;

  String url = serverUrl + "/api/esp-command?meja=" + String(mejaID);

  http.begin(url);
  http.setTimeout(3000);
  int httpCode = http.GET();

  if (httpCode == 200) {
    String cmd = http.getString();
    cmd.trim();

    if (cmd.length() > 0) {
      Serial.print("📨 Command meja ");
      Serial.print(mejaID);
      Serial.print(": ");
      Serial.println(cmd);
    }

    if (cmd == "ON1") {
      digitalWrite(RELAY1, LOW);
      Serial.println("💡 Meja 1 NYALA");
    }
    else if (cmd == "OFF1") {
      digitalWrite(RELAY1, HIGH);
      Serial.println("⚫ Meja 1 MATI");
    }
    else if (cmd == "ON2") {
      digitalWrite(RELAY2, LOW);
      Serial.println("💡 Meja 2 NYALA");
    }
    else if (cmd == "OFF2") {
      digitalWrite(RELAY2, HIGH);
      Serial.println("⚫ Meja 2 MATI");
    }
  }

  http.end();
}

// ================== WIFI RECONNECT ==================
void reconnectWiFi() {
  Serial.println("🔄 Reconnecting WiFi...");

  WiFi.disconnect();
  WiFi.begin(ssid, password);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Reconnected!");
    Serial.print("📍 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ Failed! Restarting ESP...");
    ESP.restart();
  }
}