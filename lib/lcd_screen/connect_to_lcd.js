// LCD 1: no jumpers → 0x27
// LCD 2: bridge A0 → 0x26
// LCD 3: bridge A1 → 0x25
//
// Hosyond 2004 (20x4) IIC LCD modules via PCF8574 backpack.
// PCF8574 backpack bit layout: D7 D6 D5 D4 BL E RW RS

const BACKLIGHT = 0x08;
const ENABLE    = 0x04;
const RS_CMD    = 0x00;
const RS_DATA   = 0x01;

// HD44780 DDRAM row offsets for 20x4 displays.
const ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pulse(bus, addr, data) {
    await bus.sendByte(addr, data | ENABLE | BACKLIGHT);
    await sleep(1);
    await bus.sendByte(addr, (data & ~ENABLE) | BACKLIGHT);
    await sleep(1);
}

async function sendNibble(bus, addr, nibble, mode) {
    await pulse(bus, addr, (nibble & 0xF0) | mode);
}

async function sendByte(bus, addr, byte, mode) {
    await sendNibble(bus, addr, byte & 0xF0, mode);
    await sendNibble(bus, addr, (byte << 4) & 0xF0, mode);
    await sleep(1);
}

async function sendCommand(bus, addr, cmd) {
    await sendByte(bus, addr, cmd, RS_CMD);
    await sleep(2);
}

async function sendData(bus, addr, byte) {
    await sendByte(bus, addr, byte, RS_DATA);
}

async function initLCD(bus, addr) {
    await sleep(50);
    // 4-bit init sequence (3 attempts required by HD44780 spec)
    await sendNibble(bus, addr, 0x30, RS_CMD); await sleep(5);
    await sendNibble(bus, addr, 0x30, RS_CMD); await sleep(1);
    await sendNibble(bus, addr, 0x30, RS_CMD); await sleep(1);
    await sendNibble(bus, addr, 0x20, RS_CMD); // switch to 4-bit mode
    // 20x4 panels still use the "2-line" function-set bit; rows 2/3 are reached
    // via DDRAM offsets (0x14, 0x54), not the function-set N bit.
    await sendCommand(bus, addr, 0x28); // 4-bit, 2 lines, 5x8
    await sendCommand(bus, addr, 0x08); // display off
    await sendCommand(bus, addr, 0x01); // clear display
    await sleep(3);
    await sendCommand(bus, addr, 0x06); // entry mode: increment, no shift
    await sendCommand(bus, addr, 0x0C); // display on, cursor off, blink off
}

function makeLCDInstance(bus, addr) {
    return {
        clear: () => sendCommand(bus, addr, 0x01).then(() => sleep(2)),
        setCursor: (col, row) => sendCommand(bus, addr, 0x80 | (col + (ROW_OFFSETS[row] || 0))),
        writeString: async (str) => {
            for (const ch of str.slice(0, 20)) {
                await sendData(bus, addr, ch.charCodeAt(0));
            }
        },
        writeChars: async (codes) => {
            for (const code of codes.slice(0, 20)) {
                await sendData(bus, addr, code & 0xFF);
            }
        },
        loadCgram: async (chars) => {
            // chars: array of up to 8 entries, each an 8-byte pattern (low 5 bits used).
            await sendCommand(bus, addr, 0x40); // CGRAM address 0
            for (const ch of chars) {
                for (const row of ch) {
                    await sendData(bus, addr, row & 0x1F);
                }
            }
            await sendCommand(bus, addr, 0x80); // back to DDRAM home
        }
    };
}

var connect_to_lcd = async function (white_rabbit) {
    const bus = await white_rabbit.i2c.openPromisified(1);

    for (const key of ['screen1', 'screen2', 'screen3']) {
        const screen = white_rabbit.lcd_screens[key];
        try {
            await initLCD(bus, screen.address);
            screen.connected = true;
            screen.instance = makeLCDInstance(bus, screen.address);
            screen.atlas_loaded = false;
            console.log(`LCD ${key} connected at 0x${screen.address.toString(16)}`);
        } catch (err) {
            screen.connected = false;
            console.log(`LCD ${key} failed at 0x${screen.address.toString(16)}: ${err.message}`);
        }
    }

    if (!white_rabbit.lcd_screens.write_to_lcd_interval) {
        white_rabbit.lcd_screens.tick = 0;
        // Use recursive setTimeout so the next write only starts after the previous
        // one fully completes — prevents interleaved I2C writes that garble the display.
        // 100ms base tick = 10Hz. write_to_lcd refreshes LCD3 (vision) every tick and
        // the slower mouth/status screens on their own cadences. Because the next write
        // is scheduled only after the previous finishes, a heavy tick self-throttles
        // instead of queueing.
        const LCD_TICK_MS = 100;
        const scheduleLcd = () => {
            white_rabbit.write_to_lcd(white_rabbit).catch(e => {
                console.log('LCD write error:', e.message);
            }).finally(() => {
                white_rabbit.lcd_screens.write_to_lcd_interval = setTimeout(scheduleLcd, LCD_TICK_MS);
            });
        };
        white_rabbit.lcd_screens.write_to_lcd_interval = setTimeout(scheduleLcd, LCD_TICK_MS);
    }
};

module.exports = connect_to_lcd;
