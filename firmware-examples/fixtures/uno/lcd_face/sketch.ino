// Fixture: ST7735 128x160 over hardware SPI (D13 SCK, D11 MOSI), CS=D10, DC=D9, RST=D8.
// Draws a yellow face with two eyes and red cheeks, then blinks the eyes every second.
#include <SPI.h>
const int PIN_CS = 10, PIN_DC = 9, PIN_RST = 8;

void cmd(uint8_t c) { digitalWrite(PIN_DC, LOW); digitalWrite(PIN_CS, LOW); SPI.transfer(c); digitalWrite(PIN_CS, HIGH); }
void dat(uint8_t d) { digitalWrite(PIN_DC, HIGH); digitalWrite(PIN_CS, LOW); SPI.transfer(d); digitalWrite(PIN_CS, HIGH); }

void window(uint8_t x0, uint8_t y0, uint8_t x1, uint8_t y1) {
  cmd(0x2A); dat(0); dat(x0); dat(0); dat(x1);
  cmd(0x2B); dat(0); dat(y0); dat(0); dat(y1);
  cmd(0x2C);
}
void fillRect(uint8_t x, uint8_t y, uint8_t w, uint8_t h, uint16_t c) {
  window(x, y, x + w - 1, y + h - 1);
  digitalWrite(PIN_DC, HIGH); digitalWrite(PIN_CS, LOW);
  for (uint16_t i = 0; i < (uint16_t)w * h; i++) { SPI.transfer(c >> 8); SPI.transfer(c & 0xFF); }
  digitalWrite(PIN_CS, HIGH);
}
void fillCircle(int cx, int cy, int r, uint16_t c) {
  for (int dy = -r; dy <= r; dy++) {
    int dx = 0; while ((dx + 1) * (dx + 1) + dy * dy <= r * r) dx++;
    fillRect(cx - dx, cy + dy, 2 * dx + 1, 1, c);
  }
}
const uint16_t BLACK = 0x0000, YELLOW = 0xFFE0, RED = 0xF800, WHITE = 0xFFFF;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_CS, OUTPUT); pinMode(PIN_DC, OUTPUT); pinMode(PIN_RST, OUTPUT);
  digitalWrite(PIN_CS, HIGH);
  digitalWrite(PIN_RST, LOW); delay(10); digitalWrite(PIN_RST, HIGH); delay(120);
  SPI.begin();
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  cmd(0x01); delay(150);
  cmd(0x11); delay(120);
  cmd(0x3A); dat(0x05);
  cmd(0x36); dat(0x00);
  cmd(0x29);
  fillRect(0, 0, 128, 160, BLACK);
  fillCircle(64, 80, 50, YELLOW);
  fillCircle(30, 100, 10, RED);
  fillCircle(98, 100, 10, RED);
  Serial.println("PLUGAI_FIXTURE lcd_face drawn");
}

bool open_ = true;
void loop() {
  fillCircle(46, 66, 7, open_ ? BLACK : YELLOW);
  fillCircle(82, 66, 7, open_ ? BLACK : YELLOW);
  if (!open_) { fillRect(39, 66, 15, 2, BLACK); fillRect(75, 66, 15, 2, BLACK); }
  open_ = !open_;
  delay(1000);
}
