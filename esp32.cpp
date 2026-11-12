#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>

// ======================================================
// WIFI
// ======================================================

WiFiMulti wifiMulti;

// Ganti dengan WiFi yang digunakan ESP32
const char* WIFI_1_SSID     = "NAMA_WIFI_RUMAH";
const char* WIFI_1_PASSWORD = "PASSWORD_WIFI_RUMAH";

const char* WIFI_2_SSID     = "NAMA_HOTSPOT";
const char* WIFI_2_PASSWORD = "PASSWORD_HOTSPOT";

// ======================================================
// SERVER
// ======================================================

const String serverUrl = "http://192.168.1.13:3000";

// WAJIB sama persis dengan ESP_API_KEY di file .env server.js
const String espKey = "ISI_DENGAN_API_KEY_YANG_SAMA";

// ======================================================
// PIN ESP32
// ======================================================

#define RELAY1 18
#define RELAY2 19
#define SENSOR1 34

// Relay aktif LOW
#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// Sensor getaran aktif HIGH
#define SENSOR_ACTIVE HIGH

// ======================================================
// INTERVAL
// ======================================================

const unsigned long SERVER_INTERVAL = 2000;
const unsigned long WIFI_INTERVAL = 5000;

const unsigned long SENSOR_DEBOUNCE = 500;
const unsigned long SENSOR_COOLDOWN = 5000;

// ======================================================
// VARIABEL
// ======================================================

unsigned long lastServerCheck = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastShakeSent = 0;

int lastSensorReading = LOW;
int stableSensorState = LOW;

unsigned long lastDebounceTime = 0;

// ======================================================
// HEADER AUTENTIKASI
// ======================================================

void addApiHeaders(HTTPClient &http) {
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-ESP-KEY", espKey);
}

// ======================================================
// KONTROL RELAY
// ======================================================

void relayMeja1(bool status) {
  digitalWrite(RELAY1, status ? RELAY_ON : RELAY_OFF);

  Serial.print("Relay Meja 1: ");
  Serial.println(status ? "ON" : "OFF");
}

void relayMeja2(bool status) {
  digitalWrite(RELAY2, status ? RELAY_ON : RELAY_OFF);

  Serial.print("Relay Meja 2: ");
  Serial.println(status ? "ON" : "OFF");
}

// ======================================================
// KONEKSI WIFI
// ======================================================

void connectWiFi() {
  Serial.println();
  Serial.println("Memeriksa koneksi WiFi...");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi terhubung: ");
    Serial.println(WiFi.SSID());
    return;
  }

  if (wifiMulti.run(10000) == WL_CONNECTED) {
    Serial.println("WiFi berhasil terhubung!");

    Serial.print("SSID: ");
    Serial.println(WiFi.SSID());

    Serial.print("IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi belum terhubung.");
  }
}

// ======================================================
// KIRIM DATA GETARAN MEJA 1
// ======================================================

void sendShake() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Getaran tidak dikirim: WiFi terputus.");
    return;
  }

  if (espKey.length() == 0 ||
      espKey == "ISI_DENGAN_API_KEY_YANG_SAMA") {
    Serial.println("ERROR: API KEY ESP32 belum diisi!");
    return;
  }

  HTTPClient http;
  WiFiClient client;

  String url = serverUrl + "/api/shake";

  http.setTimeout(3000);
  http.begin(client, url);

  addApiHeaders(http);

  String payload = "{\"meja_id\":1}";

  Serial.println();
  Serial.println("Mengirim laporan getaran Meja 1...");

  int httpCode = http.POST(payload);

  Serial.print("HTTP Response Getaran: ");
  Serial.println(httpCode);

  if (httpCode > 0) {
    String response = http.getString();

    Serial.print("Server Response: ");
    Serial.println(response);
  } else {
    Serial.print("Gagal mengirim getaran: ");
    Serial.println(http.errorToString(httpCode));
  }

  http.end();
}

// ======================================================
// MEMERIKSA PERINTAH SERVER
// ======================================================

void checkServerCommand(int meja) {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (espKey.length() == 0 ||
      espKey == "ISI_DENGAN_API_KEY_YANG_SAMA") {
    Serial.println("ERROR: API KEY ESP32 belum diisi!");
    return;
  }

  HTTPClient http;
  WiFiClient client;

  String url = serverUrl + "/api/esp-command?meja=" + String(meja);

  http.setTimeout(3000);
  http.begin(client, url);

  addApiHeaders(http);

  int httpCode = http.GET();

  Serial.print("HTTP Command Meja ");
  Serial.print(meja);
  Serial.print(": ");
  Serial.println(httpCode);

  if (httpCode > 0) {
    String response = http.getString();

    response.trim();
    response.toUpperCase();

    Serial.print("Perintah Meja ");
    Serial.print(meja);
    Serial.print(": ");
    Serial.println(response);

    // ------------------------------------------
    // PERINTAH MEJA 1
    // ------------------------------------------

    if (meja == 1) {
      if (response == "ON1") {
        relayMeja1(true);
      }
      else if (response == "OFF1") {
        relayMeja1(false);
      }
    }

    // ------------------------------------------
    // PERINTAH MEJA 2
    // ------------------------------------------

    else if (meja == 2) {
      if (response == "ON2") {
        relayMeja2(true);
      }
      else if (response == "OFF2") {
        relayMeja2(false);
      }
    }
  } else {
    Serial.print("Gagal mengambil perintah: ");
    Serial.println(http.errorToString(httpCode));
  }

  http.end();
}

// ======================================================
// MEMERIKSA SENSOR GETARAN
// ======================================================

void checkVibrationSensor() {
  int reading = digitalRead(SENSOR1);

  if (reading != lastSensorReading) {
    lastDebounceTime = millis();
    lastSensorReading = reading;
  }

  if ((millis() - lastDebounceTime) > SENSOR_DEBOUNCE) {
    if (reading != stableSensorState) {
      stableSensorState = reading;

      // Hanya kirim laporan saat sensor mendeteksi getaran
      if (stableSensorState == SENSOR_ACTIVE) {
        unsigned long now = millis();

        if (now - lastShakeSent >= SENSOR_COOLDOWN) {
          Serial.println();
          Serial.println("GETARAN MEJA 1 TERDETEKSI!");

          sendShake();

          lastShakeSent = now;
        }
      }
    }
  }
}

// ======================================================
// SETUP
// ======================================================

void setup() {
  Serial.begin(115200);

  Serial.println();
  Serial.println("==================================");
  Serial.println(" SMART BILLIARD ESP32");
  Serial.println("==================================");

  // Konfigurasi relay
  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);

  // Pastikan lampu mati saat ESP32 mulai
  relayMeja1(false);
  relayMeja2(false);

  // Konfigurasi sensor
  pinMode(SENSOR1, INPUT);

  lastSensorReading = digitalRead(SENSOR1);
  stableSensorState = lastSensorReading;

  // Tambahkan jaringan WiFi
  wifiMulti.addAP(WIFI_1_SSID, WIFI_1_PASSWORD);
  wifiMulti.addAP(WIFI_2_SSID, WIFI_2_PASSWORD);

  // Hubungkan WiFi
  connectWiFi();

  Serial.println();
  Serial.println("ESP32 siap menjalankan sistem.");
}

// ======================================================
// LOOP
// ======================================================

void loop() {
  unsigned long now = millis();

  // ------------------------------------------
  // PERIKSA WIFI
  // ------------------------------------------

  if (now - lastWifiCheck >= WIFI_INTERVAL) {
    lastWifiCheck = now;

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi terputus, mencoba menghubungkan kembali...");
      connectWiFi();
    }
  }

  // ------------------------------------------
  // BACA SENSOR GETARAN
  // ------------------------------------------

  if (WiFi.status() == WL_CONNECTED) {
    checkVibrationSensor();
  }

  // ------------------------------------------
  // AMBIL PERINTAH SERVER
  // ------------------------------------------

  if (now - lastServerCheck >= SERVER_INTERVAL) {
    lastServerCheck = now;

    if (WiFi.status() == WL_CONNECTED) {
      checkServerCommand(1);
      checkServerCommand(2);
    }
  }
}
