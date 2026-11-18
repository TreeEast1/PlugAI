// Fixture A (Uno): D4 constantly HIGH
void setup() { Serial.begin(115200); pinMode(4, OUTPUT); digitalWrite(4, HIGH); Serial.println("PLUGAI_FIXTURE d4_high"); }
void loop() {}
