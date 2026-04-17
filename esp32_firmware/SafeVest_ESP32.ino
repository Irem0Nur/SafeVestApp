/*
 * ESP32 - Akıllı Yelek Tüm Sensör Sistemi + BLE + LCD + OLED + GPS + MLX90614 + Acil Buton
 *
 * LCD 16x2: Ortam sıcaklığı / nem / basınç / rakım / metan / hava kalitesi (2 saniye arayla)
 * OLED SSD1306: Vücut sıcaklığı + nabız
 *
 * EKLENENLER:
 * - Ateş 38.5C ve üstü -> buzzer
 * - Ateş alarmında buzzer uzun öter (delay yok)
 * - Nabız düşük + 45 sn hareketsiz -> buzzer + titreşim + GPS BLE
 * - LCD'de surekli clear yok, sadece degisen satirlar yaziliyor
 * - LCD güncelleme ~150 ms
 * - LCD'de metan ve hava kalitesi de var
 * - Serial'de metan ve hava kalitesi de yaziyor
 * - TEST MODU:
 *    - BLE'den TEST_ON gelirse nabız 50 BPM olur
 *    - buzzer test için çalar
 *    - TEST_OFF gelirse normale döner
 * - I2S nabız okuma bloklamaz hale getirildi
 *
 * FIX v3:
 *   - MLX90614 başlatması ikinci Wire.begin() sonrasına taşındı
 *   - Vücut sıcaklığı: offset + EMA filtre geri eklendi
 *   - MLX okuması OLED/LCD yazımlarıyla çakışmayacak şekilde zamanlama ayrıldı
 *   - MPU6050 verisi tek seferde okunup stillness + posture paylaşıyor (bus yükü azaltıldı)
 *   - Rakım kalibrasyonu: periyodik yeniden kalibrasyon (her 5 dakikada)
 *   - OLED güncelleme sıklığı düşürüldü (500ms)
 */

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_MLX90614.h>
#include <DHT.h>
#include <math.h>
#include "driver/i2s.h"
#include "driver/adc.h"
#include "esp_adc_cal.h"
#include <LiquidCrystal_I2C.h>
#include <TinyGPSPlus.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ============ BLE Kütüphaneleri ============
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ============ BLE Tanımları ============
#define BLE_DEVICE_NAME    "SAFEVEST_ESP32"
#define BLE_SERVICE_UUID   "0000FFE0-0000-1000-8000-00805F9B34FB"
#define BLE_CHAR_UUID      "0000FFE1-0000-1000-8000-00805F9B34FB"

// ============ BLE Değişkenleri ============
BLEServer         *pServer          = NULL;
BLECharacteristic *pCharacteristic  = NULL;
bool deviceConnected    = false;
bool oldDeviceConnected = false;

// ============ TEST MODU ============
bool testMode = false;
bool testBuzzerActive = false;
unsigned long testBuzzerStart = 0;
const unsigned long TEST_BUZZER_DURATION = 5000;

// ============ Vardiya Süresi ============
unsigned long shiftStartTime = 0;

// ============ I2C Pin Tanımları ============
#define SDA_PIN 21
#define SCL_PIN 22

// ============ LCD ============
LiquidCrystal_I2C lcd(0x27, 16, 2);   // Çalışmazsa 0x3F dene

// ============ OLED ============
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDRESS  0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ============ GPS ============
#define GPS_RX 16
#define GPS_TX 17
TinyGPSPlus gps;
HardwareSerial GPSSerial(2);
double gpsLat = 0.0;
double gpsLng = 0.0;
bool gpsValid = false;

// ============ I2S (Nabız) Pin Tanımları ============
#define I2S_WS   25
#define I2S_SD   33
#define I2S_SCK  26
#define I2S_PORT I2S_NUM_0

// ============ MQ-4 (Metan) ============
#define MQ4_ADC_CHANNEL ADC1_CHANNEL_6

// ============ MQ-135 (Hava Kalitesi) ============
#define MQ135_ADC_CHANNEL ADC1_CHANNEL_7

// ============ DHT22 ============
#define DHTPIN  4
#define DHTTYPE DHT22

// ============ Buzzer, Titreşim, Buton ============
#define BUZZER_PIN    19
#define VIBRATION_PIN 18
#define BUTTON_PIN    13
#define BUZZER_FREQ   4000

// ============ Acil Buton ============
bool emergencyButtonPressed = false;

// ============ Rakım Kalibrasyonu ============
#define KNOWN_ALTITUDE 67.0  // Ölçüm yapılan yerin gerçek rakımı (metre)
float seaLevelPressure = 1013.25;

// ============ Basınç + Rakım EMA Filtresi (Stabilite) ============
// Basınç filtresi: Ham BME280 basınç okumasını yumuşatır
const float PRESSURE_FILTER_ALPHA = 0.05;  // Çok düşük = çok stabil (yavaş tepki)
float filteredPressure = 0.0;
bool pressureFilterInit = false;

// Rakım filtresi: Hesaplanan rakımı yumuşatır
const float ALTITUDE_FILTER_ALPHA = 0.08;  // Düşük = stabil, ani değişimleri bastırır
float filteredAltitude = 0.0;
bool altitudeFilterInit = false;

// ============ Rakım Düşüş Algılama ============
const float ALTITUDE_DROP_THRESHOLD = 0.4;
float previousAltitude = 0.0;
bool altitudeInitialized = false;
bool altitudeDropDetected = false;

// ============ Sensör Nesneleri ============
DHT dht(DHTPIN, DHTTYPE);
Adafruit_BME280 bme;
Adafruit_MPU6050 mpu;
Adafruit_MLX90614 mlx = Adafruit_MLX90614();
bool bmeReady = false;
bool mpuReady = false;
bool oledReady = false;
bool mlxReady = false;

// ============ MLX90614 / Vücut Sıcaklığı ============
float rawBodyTemp = 0.0;

// Düzeltme + filtre ayarı
const float BODY_TEMP_OFFSET = 3.2;   // MLX90614 sensör düzeltmesi
const float BODY_TEMP_ALPHA  = 0.25;  // EMA filtre katsayısı (0.0-1.0, büyük = hızlı tepki)
bool bodyTempFilterInit = false;

const float FEVER_THRESHOLD_C = 38.5;
bool feverAlarm = false;

unsigned long feverBeepTimer = 0;
bool feverBeepState = false;
const unsigned long FEVER_BUZZ_ON_TIME  = 1200;
const unsigned long FEVER_BUZZ_OFF_TIME = 250;

// MLX okuma sonrası I2C bus'un sakinleşmesi için minimum bekleme
unsigned long lastMlxReadTime = 0;

// ============ Nabız Değişkenleri ============
const int SAMPLE_BUFFER_SIZE = 256;
int32_t sampleBuffer[SAMPLE_BUFFER_SIZE];
float micThreshold = 6500.0;
const unsigned long MIN_BEAT_INTERVAL = 450;
const unsigned long MAX_BEAT_INTERVAL = 1500;
unsigned long lastBeatTime = 0;

int bpm = 0;
int bpmHistory[5] = {0, 0, 0, 0, 0};
int bpmIndex = 0;

// ============ Düşük Nabız + Hareketsizlik Alarmı ============
const int LOW_PULSE_THRESHOLD = 60;
const unsigned long STILLNESS_TIME_MS = 45000;

const float STILL_ACCEL_DELTA = 0.35;
const float STILL_GYRO_THRESHOLD = 0.08;

bool lowPulseStillAlarm = false;
bool stillnessActive = false;

// ============ Hareket Takibi ============
unsigned long lastMovementTime = 0;
bool motionInit = false;
float lastAx = 0.0, lastAy = 0.0, lastAz = 0.0;

// ============ Paylaşılan MPU Verisi ============
// MPU6050'yi tek seferde okuyup hem stillness hem posture'da kullanıyoruz
// Bu şekilde I2C bus yükü yarıya iner
float shared_ax = 0, shared_ay = 0, shared_az = 0;
float shared_gx = 0, shared_gy = 0, shared_gz = 0;
bool mpuDataFresh = false;

// ============ Metan Değişkenleri ============
int gasValue = 0;
String riskLevel = "";

// ============ Hava Kalitesi (MQ-135) ============
const float AIR_FILTER_ALPHA = 0.10;
float filteredAirValue = 0.0;
String airQualityStatus = "";
unsigned long lastAirRead = 0;
const unsigned long AIR_READ_INTERVAL = 500;

// ============ Sıcaklık/Nem Kalibrasyon ============
float TEMP_OFFSET = 0.0;
float HUM_OFFSET  = 0.0;
float TEMP_W_DHT = 0.5;
float TEMP_W_BME = 0.5;
float HUM_W_DHT = 0.6;
float HUM_W_BME = 0.4;

// ============ MPU6050 / Postür Değişkenleri ============
const float POSTURE_THRESHOLD = 25.0;
const unsigned long BAD_POSTURE_TIME = 3000;
const float POSTURE_FILTER_ALPHA = 0.12;
float refPitch = 0.0, refRoll = 0.0;
float filteredPitch = 0.0, filteredRoll = 0.0;
unsigned long badPostureStartTime = 0;
String postureStatus = "";
String postureDetail = "";

// ============ ADC Kalibrasyon ============
esp_adc_cal_characteristics_t adc_chars;

// ============ Çıktı Zamanlayıcı ============
unsigned long lastPrintTime = 0;
const unsigned long PRINT_INTERVAL = 1000;

// ============ LCD/OLED Zamanlayıcı ============
unsigned long lastLcdPageChange = 0;
const unsigned long LCD_PAGE_INTERVAL = 2000;

unsigned long lastLcdRefresh = 0;
const unsigned long LCD_REFRESH_INTERVAL = 150;

unsigned long lastOledUpdate = 0;
const unsigned long OLED_REFRESH_INTERVAL = 500;  // OLED güncellemesi daha seyrek (I2C yükü azaltılsın)

unsigned long lastMpuUpdate = 0;
const unsigned long MPU_UPDATE_INTERVAL = 100;

// Vücut sıcaklığı okuma zamanlayıcı
unsigned long lastBodyTempUpdate = 0;
const unsigned long BODY_TEMP_UPDATE_INTERVAL = 500;  // 500ms — OLED ile çakışmasın

int lcdPage = 0;
String lcdLine0Cache = "";
String lcdLine1Cache = "";

// ============ Alarm Durumları ============
bool buzzerActive = false;
bool vibrationActive = false;

// ============ Son hesaplanan değerler ============
float g_calibratedTemp = 0.0;
float g_calibratedHum = 0.0;
float g_bmeTemp = 0.0;
float g_bmePres = 0.0;
float g_altitude = 0.0;

// ============ Fonksiyon Prototipleri ============
void readPulse();
void readGas();
void updateAirFilter();
void updateBodyTemperature();
String classifyAirQuality(float value);
String classifyBodyTemp(float temp);
void getAngles(float &p, float &r);
void readMPU();
void updatePosture();
void performPostureCalibration();
void updateStillness();
void checkAlarms(float altitude);
void sendBleData(float calibratedTemp, float calibratedHum, float bmeTemp, float altitude);
void sendCurrentBleData();
void updateLCDPages();
void updateOLED();
void readGPS();
void readEmergencyButton();
void writeLcdLine(uint8_t row, const String &text);
void handleTestMode();
void recalibrateAltitude();

// ==================== BLE SERVER CALLBACKS ====================
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("[BLE] Cihaz baglandi!");
  }

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("[BLE] Cihaz ayrildi.");
  }
};

// ==================== BLE CHARACTERISTIC CALLBACKS ====================
class MyCharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) override {
    String cmd = pCharacteristic->getValue();
    cmd.trim();

    if (cmd.length() > 0) {
      Serial.print("[BLE CMD] Gelen komut: ");
      Serial.println(cmd);

      if (cmd == "TEST_ON") {
        testMode = true;
        testBuzzerActive = true;
        testBuzzerStart = millis();
        Serial.println("[TEST] Test modu aktif (50 BPM + buzzer)");
      }
      else if (cmd == "TEST_OFF") {
        testMode = false;
        testBuzzerActive = false;
        ledcWriteTone(BUZZER_PIN, 0);
        Serial.println("[TEST] Test modu kapatildi");
      }
    }
  }
};

void setup() {
  Serial.begin(115200);
  delay(1000);

  shiftStartTime = millis();
  lastMovementTime = millis();
  feverBeepTimer = millis();
  feverBeepState = false;

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("GPS Hazir. (RX=16, TX=17)");

  ledcAttach(BUZZER_PIN, BUZZER_FREQ, 8);
  ledcWriteTone(BUZZER_PIN, 0);
  Serial.println("Buzzer Hazir. (GPIO 19 - LEDC PWM)");

  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);
  Serial.println("Titresim Motoru Hazir. (GPIO 18)");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.println("Acil Buton Hazir. (GPIO 13)");

  // -------- I2C Başlat --------
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);  // 100kHz — çok cihazlı I2C bus'ta güvenli hız
  Serial.println("I2C Hatti Baslatildi (SDA=21, SCL=22, 100kHz)");

  // -------- LCD Başlat --------
  lcd.init();
  lcd.backlight();
  lcd.clear();
  writeLcdLine(0, "Akilli Yelek");
  writeLcdLine(1, "LCD Hazir");
  delay(1000);
  lcdLine0Cache = "";
  lcdLine1Cache = "";

  // -------- OLED Başlat --------
  oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  if (!oledReady) {
    Serial.println("OLED bulunamadi!");
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("OLED Hazir");
    display.display();
    delay(1000);
    display.clearDisplay();
    display.display();
    Serial.println("OLED Hazir. (I2C 0x3C)");
  }

  // -------- DHT22 Başlat --------
  dht.begin();
  Serial.println("DHT22 Hazir. (GPIO 4)");

  // -------- MPU6050 Başlat (ÖNCE) --------
  mpuReady = mpu.begin(0x68, &Wire);
  if (!mpuReady) {
    Serial.println("MPU6050 bulunamadi!");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("MPU6050 Hazir. (I2C 0x68)");
  }

  // -------- I2C'yi yeniden başlat (MPU6050 bozmuş olabilir) --------
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  // -------- BME280 Başlat --------
  bmeReady = bme.begin(0x76, &Wire);
  if (!bmeReady) bmeReady = bme.begin(0x77, &Wire);

  if (!bmeReady) {
    Serial.println("BME280 bulunamadi!");
  } else {
    Serial.println("BME280 Hazir. (I2C 0x76)");
    delay(500);
    recalibrateAltitude();
  }

  // -------- MLX90614 Başlat (ikinci Wire.begin() SONRASINDA!) --------
  delay(100);  // I2C bus'un sakinleşmesi için
  mlxReady = mlx.begin();
  if (!mlxReady) {
    Serial.println("MLX90614 bulunamadi!");
  } else {
    Serial.println("MLX90614 Hazir. (I2C 0x5A)");
    delay(500);  // Sensörün ısınması/stabilize olması için

    // İlk birkaç okumayı at (sensör stabilizasyonu)
    for (int i = 0; i < 5; i++) {
      mlx.readObjectTempC();
      delay(50);
    }

    float testObj = mlx.readObjectTempC();
    float testAmb = mlx.readAmbientTempC();
    Serial.print("[MLX DEBUG] Object: ");
    Serial.print(testObj, 2);
    Serial.print(" C | Ambient: ");
    Serial.print(testAmb, 2);
    Serial.print(" C | Offset: ");
    Serial.print(BODY_TEMP_OFFSET, 1);
    Serial.print(" C | Corrected: ");
    Serial.print(testObj + BODY_TEMP_OFFSET, 2);
    Serial.println(" C");

    updateBodyTemperature();
    Serial.print("[MLX DEBUG] rawBodyTemp: ");
    Serial.print(rawBodyTemp, 2);
    Serial.println(" C");
  }

  // -------- ADC1 Yapılandırması --------
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(MQ4_ADC_CHANNEL, ADC_ATTEN_DB_11);
  adc1_config_channel_atten(MQ135_ADC_CHANNEL, ADC_ATTEN_DB_11);
  esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12, 1100, &adc_chars);
  Serial.println("MQ-4 Hazir. (GPIO 34)");
  Serial.println("MQ-135 Hazir. (GPIO 35)");

  // -------- I2S Yapılandırması --------
  const i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = false
  };

  const i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };

  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.print("I2S hata: ");
    Serial.println(err);
  } else {
    i2s_set_pin(I2S_PORT, &pin_config);
    Serial.println("INMP441 Hazir. (WS=25, SCK=26, SD=33)");
  }

  // -------- Postür Kalibrasyonu --------
  if (mpuReady) {
    Serial.println(">> POSTUR KALIBRASYONU");
    Serial.println(">> Dik ve dogru pozisyonda bekleyin...");
    delay(3000);
    performPostureCalibration();
  }

  // -------- BLE Başlat --------
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(512);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(BLE_SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    BLE_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_NOTIFY |
    BLECharacteristic::PROPERTY_WRITE
  );
  pCharacteristic->addDescriptor(new BLE2902());
  pCharacteristic->setCallbacks(new MyCharacteristicCallbacks());
  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] SAFEVEST_ESP32 yayinda!");
  Serial.println();
  Serial.println("================================================");
  Serial.println("    AKILLI YELEK - TUM SENSORLER + BLE AKTIF    ");
  Serial.println("================================================");

  updateLCDPages();
  updateOLED();
}

void loop() {
  readPulse();
  readGPS();
  readEmergencyButton();
  handleTestMode();

  unsigned long now = millis();

  // --- MPU6050: Tek seferde oku, hem stillness hem posture kullanır ---
  if (now - lastMpuUpdate >= MPU_UPDATE_INTERVAL) {
    lastMpuUpdate = now;

    if (mpuReady) {
      readMPU();  // Paylaşılan veriye yazar
      updateStillness();
      updatePosture();
    }
  }

  // --- MQ-135 filtre güncellemesi ---
  if (now - lastAirRead >= AIR_READ_INTERVAL) {
    lastAirRead = now;
    updateAirFilter();
  }

  // --- Vücut sıcaklığı (OLED yazma anında değil, ayrı zamanlama) ---
  // OLED ile aynı anda I2C bus'ı meşgul etmemek için offset'li timing
  if (now - lastBodyTempUpdate >= BODY_TEMP_UPDATE_INTERVAL) {
    // OLED'in son güncellemesinden en az 100ms sonra oku
    if (now - lastOledUpdate >= 100) {
      lastBodyTempUpdate = now;
      updateBodyTemperature();
    }
  }

  // Periyodik rekalibrasyon kaldırıldı — sabit konumda gereksiz drift yaratıyordu.
  // Kalibrasyon sadece setup()'ta bir kez yapılır.

  // --- BLE yeniden bağlantı ---
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println("[BLE] Yeniden yayina baslandi.");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  // --- Her 1 saniyede serial çıktı + BLE gönder ---
  if (now - lastPrintTime >= PRINT_INTERVAL) {
    lastPrintTime = now;

    readGas();

    feverAlarm = (rawBodyTemp >= FEVER_THRESHOLD_C);

    String bodyTempStatus = classifyBodyTemp(rawBodyTemp);

    airQualityStatus = classifyAirQuality(filteredAirValue);

    float dhtTemp = dht.readTemperature();
    float dhtHum  = dht.readHumidity();

    float bmeTemp = 0, bmeHum = 0, bmePres = 0, altitude = 0;
    if (bmeReady) {
      bmeTemp  = bme.readTemperature();
      bmeHum   = bme.readHumidity();

      // Ham basıncı oku ve EMA filtre uygula
      float rawPressure = bme.readPressure() / 100.0F;
      if (!pressureFilterInit) {
        filteredPressure = rawPressure;
        pressureFilterInit = true;
      } else {
        filteredPressure = (PRESSURE_FILTER_ALPHA * rawPressure)
                         + ((1.0 - PRESSURE_FILTER_ALPHA) * filteredPressure);
      }
      bmePres = filteredPressure;

      // Filtrelenmiş basınçtan rakım hesapla
      float rawAltitude = 44330.0 * (1.0 - pow(filteredPressure / seaLevelPressure, 0.1903));

      // Rakıma da ayrı EMA filtre uygula (çift katmanlı stabilite)
      if (!altitudeFilterInit) {
        filteredAltitude = rawAltitude;
        altitudeFilterInit = true;
      } else {
        filteredAltitude = (ALTITUDE_FILTER_ALPHA * rawAltitude)
                         + ((1.0 - ALTITUDE_FILTER_ALPHA) * filteredAltitude);
      }
      altitude = filteredAltitude;
    }

    bool dhtValid = !isnan(dhtTemp) && !isnan(dhtHum);

    float calibratedTemp, calibratedHum;
    if (dhtValid && bmeReady) {
      calibratedTemp = (TEMP_W_DHT * dhtTemp) + (TEMP_W_BME * bmeTemp) + TEMP_OFFSET;
      calibratedHum  = (HUM_W_DHT * dhtHum)  + (HUM_W_BME * bmeHum)  + HUM_OFFSET;
    } else if (dhtValid) {
      calibratedTemp = dhtTemp + TEMP_OFFSET;
      calibratedHum  = dhtHum  + HUM_OFFSET;
    } else if (bmeReady) {
      calibratedTemp = bmeTemp + TEMP_OFFSET;
      calibratedHum  = bmeHum  + HUM_OFFSET;
    } else {
      calibratedTemp = 0;
      calibratedHum  = 0;
    }

    if (calibratedHum < 0) calibratedHum = 0;
    if (calibratedHum > 100) calibratedHum = 100;

    g_calibratedTemp = calibratedTemp;
    g_calibratedHum  = calibratedHum;
    g_bmeTemp        = bmeTemp;
    g_bmePres        = bmePres;
    g_altitude       = altitude;

    bool lowPulseNow = (bpm > 0 && bpm < LOW_PULSE_THRESHOLD);
    bool newLowPulseStillAlarm = lowPulseNow && stillnessActive;

    if (newLowPulseStillAlarm && !lowPulseStillAlarm) {
      lowPulseStillAlarm = true;
      sendCurrentBleData();
    } else if (!newLowPulseStillAlarm) {
      lowPulseStillAlarm = false;
    }

    String pulseStatus;
    if (bpm == 0) pulseStatus = "BEKLENIYOR";
    else if (bpm < 60) pulseStatus = "DUSUK";
    else if (bpm <= 100) pulseStatus = "IDEAL";
    else pulseStatus = "YUKSEK";

    checkAlarms(altitude);
    sendBleData(calibratedTemp, calibratedHum, bmeTemp, altitude);

    Serial.println("================================================");
    Serial.print("[NABIZ]        "); Serial.print(bpm); Serial.print(" BPM | Durum: "); Serial.println(pulseStatus);
    Serial.print("[GPS]          ");
    if (gpsValid) {
      Serial.print(gpsLat, 6); Serial.print(", "); Serial.println(gpsLng, 6);
    } else {
      Serial.println("Sinyal bekleniyor...");
    }
    Serial.print("[VUCUT SIC.]   "); Serial.print(rawBodyTemp, 2); Serial.print(" C | Durum: "); Serial.println(bodyTempStatus);

    Serial.print("[METAN]        ");
    Serial.print(gasValue);
    Serial.print(" | Durum: ");
    Serial.println(riskLevel);

    Serial.print("[HAVA KAL.]    ");
    Serial.print((int)filteredAirValue);
    Serial.print(" | Durum: ");
    Serial.println(airQualityStatus);

    Serial.print("[ATES ALARM]   "); Serial.println(feverAlarm ? "AKTIF" : "PASIF");
    Serial.print("[HAREKETSIZ]   "); Serial.println(stillnessActive ? "EVET" : "HAYIR");
    Serial.print("[DUK+SABIT]    "); Serial.println(lowPulseStillAlarm ? "AKTIF" : "PASIF");
    Serial.print("[ACIL BUTON]   "); Serial.println(emergencyButtonPressed ? "BASILI" : "BOS");
    Serial.print("[TEST MODU]    "); Serial.println(testMode ? "AKTIF" : "PASIF");
    Serial.print("[SICAKLIK(K)]  "); Serial.print(calibratedTemp, 1); Serial.println(" C");
    Serial.print("[NEM(K)]       "); Serial.print(calibratedHum, 1); Serial.println(" %");
    Serial.print("[BASINC]       "); Serial.print(bmePres, 1); Serial.println(" hPa");
    Serial.print("[RAKIM]        "); Serial.print(altitude, 1); Serial.print(" m (P0="); Serial.print(seaLevelPressure, 1); Serial.println(" hPa)");
    Serial.println("================================================");
  }

  // --- LCD güncelle ---
  updateLCDPages();

  // --- OLED güncelle (seyrek, I2C yükü azaltmak için) ---
  if (now - lastOledUpdate >= OLED_REFRESH_INTERVAL) {
    lastOledUpdate = now;
    updateOLED();
  }
}

// ==================== RAKIM KALİBRASYONU ====================
// Setup'ta bir kez çağrılır. 20 örnek alır, outlier'ları atar, ortalamayla P0 hesaplar.
void recalibrateAltitude() {
  if (!bmeReady) return;

  Serial.println("[RAKIM CAL] Kalibrasyon basliyor (67m hedef)...");

  // 20 okuma al, ortalamasını hesapla
  float readings[20];
  int validCount = 0;

  for (int i = 0; i < 20; i++) {
    float p = bme.readPressure() / 100.0F;
    if (!isnan(p) && p > 800 && p < 1200) {
      readings[validCount] = p;
      validCount++;
    }
    delay(100);  // Her okuma arası 100ms bekle (sensör stabilizasyonu)
  }

  if (validCount < 10) {
    Serial.println("[RAKIM CAL] Yeterli gecerli okuma alinamadi!");
    return;
  }

  // Basit outlier temizleme: ortalamadan çok sapanları at
  float sum = 0;
  for (int i = 0; i < validCount; i++) sum += readings[i];
  float mean = sum / validCount;

  float cleanSum = 0;
  int cleanCount = 0;
  for (int i = 0; i < validCount; i++) {
    if (fabs(readings[i] - mean) < 2.0) {  // ±2 hPa'dan fazla sapanları at
      cleanSum += readings[i];
      cleanCount++;
    }
  }

  float avgPressure;
  if (cleanCount >= 5) {
    avgPressure = cleanSum / cleanCount;
  } else {
    avgPressure = mean;  // Yeterli temiz veri yoksa ham ortalama kullan
  }

  // Deniz seviyesi basıncını hesapla (barometrik formül)
  seaLevelPressure = avgPressure / pow(1.0 - (KNOWN_ALTITUDE / 44330.0), 5.255);

  // Basınç filtresini başlangıç değeriyle başlat
  filteredPressure = avgPressure;
  pressureFilterInit = true;

  // Rakım filtresini 67m ile başlat
  filteredAltitude = KNOWN_ALTITUDE;
  altitudeFilterInit = true;

  Serial.print("[RAKIM CAL] Ort. basinc: ");
  Serial.print(avgPressure, 2);
  Serial.print(" hPa | P0: ");
  Serial.print(seaLevelPressure, 2);
  Serial.print(" hPa | Hedef: ");
  Serial.print(KNOWN_ALTITUDE, 0);
  Serial.print(" m | Olcum: ");
  float checkAlt = 44330.0 * (1.0 - pow(avgPressure / seaLevelPressure, 0.1903));
  Serial.print(checkAlt, 1);
  Serial.println(" m");
}

// ==================== TEST MODU ====================
void handleTestMode() {
  if (!testMode) return;

  bpm = 50;

  if (testBuzzerActive) {
    ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);

    if (millis() - testBuzzerStart >= TEST_BUZZER_DURATION) {
      testBuzzerActive = false;
      ledcWriteTone(BUZZER_PIN, 0);
    }
  }
}

// ==================== Buton ====================
void readEmergencyButton() {
  emergencyButtonPressed = (digitalRead(BUTTON_PIN) == LOW);
}

// ==================== MPU6050 TEK OKUMA ====================
// Her iki fonksiyon (stillness + posture) tek I2C okuması paylaşır
void readMPU() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);

  shared_ax = a.acceleration.x;
  shared_ay = a.acceleration.y;
  shared_az = a.acceleration.z;
  shared_gx = g.gyro.x;
  shared_gy = g.gyro.y;
  shared_gz = g.gyro.z;
  mpuDataFresh = true;
}

// ==================== Hareketsizlik ====================
void updateStillness() {
  if (!mpuReady || !mpuDataFresh) {
    stillnessActive = false;
    return;
  }

  if (!motionInit) {
    lastAx = shared_ax;
    lastAy = shared_ay;
    lastAz = shared_az;
    lastMovementTime = millis();
    motionInit = true;
    stillnessActive = false;
    return;
  }

  float accelDelta =
      fabs(shared_ax - lastAx) +
      fabs(shared_ay - lastAy) +
      fabs(shared_az - lastAz);

  float gyroLevel =
      fabs(shared_gx) +
      fabs(shared_gy) +
      fabs(shared_gz);

  bool moving = (accelDelta > STILL_ACCEL_DELTA) || (gyroLevel > STILL_GYRO_THRESHOLD);

  if (moving) {
    lastMovementTime = millis();
    stillnessActive = false;
  } else {
    stillnessActive = (millis() - lastMovementTime >= STILLNESS_TIME_MS);
  }

  lastAx = shared_ax;
  lastAy = shared_ay;
  lastAz = shared_az;
}

// ==================== LCD Yardımcı ====================
void writeLcdLine(uint8_t row, const String &text) {
  String padded = text;
  if (padded.length() > 16) padded = padded.substring(0, 16);
  while (padded.length() < 16) padded += " ";

  lcd.setCursor(0, row);
  lcd.print(padded);
}

// ==================== LCD ====================
void updateLCDPages() {
  unsigned long now = millis();

  if (now - lastLcdPageChange >= LCD_PAGE_INTERVAL) {
    lastLcdPageChange = now;
    lcdPage = (lcdPage + 1) % 6;
  }

  if (now - lastLcdRefresh < LCD_REFRESH_INTERVAL) {
    return;
  }
  lastLcdRefresh = now;

  String line0, line1;

  switch (lcdPage) {
    case 0:
      line0 = "Ortam Sicaklik";
      line1 = String(g_bmeTemp, 1) + " C";
      break;

    case 1:
      line0 = "Nem";
      line1 = String(g_calibratedHum, 1) + " %";
      break;

    case 2:
      line0 = "Basinc";
      line1 = String(g_bmePres, 1) + " hPa";
      break;

    case 3:
      line0 = "Rakim";
      line1 = String(g_altitude, 1) + " m";
      break;

    case 4:
      line0 = "Metan";
      line1 = String(gasValue) + " " + riskLevel;
      break;

    default:
      line0 = "Hava Kalitesi";
      line1 = String((int)filteredAirValue) + " " + airQualityStatus;
      break;
  }

  if (line0 != lcdLine0Cache) {
    writeLcdLine(0, line0);
    lcdLine0Cache = line0;
  }

  if (line1 != lcdLine1Cache) {
    writeLcdLine(1, line1);
    lcdLine1Cache = line1;
  }
}

// ==================== OLED ====================
void updateOLED() {
  if (!oledReady) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Vucut Sicakligi");

  display.setTextSize(2);
  display.setCursor(0, 12);
  display.print(rawBodyTemp, 1);
  display.println(" C");

  display.setTextSize(1);
  display.setCursor(0, 40);
  display.println("Nabiz");

  display.setTextSize(2);
  display.setCursor(0, 50);
  display.print(bpm);
  display.print(" BPM");

  display.display();
}

// ==================== GPS ====================
void readGPS() {
  while (GPSSerial.available() > 0) {
    gps.encode(GPSSerial.read());
  }

  if (gps.location.isUpdated()) {
    if (gps.location.isValid()) {
      gpsLat = gps.location.lat();
      gpsLng = gps.location.lng();
      gpsValid = true;
    } else {
      gpsValid = false;
    }
  }
}

// ==================== BLE Yardımcı ====================
void sendCurrentBleData() {
  sendBleData(g_calibratedTemp, g_calibratedHum, g_bmeTemp, g_altitude);
}

// ==================== BLE VERİ GÖNDERME ====================
void sendBleData(float calibratedTemp, float calibratedHum, float bmeTemp, float altitude) {
  if (!deviceConnected) return;

  unsigned long shiftMinutes = (millis() - shiftStartTime) / 60000;

  char jsonBuffer[460];
  snprintf(jsonBuffer, sizeof(jsonBuffer),
    "{"
    "\"heartRate\":%d,"
    "\"bodyTemp\":%.1f,"
    "\"bodySurfaceTemp\":%.2f,"
    "\"humidity\":%.1f,"
    "\"ambientTemp\":%.1f,"
    "\"airQuality\":%d,"
    "\"methane\":%d,"
    "\"noiseDb\":0,"
    "\"postureOk\":%s,"
    "\"fallDetected\":%s,"
    "\"emergencyButton\":%s,"
    "\"lowPulseStillAlarm\":%s,"
    "\"stillnessActive\":%s,"
    "\"shiftMinutes\":%lu,"
    "\"lanyardConnected\":true,"
    "\"gpsLat\":%.6f,"
    "\"gpsLng\":%.6f"
    "}",
    bpm,
    rawBodyTemp,
    rawBodyTemp,
    calibratedHum,
    g_bmeTemp,
    (int)filteredAirValue,
    gasValue,
    (postureStatus == "IDEAL") ? "true" : "false",
    altitudeDropDetected ? "true" : "false",
    emergencyButtonPressed ? "true" : "false",
    lowPulseStillAlarm ? "true" : "false",
    stillnessActive ? "true" : "false",
    shiftMinutes,
    gpsValid ? gpsLat : 0.0,
    gpsValid ? gpsLng : 0.0
  );

  pCharacteristic->setValue(jsonBuffer);
  pCharacteristic->notify();
}

// ==================== NABIZ ====================
void readPulse() {
  if (testMode) {
    bpm = 50;
    return;
  }

  static unsigned long lastPulseRead = 0;
  if (millis() - lastPulseRead < 30) return;
  lastPulseRead = millis();

  size_t bytesRead = 0;

  esp_err_t err = i2s_read(
    I2S_PORT,
    (void*)sampleBuffer,
    sizeof(sampleBuffer),
    &bytesRead,
    2 / portTICK_PERIOD_MS
  );

  if (err != ESP_OK || bytesRead == 0) {
    return;
  }

  int samplesRead = bytesRead / sizeof(int32_t);
  if (samplesRead <= 0) return;

  int32_t maxVal = -2147483648;
  int32_t minVal = 2147483647;

  for (int i = 0; i < samplesRead; i++) {
    int32_t s = sampleBuffer[i] >> 14;
    if (s > maxVal) maxVal = s;
    if (s < minVal) minVal = s;
  }

  float peakToPeak = (float)(maxVal - minVal);
  unsigned long now = millis();

  if (peakToPeak > micThreshold && (now - lastBeatTime) > MIN_BEAT_INTERVAL) {
    unsigned long interval = now - lastBeatTime;

    if (lastBeatTime > 0 && interval < MAX_BEAT_INTERVAL) {
      int currentBPM = 60000 / interval;

      if (currentBPM > 40 && currentBPM < 160) {
        bpmHistory[bpmIndex] = currentBPM;
        bpmIndex = (bpmIndex + 1) % 5;

        long sum = 0;
        for (int j = 0; j < 5; j++) sum += bpmHistory[j];
        bpm = sum / 5;
      }
    }

    lastBeatTime = now;
  }
}

// ==================== METAN (MQ-4) ====================
void readGas() {
  gasValue = adc1_get_raw(MQ4_ADC_CHANNEL);
  if (gasValue < 1000) riskLevel = "GUVENLI";
  else if (gasValue < 2000) riskLevel = "DIKKAT";
  else if (gasValue < 3000) riskLevel = "RISKLI";
  else riskLevel = "TEHLIKE";
}

// ==================== HAVA KALİTESİ ====================
void updateAirFilter() {
  int rawValue = adc1_get_raw(MQ135_ADC_CHANNEL);
  filteredAirValue = AIR_FILTER_ALPHA * rawValue + (1.0 - AIR_FILTER_ALPHA) * filteredAirValue;
}

// ==================== VÜCUT SICAKLIĞI (MLX90614) ====================
void updateBodyTemperature() {
  if (!mlxReady) return;

  // Okuma öncesi I2C bus'un boş olduğundan emin ol
  // Son OLED yazımından en az 50ms sonra oku
  if (millis() - lastOledUpdate < 50) return;

  float objectTemp = mlx.readObjectTempC();
  float ambientTemp = mlx.readAmbientTempC();

  lastMlxReadTime = millis();

  // Debug: her 3 saniyede detaylı bilgi yazdır
  static unsigned long lastMlxDebug = 0;
  if (millis() - lastMlxDebug >= 3000) {
    lastMlxDebug = millis();
    Serial.print("[MLX] Obj: ");
    Serial.print(objectTemp, 2);
    Serial.print(" C | Amb: ");
    Serial.print(ambientTemp, 2);
    Serial.print(" C | Corrected: ");
    Serial.print(objectTemp + BODY_TEMP_OFFSET, 2);
    Serial.print(" C | rawBodyTemp: ");
    Serial.print(rawBodyTemp, 2);
    Serial.println(" C");
  }

  // Geçersiz okuma kontrolü
  if (isnan(objectTemp) || isnan(ambientTemp)) {
    Serial.println("[MLX] NaN okuma, atlandi.");
    return;
  }

  // Sensör aralık kontrolü (MLX90614 ölçüm aralığı: -40 ile +125°C arası)
  // Nesne sıcaklığı çok düşük veya çok yüksekse at
  if (objectTemp < 10.0 || objectTemp > 50.0) {
    return;
  }

  // Ambient sıcaklık makul mi? (Sensörün kendisi çalışıyor mu kontrolü)
  if (ambientTemp < -10.0 || ambientTemp > 60.0) {
    Serial.println("[MLX] Ambient temp out of range, sensor problem?");
    return;
  }

  // Düzeltme ofseti uygula
  float correctedTemp = objectTemp + BODY_TEMP_OFFSET;

  // EMA (Exponential Moving Average) filtresi
  if (!bodyTempFilterInit) {
    rawBodyTemp = correctedTemp;
    bodyTempFilterInit = true;
  } else {
    rawBodyTemp = (BODY_TEMP_ALPHA * correctedTemp) + ((1.0 - BODY_TEMP_ALPHA) * rawBodyTemp);
  }
}

String classifyAirQuality(float value) {
  if (value < 400) return "IYI";
  else if (value < 800) return "ORTA";
  else return "KOTU";
}

String classifyBodyTemp(float temp) {
  if (temp < 35.5) return "DUSUK";
  else if (temp < 37.5) return "NORMAL";
  else return "YUKSEK";
}

// ==================== POSTÜR ====================
void getAngles(float &p, float &r) {
  // Bu fonksiyon sadece kalibrasyon sırasında kullanılır
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  p = atan2(a.acceleration.x, sqrt(a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z)) * 180.0 / PI;
  r = atan2(a.acceleration.y, sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.z * a.acceleration.z)) * 180.0 / PI;
}

void performPostureCalibration() {
  Serial.print(">> Kalibre ediliyor");
  const int samples = 200;
  float pSum = 0, rSum = 0;

  for (int i = 0; i < samples; i++) {
    float p, r;
    getAngles(p, r);
    pSum += p;
    rSum += r;
    if (i % 40 == 0) Serial.print(".");
    delay(15);
  }

  refPitch = pSum / samples;
  refRoll = rSum / samples;
  filteredPitch = refPitch;
  filteredRoll = refRoll;

  Serial.println(" TAMAM!");
}

void updatePosture() {
  if (!mpuDataFresh) return;

  // Paylaşılan MPU verisinden açıları hesapla (ayrı I2C okuma yok)
  float rawPitch = atan2(shared_ax, sqrt(shared_ay * shared_ay + shared_az * shared_az)) * 180.0 / PI;
  float rawRoll  = atan2(shared_ay, sqrt(shared_ax * shared_ax + shared_az * shared_az)) * 180.0 / PI;

  filteredPitch = (POSTURE_FILTER_ALPHA * rawPitch) + ((1.0 - POSTURE_FILTER_ALPHA) * filteredPitch);
  filteredRoll  = (POSTURE_FILTER_ALPHA * rawRoll)  + ((1.0 - POSTURE_FILTER_ALPHA) * filteredRoll);

  float dPitch = filteredPitch - refPitch;
  float dRoll  = filteredRoll  - refRoll;

  bool errorDetected = (abs(dPitch) > POSTURE_THRESHOLD) || (abs(dRoll) > POSTURE_THRESHOLD);

  if (errorDetected) {
    if (badPostureStartTime == 0) badPostureStartTime = millis();
  } else {
    badPostureStartTime = 0;
  }

  unsigned long duration = (badPostureStartTime > 0) ? (millis() - badPostureStartTime) : 0;

  if (duration >= BAD_POSTURE_TIME) {
    postureStatus = "KOTU";
    if (dPitch > POSTURE_THRESHOLD) postureDetail = "ARKAYA EGILME";
    else if (dPitch < -POSTURE_THRESHOLD) postureDetail = "ONE EGILME";
    else if (dRoll > POSTURE_THRESHOLD) postureDetail = "SOLA DONME";
    else if (dRoll < -POSTURE_THRESHOLD) postureDetail = "SAGA DONME";
  } else {
    postureStatus = "IDEAL";
    postureDetail = "";
  }
}

// ==================== ALARM ====================
void checkAlarms(float altitude) {
  altitudeDropDetected = false;
  if (!altitudeInitialized) {
    previousAltitude = altitude;
    altitudeInitialized = true;
  } else {
    float altDrop = previousAltitude - altitude;
    if (altDrop >= ALTITUDE_DROP_THRESHOLD) {
      altitudeDropDetected = true;
    }
    previousAltitude = altitude;
  }

  bool shouldBuzz = false;
  if (airQualityStatus == "KOTU") shouldBuzz = true;
  if (riskLevel == "RISKLI" || riskLevel == "TEHLIKE") shouldBuzz = true;
  if (altitudeDropDetected) shouldBuzz = true;
  if (emergencyButtonPressed) shouldBuzz = true;
  if (feverAlarm) shouldBuzz = true;
  if (lowPulseStillAlarm) shouldBuzz = true;

  if (testMode && testBuzzerActive) {
    buzzerActive = true;
    return;
  }

  if (feverAlarm) {
    unsigned long now = millis();

    if (feverBeepState) {
      if (now - feverBeepTimer >= FEVER_BUZZ_ON_TIME) {
        feverBeepTimer = now;
        feverBeepState = false;
        ledcWriteTone(BUZZER_PIN, 0);
      }
    } else {
      if (now - feverBeepTimer >= FEVER_BUZZ_OFF_TIME) {
        feverBeepTimer = now;
        feverBeepState = true;
        ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
      }
    }

    buzzerActive = true;
  }
  else if (shouldBuzz) {
    ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
    buzzerActive = true;
  }
  else {
    ledcWriteTone(BUZZER_PIN, 0);
    buzzerActive = false;
    feverBeepState = false;
    feverBeepTimer = millis();
  }

  bool shouldVibrate = false;
  if (altitudeDropDetected) shouldVibrate = true;
  if (postureStatus == "KOTU") shouldVibrate = true;
  if (emergencyButtonPressed) shouldVibrate = true;
  if (lowPulseStillAlarm) shouldVibrate = true;

  if (shouldVibrate) {
    digitalWrite(VIBRATION_PIN, HIGH);
    vibrationActive = true;
  } else {
    digitalWrite(VIBRATION_PIN, LOW);
    vibrationActive = false;
  }
}
