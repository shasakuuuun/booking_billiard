// #include <WiFi.h>
// #include <HTTPClient.h>

// // ================== KONFIGURASI WIFI ==================
// const char* ssid = "POCO X3 Pro";
// const char* password = "pakeajaskin";

// // ================== KONFIGURASI SERVER ==================
// String serverUrl = "http://10.173.30.29:3000";  // IP laptop

// // ================== PIN RELAY ==================
// #define RELAY1 18   // Meja 1
// #define RELAY2 19   // Meja 2

// // ================== STATUS RELAY ==================
// bool lamp1State = false;
// bool lamp2State = false;

// // ================== SETUP ==================
// void setup() {
//   Serial.begin(115200);

//   pinMode(RELAY1, OUTPUT);
//   pinMode(RELAY2, OUTPUT);

//   // relay aktif LOW (HIGH = mati)
//   digitalWrite(RELAY1, HIGH);
//   digitalWrite(RELAY2, HIGH);

//   Serial.println("Menghubungkan ke WiFi...");
//   WiFi.begin(ssid, password);

//   // Tunggu sampai terhubung
//   int retry = 0;
//   while (WiFi.status() != WL_CONNECTED && retry < 30) {
//     delay(500);
//     Serial.print(".");
//     retry++;
//   }

//   if (WiFi.status() == WL_CONNECTED) {
//     Serial.println("\n✅ Terhubung ke WiFi!");
//     Serial.print("IP ESP32: ");
//     Serial.println(WiFi.localIP());
//   } else {
//     Serial.println("\n❌ Gagal konek WiFi, reboot dalam 5 detik...");
//     delay(5000);
//     ESP.restart();
//   }
// }

// // ================== LOOP ==================
// void loop() {
//   if (WiFi.status() != WL_CONNECTED) {
//     reconnectWiFi();
//   }

//   checkServerCommand();
//   delay(3000); // jeda agar tidak terlalu sering polling
// }

// // ================== CEK PERINTAH DARI SERVER ==================
// void checkServerCommand() {
//   HTTPClient http;
//   String url = serverUrl + "/api/esp-command";

//   http.begin(url);
//   http.setTimeout(3000); // timeout 3 detik

//   int httpCode = http.GET();

//   if (httpCode == 200) {
//     String command = http.getString();
//     command.trim();

//     if (command.length() > 0) {
//       Serial.print("📩 Perintah dari server: ");
//       Serial.println(command);

//       if (command == "ON1") {
//         digitalWrite(RELAY1, LOW);
//         lamp1State = true;
//         Serial.println("💡 Meja 1 NYALA");
//       } else if (command == "OFF1") {
//         digitalWrite(RELAY1, HIGH);
//         lamp1State = false;
//         Serial.println("⚫ Meja 1 MATI");
//       } else if (command == "ON2") {
//         digitalWrite(RELAY2, LOW);
//         lamp2State = true;
//         Serial.println("💡 Meja 2 NYALA");
//       } else if (command == "OFF2") {
//         digitalWrite(RELAY2, HIGH);
//         lamp2State = false;
//         Serial.println("⚫ Meja 2 MATI");
//       }
//     }
//   } else {
//     Serial.print("❌ Gagal ambil perintah. Kode: ");
//     Serial.println(httpCode);
//   }

//   http.end();
// }

// // ================== RECONNECT WIFI ==================
// void reconnectWiFi() {
//   Serial.println("🔄 WiFi terputus, mencoba reconnect...");
//   WiFi.disconnect();
//   WiFi.begin(ssid, password);

//   int retry = 0;
//   while (WiFi.status() != WL_CONNECTED && retry < 20) {
//     delay(500);
//     Serial.print(".");
//     retry++;
//   }

//   if (WiFi.status() == WL_CONNECTED) {
//     Serial.println("\n✅ WiFi reconnect berhasil!");
//     Serial.print("IP ESP32: ");
//     Serial.println(WiFi.localIP());
//   } else {
//     Serial.println("\n❌ Gagal reconnect WiFi, restart ESP...");
//     ESP.restart();
//   }
// }
