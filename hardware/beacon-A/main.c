// Veraldar Beacon A - Machine Health Beacon (ESP32-C3 + ADXL345 + NTC)
// Predicts: bearing wear / imbalance / misalignment / lube failure
// Prevents: unplanned stoppage via MQTT alarm + RELAY_TRIG output
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_ADXL345_U.h>
// nets: SDA=IO2 SCL=IO3 NTC_ADC=IO4 ACC_INT=IO5 RELAY_TRIG=IO6
void setup() {
  Serial.begin(115200);
  Adafruit_ADXL345_Unified acc(12345);
  acc.begin(ADXL345_RANGE_16_G);          // ADXL345 @0x53 (CS->3V3, SDO->GND)
}
void loop() {
  // 1) sample 1-2s burst @3200Hz; 2) FFT -> band energies
  // 3) RMS velocity (ISO 10816), crest factor, kurtosis
  // 4) NTC ADC -> temperature
  // 5) trend + thresholds -> MQTT publish JSON {dev,rms,crest,kurt,temp,alarm}
  // 6) alarm: set RELAY_TRIG (IO6) high
  delay(60000); // deep-sleep placeholder
}
