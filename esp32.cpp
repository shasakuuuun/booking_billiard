#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>

// ======================================================
// WIFI
// ======================================================
WiFiMulti wifiMulti;

const char* WIFI_RUMAH_SSID = "NAMA_WIFI_RUMAH";
const char* WIFI_RUMAH_PASS = "PASSWORD_WIFI_RUMAH";

const char* WIFI_HOTSPOT_SSID = "NAMA_HOTSPOT_HP";
const char* WIFI_HOTSPOT_PASS = "PASSWORD_HOTSPOT_HP";

// ======================================================
// SERVER
// ======================================================

// Ganti dengan IP laptop/PC yang menjalankan server.
// Contoh: http://192.168.1.10:3000
// Jangan menggunakan localhost.
String serverUrl = "http://192.168.1.10:3000";

// Harus sama dengan ESP_API_KEY di file .env.
// Jika ESP_API_KEY kosong di server, biarkan kosong di sini.
const char* espKey = "ISI_API_KEY_YANG_SAMA";

// ======================================================
// PIN
// ======================================================
#define RELAY1 18
#define RELAY2 19
#define SENSOR1 34

// Relay aktif LOW.
#define RELAY_ON LOW
#define RELAY_OFF HIGH

// Sesuaikan dengan modul sensor getar.
// Jika sensor menghasilkan HIGH saat bergetar,
// gunakan HIGH. Jika menghasilkan LOW, ubah ke LOW.
#define SENSOR_ACTIVE HIGH

// ======================================================
// INTERVAL
// ======================================================
const unsigned long SERVER_INTERVAL = 2000;
const unsigned long WIFI_INTERVAL = 5000;

const unsigned long SHAKE_DEBOUNCE_MS = 500;
const unsigned long SHAKE_COOLDOWN_MS = 5000;

// ======================================================
// TIMER
// ======================================================
unsigned long lastServerCheck = 0;
unsigned long lastWifiCheck = 0;

unsigned long lastShakeTime1 = 0;
unsigned long lastSendShake1 = 0;

// ======================================================
// STATUS
// ======================================================
bool lampu1 = false;
bool lampu2 = false;

bool lastSensorState = false;

// ======================================================
// RELAY
// ======================================================
void setRelay(uint8_t relayPin, bool on) {
    digitalWrite(
        relayPin,
        on ? RELAY_ON : RELAY_OFF
    );
}

void setLampu1(bool on) {
    lampu1 = on;
    setRelay(RELAY1, on);

    Serial.print("LAMPU MEJA 1: ");
    Serial.println(on ? "ON" : "OFF");
}

void setLampu2(bool on) {
    lampu2 = on;
    setRelay(RELAY2, on);

    Serial.print("LAMPU MEJA 2: ");
    Serial.println(on ? "ON" : "OFF");
}

// ======================================================
// WIFI
// ======================================================
void setupWifi() {
    WiFi.mode(WIFI_STA);

    wifiMulti.addAP(
        WIFI_RUMAH_SSID,
        WIFI_RUMAH_PASS
    );

    wifiMulti.addAP(
        WIFI_HOTSPOT_SSID,
        WIFI_HOTSPOT_PASS
    );

    Serial.println();
    Serial.println("Menghubungkan WiFi...");

    unsigned long start = millis();

    while (
        wifiMulti.run() != WL_CONNECTED &&
        millis() - start < 20000
    ) {
        Serial.print(".");
        delay(500);
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("WiFi terhubung.");
        Serial.print("SSID: ");
        Serial.println(WiFi.SSID());

        Serial.print("IP ESP32: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("WiFi belum terhubung.");
    }
}

// ======================================================
// CEK WIFI
// ======================================================
void checkWifi() {
    if (millis() - lastWifiCheck < WIFI_INTERVAL) {
        return;
    }

    lastWifiCheck = millis();

    if (wifiMulti.run() != WL_CONNECTED) {
        Serial.println("WiFi terputus. Mencoba koneksi ulang...");
    }
}

// ======================================================
// HEADER API
// ======================================================
void addApiHeaders(HTTPClient &http) {
    http.addHeader("Content-Type", "application/json");

    if (strlen(espKey) > 0) {
        http.addHeader("X-ESP-KEY", espKey);
    }
}

// ======================================================
// KIRIM SENSOR GETAR
// ======================================================
void sendShake() {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    HTTPClient http;

    String url = serverUrl + "/api/shake";

    http.begin(url);
    addApiHeaders(http);

    String payload = "{\"meja_id\":1}";

    int httpCode = http.POST(payload);

    if (httpCode > 0) {
        Serial.print("SHAKE RESPONSE: ");
        Serial.println(httpCode);

        String response = http.getString();
        Serial.println(response);
    } else {
        Serial.print("SHAKE ERROR: ");
        Serial.println(http.errorToString(httpCode));
    }

    http.end();
}

// ======================================================
// BACA SENSOR
// ======================================================
void checkSensor() {
    bool currentState =
        digitalRead(SENSOR1) == SENSOR_ACTIVE;

    unsigned long now = millis();

    // Deteksi perubahan dari tidak aktif ke aktif.
    if (currentState && !lastSensorState) {
        if (
            now - lastShakeTime1 >= SHAKE_DEBOUNCE_MS &&
            now - lastSendShake1 >= SHAKE_COOLDOWN_MS
        ) {
            lastShakeTime1 = now;
            lastSendShake1 = now;

            Serial.println("GETARAN MEJA 1 TERDETEKSI");

            // Sensor hanya mengirim laporan.
            // Sensor tidak mengontrol relay secara langsung.
            sendShake();
        }
    }

    lastSensorState = currentState;
}

// ======================================================
// AMBIL PERINTAH DARI SERVER
// ======================================================
void checkServerCommand(uint8_t meja) {
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    HTTPClient http;

    String url =
        serverUrl +
        "/api/esp-command?meja=" +
        String(meja);

    http.begin(url);

    if (strlen(espKey) > 0) {
        http.addHeader("X-ESP-KEY", espKey);
    }

    int httpCode = http.GET();

    if (httpCode == HTTP_CODE_OK) {
        String command = http.getString();

        command.trim();

        Serial.print("COMMAND MEJA ");
        Serial.print(meja);
        Serial.print(": ");
        Serial.println(command);

        if (meja == 1) {
            if (command == "ON1") {
                setLampu1(true);
            } else if (command == "OFF1") {
                setLampu1(false);
            }
        }

        if (meja == 2) {
            if (command == "ON2") {
                setLampu2(true);
            } else if (command == "OFF2") {
                setLampu2(false);
            }
        }
    } else if (httpCode > 0) {
        Serial.print("SERVER RESPONSE: ");
        Serial.println(httpCode);
    } else {
        Serial.print("SERVER ERROR: ");
        Serial.println(http.errorToString(httpCode));
    }

    http.end();
}

// ======================================================
// POLLING SERVER
// ======================================================
void pollServer() {
    if (millis() - lastServerCheck < SERVER_INTERVAL) {
        return;
    }

    lastServerCheck = millis();

    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    // Selalu cek kedua meja.
    checkServerCommand(1);
    checkServerCommand(2);
}

// ======================================================
// SETUP
// ======================================================
void setup() {
    Serial.begin(115200);

    // Relay
    pinMode(RELAY1, OUTPUT);
    pinMode(RELAY2, OUTPUT);

    // Pastikan lampu mati saat ESP32 mulai.
    setLampu1(false);
    setLampu2(false);

    // Sensor GPIO34 hanya input.
    pinMode(SENSOR1, INPUT);

    Serial.println();
    Serial.println("================================");
    Serial.println(" SMART BILLIARD ESP32");
    Serial.println("================================");

    setupWifi();
}

// ======================================================
// LOOP
// ======================================================
void loop() {
    checkWifi();

    checkSensor();

    pollServer();

    delay(10);
}