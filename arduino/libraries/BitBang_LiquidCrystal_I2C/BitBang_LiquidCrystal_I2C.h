#ifndef BITBANG_LIQUIDCRYSTAL_I2C_H
#define BITBANG_LIQUIDCRYSTAL_I2C_H

#include <Arduino.h>
#include <Print.h>

#define LCD_CLEARDISPLAY 0x01
#define LCD_RETURNHOME 0x02
#define LCD_ENTRYMODESET 0x04
#define LCD_DISPLAYCONTROL 0x08
#define LCD_CURSORSHIFT 0x10
#define LCD_FUNCTIONSET 0x20
#define LCD_SETCGRAMADDR 0x40
#define LCD_SETDDRAMADDR 0x80

#define LCD_ENTRYLEFT 0x02
#define LCD_ENTRYRIGHT 0x00
#define LCD_ENTRYSHIFTINCREMENT 0x01
#define LCD_ENTRYSHIFTDECREMENT 0x00

#define LCD_DISPLAYON 0x04
#define LCD_DISPLAYOFF 0x00
#define LCD_CURSORON 0x02
#define LCD_CURSOROFF 0x00
#define LCD_BLINKON 0x01
#define LCD_BLINKOFF 0x00

#define LCD_DISPLAYMOVE 0x08
#define LCD_CURSORMOVE 0x00
#define LCD_MOVERIGHT 0x04
#define LCD_MOVELEFT 0x00

#define LCD_8BITMODE 0x10
#define LCD_4BITMODE 0x00
#define LCD_2LINE 0x08
#define LCD_1LINE 0x00
#define LCD_5x10DOTS 0x04
#define LCD_5x8DOTS 0x00

#define LCD_BACKLIGHT 0x08
#define LCD_NOBACKLIGHT 0x00
#define LCD_ENABLE 0x04
#define LCD_COMMAND 0x00
#define LCD_DATA 0x01

class BitBang_LiquidCrystal_I2C : public Print {
public:
  BitBang_LiquidCrystal_I2C(uint8_t addr, uint8_t cols, uint8_t rows, int sdaPin = 8, int sclPin = 9);

  void begin();
  void init();
  void clear();
  void home();
  void setCursor(uint8_t col, uint8_t row);
  void noDisplay();
  void display();
  void noCursor();
  void cursor();
  void noBlink();
  void blink();
  void scrollDisplayLeft();
  void scrollDisplayRight();
  void leftToRight();
  void rightToLeft();
  void autoscroll();
  void noAutoscroll();
  void backlight();
  void noBacklight();
  void createChar(uint8_t location, const uint8_t charmap[]);
  void setPins(int sdaPin, int sclPin);
  virtual size_t write(uint8_t value);

  using Print::write;

private:
  uint8_t _addr;
  uint8_t _cols;
  uint8_t _rows;
  uint8_t _displayfunction;
  uint8_t _displaycontrol;
  uint8_t _displaymode;
  uint8_t _backlightval;
  int _sdaPin;
  int _sclPin;
  int _row_offsets[4];

  void i2c_init();
  void i2c_start();
  void i2c_stop();
  bool i2c_write(uint8_t data);
  void expanderWrite(uint8_t data);
  void pulseEnable(uint8_t data);
  void write4bits(uint8_t value);
  void send(uint8_t value, uint8_t mode);
  void command(uint8_t value);
};

#define LiquidCrystal_I2C BitBang_LiquidCrystal_I2C

#endif
