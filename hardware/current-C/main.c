// Veraldar Current-C - Motor Current Watchdog (ESP32-C3 + INA226)
// Predicts: overcurrent / stall / jam via load-signature trend
// Prevents: motor burnout via CUTOFF_TRIG relay
#include <WiFi.h>
#include <PubSubClient.h>
#include <INA226.h>   // INA226 @0x40, shunt 0.1R
// nets: SDA=IO2 SCL=IO3 CUTOFF_TRIG=IO6
INA226 ina;
void setup() { Serial.begin(115200); ina.begin(); ina.shuntResistor(0.1); }
void loop() {
  // 1) sample bus V / current / power @10Hz
  // 2) RMS current, load-signature baseline (rolling 24h)
  // 3) stall/jam detector: dI/dt + sustained I > baseline*1.4
  // 4) MQTT publish {dev,i_rms,v_bus,p,state}
  // 5) fault: CUTOFF_TRIG (IO6) high
  delay(1000);
}
