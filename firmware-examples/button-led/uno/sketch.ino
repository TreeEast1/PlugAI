// Fixture (Uno): LED on D4 follows button on D5 (INPUT_PULLUP, active low)
void setup() { Serial.begin(115200); pinMode(4, OUTPUT); pinMode(5, INPUT_PULLUP); Serial.println("PLUGAI_FIXTURE button_led"); }
void loop() { digitalWrite(4, digitalRead(5) == LOW ? HIGH : LOW); delay(5); }
