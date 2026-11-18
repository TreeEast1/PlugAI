// Fixture C (Uno): D4 toggles every 100 ms
void setup() { Serial.begin(115200); pinMode(4, OUTPUT); Serial.println("PLUGAI_FIXTURE d4_blink_200"); }
void loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); }
