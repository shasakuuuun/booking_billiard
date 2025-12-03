
// #include <WiFi.h>
// #include <HTTPClient.h>

// // ================== WIFI CONFIG ==================
// const char* ssid = "POCO X3 Pro";
// const char* password = "pakeajaskin";

// // ================== SERVER CONFIG ==================
// String serverUrl = "http://172.23.240.29:3000"; // IP laptop / server

// // ================== RELAY PINS ==================
// #define RELAY1 18  // Meja 1
// #define RELAY2 19  // Meja 2

// // ================== SETUP ==================
// void setup() {
//   Serial.begin(115200);

//   pinMode(RELAY1, OUTPUT);
//   pinMode(RELAY2, OUTPUT);

//   // Relay aktif LOW
//   digitalWrite(RELAY1, HIGH);
//   digitalWrite(RELAY2, HIGH);

//   Serial.println("📡 Connecting WiFi...");
//   WiFi.begin(ssid, password);

//   int retry = 0;
//   while (WiFi.status() != WL_CONNECTED && retry < 30) {
//     delay(500);
//     Serial.print(".");
//     retry++;
//   }

//   if (WiFi.status() == WL_CONNECTED) {
//     Serial.println("\n✅ WiFi Connected!");
//     Serial.print("IP: ");
//     Serial.println(WiFi.localIP());
//   } else {
//     Serial.println("\n❌ WiFi Failed! Restarting...");
//     delay(3000);
//     ESP.restart();
//   }
// }

// // ================== MAIN LOOP ==================
// void loop() {
//   if (WiFi.status() != WL_CONNECTED) {
//     reconnectWiFi();
//   }

//   checkCommandForMeja(1);
//   delay(300);

//   checkCommandForMeja(2);
//   delay(1500);
// }

// // ======================================================
// // CHECK COMMAND per MEJA → /api/esp-command?meja=1
// // ======================================================
// void checkCommandForMeja(int mejaID) {
//   HTTPClient http;

//   String url = serverUrl + "/api/esp-command?meja=" + String(mejaID);

//   http.begin(url);
//   int httpCode = http.GET();

//   if (httpCode == 200) {
//     String cmd = http.getString();
//     cmd.trim();

//     if (cmd.length() > 0) {
//       Serial.print("📨 Command meja ");
//       Serial.print(mejaID);
//       Serial.print(": ");
//       Serial.println(cmd);
//     }

//     if (cmd == "ON1") {
//       digitalWrite(RELAY1, LOW);
//       Serial.println("💡 Meja 1 NYALA");
//     } 
//     else if (cmd == "OFF1") {
//       digitalWrite(RELAY1, HIGH);
//       Serial.println("⚫ Meja 1 MATI");
//     }
//     else if (cmd == "ON2") {
//       digitalWrite(RELAY2, LOW);
//       Serial.println("💡 Meja 2 NYALA");
//     }
//     else if (cmd == "OFF2") {
//       digitalWrite(RELAY2, HIGH);
//       Serial.println("⚫ Meja 2 MATI");
//     }
//   }

//   http.end();
// }

// // ======================================================
// // WIFI RECONNECT
// // ======================================================
// void reconnectWiFi() {
//   Serial.println("🔄 Reconnecting WiFi...");

//   WiFi.disconnect();
//   WiFi.begin(ssid, password);

//   int retry = 0;
//   while (WiFi.status() != WL_CONNECTED && retry < 20) {
//     delay(500);
//     Serial.print(".");
//     retry++;
//   }

//   if (WiFi.status() == WL_CONNECTED) {
//     Serial.println("\n✅ WiFi Reconnected!");
//   } else {
//     Serial.println("\n❌ Failed! Restarting ESP...");
//     ESP.restart();
//   }
// }
