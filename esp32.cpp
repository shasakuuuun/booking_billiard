#include <WiFi.h>
#include <HTTPClient.h>

// ================== WIFI CONFIG ==================
const char* ssid     = "NAMA_WIFI_LO";
const char* password = "PASSWORD_WIFI_LO";

// ================== SERVER CONFIG ==================
String serverUrl = "http://10.56.202.200:3000";

// ================== RELAY ==================
#define RELAY1 18
#define RELAY2 19

// ================== SENSOR ==================
#define SENSOR1 34
#define SENSOR2 35

// ================== SENSOR CONFIG ==================
#define SHAKE_DEBOUNCE_MS 500
#define SHAKE_COOLDOWN_MS 5000

// ================== TIMER ==================
const unsigned long SERVER_INTERVAL = 2000;
const unsigned long WIFI_INTERVAL   = 5000;

// ================== STATE ==================
unsigned long lastShakeTime1 = 0;
unsigned long lastShakeTime2 = 0;

unsigned long lastSendReset1 = 0;
unsigned long lastSendReset2 = 0;

unsigned long lastServerCheck = 0;
unsigned long lastWifiCheck   = 0;

//====================================================
// SET RELAY
//====================================================
void setRelay(uint8_t relayPin, bool on)
{
    // Relay Active LOW
    digitalWrite(relayPin, on ? LOW : HIGH);
}

//====================================================
// SETUP
//====================================================
void setup()
{
    Serial.begin(115200);
    delay(500);

    Serial.println();
    Serial.println("========================================");
    Serial.println(" SMART BILLIARD ESP32");
    Serial.println("========================================");

    pinMode(RELAY1, OUTPUT);
    pinMode(RELAY2, OUTPUT);

    setRelay(RELAY1,false);
    setRelay(RELAY2,false);

    pinMode(SENSOR1, INPUT);
    pinMode(SENSOR2, INPUT);

    Serial.println("Relay dan Sensor siap");

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid,password);

    Serial.print("Menghubungkan WiFi");

    const int MAX_RETRY = 30;
    int retry = 0;

    while(WiFi.status()!=WL_CONNECTED && retry<MAX_RETRY)
    {
        delay(500);
        Serial.print(".");
        retry++;
    }

    if(WiFi.status()==WL_CONNECTED)
    {
        Serial.println();
        Serial.println("========================================");
        Serial.println("WiFi Connected");
        Serial.print("IP Address : ");
        Serial.println(WiFi.localIP());

        Serial.print("Signal     : ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");

        Serial.print("Server     : ");
        Serial.println(serverUrl);

        Serial.println("========================================");
    }
    else
    {
        Serial.println();
        Serial.println("Gagal konek WiFi");
        ESP.restart();
    }
}

//====================================================
// LOOP
//====================================================
void loop()
{
    // Cek WiFi tiap 5 detik
    if(millis()-lastWifiCheck>=WIFI_INTERVAL)
    {
        lastWifiCheck=millis();

        if(WiFi.status()!=WL_CONNECTED)
        {
            reconnectWiFi();
        }
    }

    if(WiFi.status()!=WL_CONNECTED)
        return;

    // Sensor selalu aktif
    checkShakeSensor(1,SENSOR1,lastShakeTime1,lastSendReset1);
    checkShakeSensor(2,SENSOR2,lastShakeTime2,lastSendReset2);

    // Polling server tiap 2 detik
    if(millis()-lastServerCheck>=SERVER_INTERVAL)
    {
        lastServerCheck=millis();

        checkCommandForMeja(1);
        checkCommandForMeja(2);
    }
}
//====================================================
// CEK SENSOR GETAR
//====================================================
void checkShakeSensor(int mejaId, int pin, unsigned long &lastShake, unsigned long &lastSend)
{
    if(digitalRead(pin)==LOW)
    {
        unsigned long now=millis();

        // Debounce
        if(now-lastShake<SHAKE_DEBOUNCE_MS)
            return;

        lastShake=now;

        Serial.print("🔔 Aktivitas Meja ");
        Serial.println(mejaId);

        // Cooldown supaya tidak spam server
        if(now-lastSend>=SHAKE_COOLDOWN_MS)
        {
            lastSend=now;
            sendResetTimer(mejaId);
        }
    }
}

//====================================================
// RESET TIMER KE SERVER
//====================================================
void sendResetTimer(int mejaId)
{
    if(WiFi.status()!=WL_CONNECTED)
        return;

    HTTPClient http;

    String url=serverUrl+"/api/shake";

    http.setConnectTimeout(3000);
    http.begin(url);

    http.addHeader("Content-Type","application/json");

    String body="{\"meja_id\":"+String(mejaId)+",\"reset_only\":true}";

    int httpCode=http.POST(body);

    if(httpCode==200)
    {
        Serial.print("✅ Timer Reset Meja ");
        Serial.println(mejaId);
    }
    else
    {
        Serial.print("❌ Reset gagal. HTTP : ");
        Serial.println(httpCode);
    }

    http.end();
}

//====================================================
// CEK COMMAND SERVER
//====================================================
void checkCommandForMeja(int mejaID)
{
    HTTPClient http;

    String url=serverUrl+"/api/esp-command?meja="+String(mejaID);

    http.setConnectTimeout(3000);
    http.begin(url);
    http.setTimeout(3000);

    int httpCode=http.GET();

    if(httpCode==200)
    {
        String cmd=http.getString();
        cmd.trim();

        if(cmd=="")
        {
            http.end();
            return;
        }

        Serial.print("📨 Meja ");
        Serial.print(mejaID);
        Serial.print(" -> ");
        Serial.println(cmd);

        if(cmd=="ON1")
        {
            setRelay(RELAY1,true);
            Serial.println("💡 Lampu Meja 1 ON");
        }
        else if(cmd=="OFF1")
        {
            setRelay(RELAY1,false);
            Serial.println("⚫ Lampu Meja 1 OFF");
        }
        else if(cmd=="ON2")
        {
            setRelay(RELAY2,true);
            Serial.println("💡 Lampu Meja 2 ON");
        }
        else if(cmd=="OFF2")
        {
            setRelay(RELAY2,false);
            Serial.println("⚫ Lampu Meja 2 OFF");
        }
    }
    else
    {
        Serial.print("❌ HTTP Error : ");
        Serial.println(httpCode);
    }

    http.end();
}

//====================================================
// WIFI RECONNECT
//====================================================
void reconnectWiFi()
{
    Serial.println();
    Serial.println("========================================");
    Serial.println("Reconnect WiFi");
    Serial.println("========================================");

    WiFi.disconnect(true);
    delay(300);

    WiFi.begin(ssid,password);

    int retry=0;

    while(WiFi.status()!=WL_CONNECTED && retry<20)
    {
        delay(500);
        Serial.print(".");
        retry++;
    }

    if(WiFi.status()==WL_CONNECTED)
    {
        Serial.println();
        Serial.println("✅ WiFi Reconnected");

        Serial.print("IP : ");
        Serial.println(WiFi.localIP());

        Serial.print("RSSI : ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
    }
    else
    {
        Serial.println();
        Serial.println("❌ Reconnect gagal.");
        Serial.println("ESP akan mencoba lagi pada siklus berikutnya.");
    }
}