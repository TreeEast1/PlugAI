// Fixture B (Uno): D4 constantly LOW
void setup() { Serial.begin(115200); pinMode(4, OUTPUT); digitalWrite(4, LOW); Serial.println("PLUGAI_FIXTURE d4_low"); }
void loop() {}
