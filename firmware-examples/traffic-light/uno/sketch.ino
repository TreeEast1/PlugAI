// Hand-written example: traffic light state machine (red 5 s -> green 5 s -> yellow 2 s).
// Pedestrian button (D7, INPUT_PULLUP) shortens the current green phase.
const int PIN_RED = 4, PIN_YELLOW = 5, PIN_GREEN = 6, PIN_BTN = 7;
enum Phase { RED, GREEN, YELLOW };
const unsigned long DURATION_MS[] = { 5000, 5000, 2000 };
Phase phase = RED;
unsigned long phaseStart;

void show(Phase p) {
  digitalWrite(PIN_RED, p == RED);
  digitalWrite(PIN_YELLOW, p == YELLOW);
  digitalWrite(PIN_GREEN, p == GREEN);
  Serial.print("phase "); Serial.println(p == RED ? "RED" : p == GREEN ? "GREEN" : "YELLOW");
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RED, OUTPUT); pinMode(PIN_YELLOW, OUTPUT); pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);
  show(phase);
  phaseStart = millis();
}

void loop() {
  unsigned long limit = DURATION_MS[phase];
  if (phase == GREEN && digitalRead(PIN_BTN) == LOW && limit > 1000) limit = 1000;
  if (millis() - phaseStart >= limit) {
    phase = phase == RED ? GREEN : phase == GREEN ? YELLOW : RED;
    show(phase);
    phaseStart = millis();
  }
  delay(10);
}
