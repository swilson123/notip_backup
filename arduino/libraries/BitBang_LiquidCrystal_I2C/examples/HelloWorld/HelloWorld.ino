#include <BitBang_LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2, 8, 9);

void setup() {
  lcd.begin();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Hello World");
}

void loop() {
}
