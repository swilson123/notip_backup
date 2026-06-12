#include "BitBang_LiquidCrystal_I2C.h"

BitBang_LiquidCrystal_I2C::BitBang_LiquidCrystal_I2C(uint8_t addr, uint8_t cols, uint8_t rows, int sdaPin, int sclPin)
: _addr(addr << 1), _cols(cols), _rows(rows), _displayfunction(LCD_4BITMODE | LCD_1LINE | LCD_5x8DOTS), _displaycontrol(LCD_DISPLAYON | LCD_CURSOROFF | LCD_BLINKOFF), _displaymode(LCD_ENTRYLEFT | LCD_ENTRYSHIFTDECREMENT), _backlightval(LCD_BACKLIGHT), _sdaPin(sdaPin), _sclPin(sclPin) {
  _row_offsets[0] = 0x00;
  _row_offsets[1] = 0x40;
  _row_offsets[2] = 0x14;
  _row_offsets[3] = 0x54;
}

void BitBang_LiquidCrystal_I2C::setPins(int sdaPin, int sclPin) {
  _sdaPin = sdaPin;
  _sclPin = sclPin;
}

void BitBang_LiquidCrystal_I2C::i2c_init() {
  pinMode(_sdaPin, INPUT);
  pinMode(_sclPin, INPUT);
  digitalWrite(_sdaPin, HIGH);
  digitalWrite(_sclPin, HIGH);
  delayMicroseconds(10);
}

void BitBang_LiquidCrystal_I2C::i2c_start() {
  pinMode(_sdaPin, INPUT);
  digitalWrite(_sdaPin, HIGH);
  pinMode(_sclPin, INPUT);
  digitalWrite(_sclPin, HIGH);
  delayMicroseconds(5);
  pinMode(_sdaPin, OUTPUT);
  digitalWrite(_sdaPin, LOW);
  delayMicroseconds(5);
  pinMode(_sclPin, OUTPUT);
  digitalWrite(_sclPin, LOW);
  delayMicroseconds(5);
}

void BitBang_LiquidCrystal_I2C::i2c_stop() {
  pinMode(_sdaPin, OUTPUT);
  digitalWrite(_sdaPin, LOW);
  delayMicroseconds(5);
  pinMode(_sclPin, INPUT);
  digitalWrite(_sclPin, HIGH);
  delayMicroseconds(5);
  pinMode(_sdaPin, INPUT);
  digitalWrite(_sdaPin, HIGH);
  delayMicroseconds(5);
}

bool BitBang_LiquidCrystal_I2C::i2c_write(uint8_t data) {
  pinMode(_sdaPin, OUTPUT);
  for (uint8_t i = 0; i < 8; i++) {
    digitalWrite(_sdaPin, (data & 0x80) ? HIGH : LOW);
    delayMicroseconds(5);
    pinMode(_sclPin, INPUT);
    digitalWrite(_sclPin, HIGH);
    delayMicroseconds(5);
    pinMode(_sclPin, OUTPUT);
    digitalWrite(_sclPin, LOW);
    data <<= 1;
  }
  pinMode(_sdaPin, INPUT);
  digitalWrite(_sdaPin, HIGH);
  delayMicroseconds(5);
  pinMode(_sclPin, INPUT);
  digitalWrite(_sclPin, HIGH);
  delayMicroseconds(5);
  bool ack = (digitalRead(_sdaPin) == LOW);
  pinMode(_sclPin, OUTPUT);
  digitalWrite(_sclPin, LOW);
  return ack;
}

void BitBang_LiquidCrystal_I2C::expanderWrite(uint8_t data) {
  i2c_start();
  i2c_write(_addr);
  i2c_write(data | _backlightval);
  i2c_stop();
}

void BitBang_LiquidCrystal_I2C::pulseEnable(uint8_t data) {
  expanderWrite(data | LCD_ENABLE);
  delayMicroseconds(1);
  expanderWrite(data & ~LCD_ENABLE);
  delayMicroseconds(50);
}

void BitBang_LiquidCrystal_I2C::write4bits(uint8_t value) {
  expanderWrite(value);
  pulseEnable(value);
}

void BitBang_LiquidCrystal_I2C::send(uint8_t value, uint8_t mode) {
  uint8_t highnib = value & 0xF0;
  uint8_t lownib = (value << 4) & 0xF0;
  write4bits(highnib | mode);
  write4bits(lownib | mode);
}

void BitBang_LiquidCrystal_I2C::command(uint8_t value) {
  send(value, LCD_COMMAND);
}

size_t BitBang_LiquidCrystal_I2C::write(uint8_t value) {
  send(value, LCD_DATA);
  return 1;
}

void BitBang_LiquidCrystal_I2C::begin() { init(); }

void BitBang_LiquidCrystal_I2C::init() {
  i2c_init();
  delay(50);
  _displayfunction = LCD_4BITMODE | LCD_5x8DOTS | (_rows > 1 ? LCD_2LINE : LCD_1LINE);

  write4bits(0x30); delayMicroseconds(4500);
  write4bits(0x30); delayMicroseconds(4500);
  write4bits(0x30); delayMicroseconds(150);
  write4bits(0x20); delayMicroseconds(150);

  command(LCD_FUNCTIONSET | _displayfunction);
  _displaycontrol = LCD_DISPLAYON | LCD_CURSOROFF | LCD_BLINKOFF;
  display();
  clear();
  _displaymode = LCD_ENTRYLEFT | LCD_ENTRYSHIFTDECREMENT;
  command(LCD_ENTRYMODESET | _displaymode);
  home();
}

void BitBang_LiquidCrystal_I2C::clear() { command(LCD_CLEARDISPLAY); delayMicroseconds(2000); }
void BitBang_LiquidCrystal_I2C::home() { command(LCD_RETURNHOME); delayMicroseconds(2000); }
void BitBang_LiquidCrystal_I2C::noDisplay() { _displaycontrol &= ~LCD_DISPLAYON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::display() { _displaycontrol |= LCD_DISPLAYON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::noCursor() { _displaycontrol &= ~LCD_CURSORON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::cursor() { _displaycontrol |= LCD_CURSORON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::noBlink() { _displaycontrol &= ~LCD_BLINKON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::blink() { _displaycontrol |= LCD_BLINKON; command(LCD_DISPLAYCONTROL | _displaycontrol); }
void BitBang_LiquidCrystal_I2C::scrollDisplayLeft() { command(LCD_CURSORSHIFT | LCD_DISPLAYMOVE | LCD_MOVELEFT); }
void BitBang_LiquidCrystal_I2C::scrollDisplayRight() { command(LCD_CURSORSHIFT | LCD_DISPLAYMOVE | LCD_MOVERIGHT); }
void BitBang_LiquidCrystal_I2C::leftToRight() { _displaymode |= LCD_ENTRYLEFT; command(LCD_ENTRYMODESET | _displaymode); }
void BitBang_LiquidCrystal_I2C::rightToLeft() { _displaymode &= ~LCD_ENTRYLEFT; command(LCD_ENTRYMODESET | _displaymode); }
void BitBang_LiquidCrystal_I2C::autoscroll() { _displaymode |= LCD_ENTRYSHIFTINCREMENT; command(LCD_ENTRYMODESET | _displaymode); }
void BitBang_LiquidCrystal_I2C::noAutoscroll() { _displaymode &= ~LCD_ENTRYSHIFTINCREMENT; command(LCD_ENTRYMODESET | _displaymode); }
void BitBang_LiquidCrystal_I2C::backlight() { _backlightval = LCD_BACKLIGHT; expanderWrite(0); }
void BitBang_LiquidCrystal_I2C::noBacklight() { _backlightval = LCD_NOBACKLIGHT; expanderWrite(0); }

void BitBang_LiquidCrystal_I2C::setCursor(uint8_t col, uint8_t row) {
  if (row >= _rows) row = _rows - 1;
  command(LCD_SETDDRAMADDR | (col + _row_offsets[row]));
}

void BitBang_LiquidCrystal_I2C::createChar(uint8_t location, const uint8_t charmap[]) {
  location &= 0x07;
  command(LCD_SETCGRAMADDR | (location << 3));
  for (uint8_t i = 0; i < 8; i++) send(charmap[i], LCD_DATA);
  command(LCD_SETDDRAMADDR | 0x00);
}
