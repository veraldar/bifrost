// Veraldar AirNode B - Air Quality Prevention Node (ESP32-C3 + SCD41 + SGP41 + PIR)
// Predicts: CO2 buildup / VOC spike trajectories
// Prevents: exposure - drives ventilation via FAN_TRIG relay, closed loop
#include <WiFi.h>
#include <PubSubClient.h>
#include <SensirionI2cScd4x.h>   // SCD41 @0x62
#include <SensirionI2cSgp41.h>   // SGP41 @0x59
// nets: SDA=IO2 SCL=IO3 PIR_IN=IO4 FAN_TRIG=IO6
void setup() { Serial.begin(115200); }
void loop() {
  // 1) SCD41 CO2/T/RH; SGP41 VOC/NOx raw
  // 2) predict 10-min trajectory (linear + occupancy from PIR)
  // 3) if CO2 > 1000ppm projected OR VOC spike: FAN_TRIG (IO6) high
  // 4) MQTT publish {dev,co2,temp,rh,voc,nox,predicted,fan}
  delay(10000);
}
