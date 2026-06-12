# BitBang_LiquidCrystal_I2C

A **drop-in replacement** for `LiquidCrystal_I2C` that uses a **pure software (bit-banged) I2C** engine on any pair of GPIO pins.  
Designed for HD44780-compatible character LCDs with PCF8574/PCF8574A I2C backpacks. 

---

## Features

- Same class name and API as `LiquidCrystal_I2C` (via macro alias).
- Works on **any digital pins** (you choose SDA/SCL).
- No `Wire` dependency – useful on boards where hardware I2C pins are busy or awkward.
- Supports:
  - `print()` / `println()` via `Print` base class.
  - `setCursor()`, `clear()`, `home()`, scrolling, etc.
  - `createChar()` for custom characters (CGRAM).
  - `backlight()` / `noBacklight()` for PCF8574-based backlight control.

---

## Installation

1. Download or clone this repository.
2. Copy the folder `BitBang_LiquidCrystal_I2C` into your Arduino `libraries` directory:
   - Windows: `Documents/Arduino/libraries/`
   - macOS: `~/Documents/Arduino/libraries/`
   - Linux: `~/Arduino/libraries/`
3. Restart the Arduino IDE.
4. You should now see `BitBang_LiquidCrystal_I2C` under **Sketch → Include Library**.

---

## Quick Start

```cpp
#include <BitBang_LiquidCrystal_I2C.h>

// addr, cols, rows, sdaPin, sclPin
LiquidCrystal_I2C lcd(0x27, 16, 2, 8, 9);

void setup() {
  lcd.begin();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Hello World");
}

void loop() {
}
```

- `0x27` is the common 7‑bit address for many I2C LCD backpacks; `0x3F` is another frequent one.
- The constructor automatically shifts the 7‑bit address for 8‑bit I2C writes internally.

---

## Choosing SDA/SCL Pins

Unlike hardware I2C (which is fixed to specific pins), this library lets you **bit-bang** I2C on any two digital pins.

### Constructor-based pin selection

```cpp
// addr, cols, rows, sdaPin, sclPin
LiquidCrystal_I2C lcd(0x27, 16, 2, 8, 9);   // SDA = 8, SCL = 9
```

### Changing pins at runtime

```cpp
lcd.setPins(10, 11);  // SDA = 10, SCL = 11
lcd.begin();          // Re-initialize after changing pins
```

### Guidelines for choosing pins

- Use pins that support `digitalRead()` and `digitalWrite()` reliably (most GPIOs).
- Avoid pins already used for:
  - Hardware serial (e.g. `0`, `1` on some boards), unless you know the tradeoffs.
  - Critical timing or interrupts, if your sketch relies on them.
- Keep SDA/SCL wiring short and add pull-ups (typically 4.7 kΩ to VCC) if the internal pull-ups are not enough.

---

## Address Selection

Most PCF8574 LCD backpacks use:

- `0x27` (PCF8574) or
- `0x3F` (PCF8574A).

If you’re not sure which:

1. Run a standard I2C scanner using hardware I2C on another board or sketch.
2. Look for the detected address (e.g. `0x27`) and use that in the constructor.

```cpp
LiquidCrystal_I2C lcd(0x3F, 20, 4, 8, 9);
```

---

## Backlight Control

Most I2C LCD backpacks drive the backlight LED from one of the PCF8574 pins, giving **on/off control**, not analog dimming.

### API

```cpp
lcd.backlight();     // Turn backlight ON
lcd.noBacklight();  // Turn backlight OFF
```

Internally, the library maintains a `_backlightval` mask and ORs it into every PCF8574 output byte, just like typical `LiquidCrystal_I2C` implementations. [web:79][web:85]

If your backpack’s backlight doesn’t respond, check the board’s jumper or solder bridge for the backlight pin.

---

## Custom Characters (CGRAM)

The HD44780 controller allows up to **8 custom characters** (locations 0–7) stored in CGRAM.

### Defining a custom character

Each character is an array of 8 bytes, one per row, using the lower 5 bits for pixels:

```cpp
const uint8_t smiley = {[4]
  0b00000,
  0b00000,
  0b01010,
  0b00000,
  0b01010,
  0b00000,
  0b01110,
  0b00000
};
```

### Creating and using it

```cpp
lcd.createChar(0, smiley);  // location 0 (0–7)
lcd.setCursor(0, 0);
lcd.print("Hello ");
lcd.write(uint8_t(0));      // prints the custom char
```

The library:
- Writes the 8 bytes into CGRAM.
- Returns to DDRAM mode afterward to avoid corrupting the display with subsequent writes.

---

## Printing and `println()`

Because the library inherits from `Print`, you can use:

```cpp
lcd.print("Hello");
lcd.println("World");
```

### Important behavior on character LCDs

- `println()` sends a newline character (`\n`) after the text, but HD44780 does **not** interpret `\n` as “go to next row” on its own.
- The library does not try to emulate full terminal behavior; instead:
  - Use `setCursor(col, row)` to position text explicitly.
  - Overwrite whole lines or pad with spaces to avoid leftover characters.

Example:

```cpp
lcd.setCursor(0, 0);
lcd.print("Hello World");
lcd.setCursor(0, 1);
lcd.print("Line 2       ");  // pad to clear previous content
```

---

## Example: Hello World

```cpp
#include <BitBang_LiquidCrystal_I2C.h>

// addr, cols, rows, sdaPin, sclPin
LiquidCrystal_I2C lcd(0x27, 16, 2, 8, 9);

void setup() {
  lcd.begin();
  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("Hello World");

  lcd.setCursor(0, 1);
  lcd.print("Bit-bang I2C");
}

void loop() {
}
```

---

## Example: Backlight Toggle

```cpp
#include <BitBang_LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2, 8, 9);

void setup() {
  lcd.begin();
  lcd.print("Backlight demo");
}

void loop() {
  lcd.backlight();
  delay(1000);
  lcd.noBacklight();
  delay(1000);
}
```

---

## Compatibility Notes

- API is intentionally aligned with common `LiquidCrystal_I2C` libraries:
  - `begin()`, `clear()`, `home()`, `setCursor()`, `display()`, `noDisplay()`,
    `cursor()`, `noCursor()`, `blink()`, `noBlink()`,
    `scrollDisplayLeft()`, `scrollDisplayRight()`,
    `leftToRight()`, `rightToLeft()`, `autoscroll()`, `noAutoscroll()`,
    `backlight()`, `noBacklight()`, `createChar()`.
- The main difference is **how pins are chosen**:
  - Hardware I2C libraries: pins are fixed by the MCU.
  - This library: SDA/SCL are constructor parameters or set via `setPins()`.

---

## Troubleshooting

- **Nothing on screen**
  - Check address (`0x27` vs `0x3F`) with an I2C scanner.
  - Verify pull-ups on SDA/SCL (4.7 kΩ recommended for 5 V).
  - Ensure contrast pot on the backpack is adjusted until blocks/text are visible.
- **Garbled characters**
  - Ensure `createChar()` is used with 0–7 only.
  - Avoid writing to CGRAM during normal display updates.

- **Backlight doesn’t toggle**
  - Verify your backpack actually has the backlight pin wired to the PCF8574 output (some boards hard-wire it).
