// ============================================================
// SERENE MOTA BENCH FIRMWARE v2.1
// Spec: SM-FW-SPEC-v1.1
// Target: ACEBOTT ESP32-MAX-V1.0 (ESP32-WROOM-32)
// ============================================================

// ------------------------------------------------------------
// 1. Includes
// ------------------------------------------------------------
#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_INA260.h>
#include <VescUart.h>
#include <math.h>
#include <stdio.h>
#include "soc/soc.h"           // brownout fix
#include "soc/rtc_cntl_reg.h"  // brownout fix

// ------------------------------------------------------------
// 2. Pin map + I2C addresses (constants)
// ------------------------------------------------------------
static const uint8_t PIN_SDA        = 21;
static const uint8_t PIN_SCL        = 22;
static const uint8_t PIN_VESC_RX    = 16;
static const uint8_t PIN_VESC_TX    = 17;
static const uint8_t PIN_POT        = 32;
static const uint8_t PIN_SWITCH     = 33;

static const uint8_t I2C_ADDR_INA260 = 0x40;
static const uint8_t I2C_ADDR_LCD    = 0x27;

static const uint32_t SERIAL_BAUD = 115200;
static const uint32_t VESC_BAUD   = 115200;

// ------------------------------------------------------------
// 3. Timing constants
// ------------------------------------------------------------
static const uint32_t CYCLE_PERIOD_MS         = 200;  // 5 Hz scheduler
static const uint8_t  LCD_UPDATE_EVERY_N_TICK = 3;    // 600 ms LCD cadence
static const uint8_t  VESC_FAIL_THRESHOLD     = 10;   // 10 ticks ≈ 2 s

// Overtemperature failsafe thresholds (degrees Fahrenheit / Celsius).
// Firmware reads VESC mosfet temp in °C and compares against the °C constants.
static constexpr float TEMP_TRIGGER_F = 150.0f;
static constexpr float TEMP_RESUME_F  = 100.0f;
static constexpr float TEMP_TRIGGER_C = (TEMP_TRIGGER_F - 32.0f) * 5.0f / 9.0f;  // 65.56
static constexpr float TEMP_RESUME_C  = (TEMP_RESUME_F  - 32.0f) * 5.0f / 9.0f;  // 37.78

// ------------------------------------------------------------
// 4. EMA / stability / control constants
// ------------------------------------------------------------
static const float EMA_ALPHA                = 0.15f;  // ~1.1 s TC at 5 Hz
static const float STAB_MIN_POWER_W         = 5.0f;
static const float STAB_DUTY_DELTA_THRESH   = 0.05f;
static const float STAB_POWER_RATIO_MAX     = 1.5f;

static const float MIN_DUTY                 = 0.25f;
static const float MAX_DUTY_STEP            = 0.05f;  // per-tick ramp limit
static const uint8_t POT_SAMPLES            = 10;
static const float POT_START_THRESHOLD      = 0.95f;

// ------------------------------------------------------------
// 5. State enum
// ------------------------------------------------------------
enum StartupState : uint8_t {
    S_BOOT,
    S_WAIT_SUPPLY,
    S_WAIT_SWITCH_OFF,
    S_WAIT_SWITCH_ON,
    S_READY,
    S_RUN,
    S_SAFE,
    S_FAULT,
    S_COOLDOWN
};

enum FaultCode : uint8_t {
    FC_NONE,
    FC_INA260_INIT,
    FC_VESC_TIMEOUT,
    FC_I2C_LOCKUP
};

// ------------------------------------------------------------
// 6. Sensor snapshot struct
// ------------------------------------------------------------
struct SensorSnapshot {
    float gen_voltage_V;
    float gen_current_A;     // signed (may be < 0 due to shunt offset at zero flow)
    float gen_power_W;
    float vesc_voltage_V;
    float vesc_current_A;
    float vesc_power_W;
    float rpm;
    float duty_measured_pct; // 0–100
    float temp_mosfet_C;
    bool  vesc_ok;
};

// ------------------------------------------------------------
// 7. File-scope state (static)
// ------------------------------------------------------------
static LiquidCrystal_I2C lcd(I2C_ADDR_LCD, 20, 4);
static Adafruit_INA260   ina260 = Adafruit_INA260();
static HardwareSerial    VescSerial(2);
static VescUart          vesc;

static StartupState state      = S_BOOT;
static FaultCode    fault_code = FC_NONE;

static SensorSnapshot snap = {};

// Last-good VESC values (used on transient read failures)
static float   last_vesc_voltage   = 0.0f;
static float   last_vesc_current   = 0.0f;
static float   last_vesc_rpm       = 0.0f;
static float   last_vesc_duty_pct  = 0.0f;
static float   last_vesc_temp      = 0.0f;
static uint8_t vesc_fail_count     = 0;

// Smoothed (EMA) state
static float gen_v_s       = 0.0f;
static float gen_i_s       = 0.0f;  // signed; clamped only on output
static float gen_p_s       = 0.0f;
static float vesc_p_s      = 0.0f;
static float rpm_s         = 0.0f;
static float system_eff_s  = 0.0f;

// Control state
static float pot_duty          = 0.0f;
static float duty_command      = 0.0f;
static float duty_command_prev = 0.0f;
static bool  switch_on         = false;

// Stability flag
static bool unstable = true;

// COOLDOWN failsafe state
static bool  switch_was_off_since_cooldown = false;
static float cooldown_trigger_temp_c       = 0.0f;

// Scheduler
static uint32_t next_cycle_ms = 0;
static uint32_t tick_count    = 0;

// Heap baseline for drift check
static uint32_t heap_free_at_boot = 0;

// LCD flicker-free render buffers (20 cols + NUL)
static char lcd_cache[4][21];
static char lcd_new[4][21];

// Forward declarations
static void runStartup();
static void tick();
static void readSensors();
static void runSignalProcessing();
static void runControl();
static void emitJson(uint32_t timestamp_ms);
static void updateLcd();
static void enterFault(FaultCode code);
static void enterCooldown(float trigger_temp_c);
static void exitCooldown(float resume_temp_c);
static void resetSmoothed();
static float readPotNormalized();
static bool  readSwitchOn();
static void  showBootScreen();
static void  showWaitSupplyScreen();
static void  showWaitSwitchOffScreen();
static void  showWaitSwitchOnScreen();
static void  showRunScreen();
static void  showSafeScreen();
static void  showFaultScreen(FaultCode code);
static void  showCooldownScreen();

// ------------------------------------------------------------
// 8. LCD flicker-free helpers
// ------------------------------------------------------------
static void lcdFillSpaces(char row[21]) {
    for (int c = 0; c < 20; ++c) row[c] = ' ';
    row[20] = '\0';
}

static void lcdInitBuffers() {
    for (int r = 0; r < 4; ++r) {
        lcdFillSpaces(lcd_cache[r]);
        lcdFillSpaces(lcd_new[r]);
    }
}

// Mark cache as "screen is blank" (call right after lcd.clear()).
static void lcdResetCacheAfterClear() {
    for (int r = 0; r < 4; ++r) lcdFillSpaces(lcd_cache[r]);
}

// Build a line in lcd_new[row], truncated/padded to 20 chars.
static void lcdSetLine(int row, const char* s) {
    int i = 0;
    for (; i < 20 && s[i] != '\0'; ++i) lcd_new[row][i] = s[i];
    for (; i < 20; ++i) lcd_new[row][i] = ' ';
    lcd_new[row][20] = '\0';
}

// Diff lcd_new vs lcd_cache; only write changed cells. No full clear.
static void lcdCommit() {
    for (int r = 0; r < 4; ++r) {
        int c = 0;
        while (c < 20) {
            if (lcd_new[r][c] != lcd_cache[r][c]) {
                int start = c;
                while (c < 20 && lcd_new[r][c] != lcd_cache[r][c]) {
                    lcd_cache[r][c] = lcd_new[r][c];
                    ++c;
                }
                lcd.setCursor(start, r);
                for (int i = start; i < c; ++i) lcd.write(lcd_cache[r][i]);
            } else {
                ++c;
            }
        }
    }
}

// ------------------------------------------------------------
// 9. setup()
// ------------------------------------------------------------
void setup() {
    // Disable brownout detector. The VESC 5V switching supply has enough
    // ripple during motor load changes to trip the ESP32's BOD and cause
    // a hard reset. Disabling BOD prevents spurious resets; the rest of
    // the firmware's own safety logic handles true undervoltage conditions.
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

    Serial.begin(SERIAL_BAUD);
    delay(100);  // allow USB CDC to come up; startup-only, per §4

    pinMode(PIN_SWITCH, INPUT_PULLUP);

    // ADC config for pot: 12-bit, 0–3.3 V range
    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);

    Wire.begin(PIN_SDA, PIN_SCL);

    lcd.init();
    lcd.backlight();
    lcdInitBuffers();
    lcd.clear();
    lcdResetCacheAfterClear();

    heap_free_at_boot = ESP.getFreeHeap();

    // INA260 must init before anything that can produce drive output.
    if (!ina260.begin(I2C_ADDR_INA260)) {
        enterFault(FC_INA260_INIT);
        return;
    }
    ina260.setAveragingCount(INA260_COUNT_16);
    ina260.setVoltageConversionTime(INA260_TIME_1_1_ms);
    ina260.setCurrentConversionTime(INA260_TIME_1_1_ms);
    ina260.setMode(INA260_MODE_CONTINUOUS);

    VescSerial.begin(VESC_BAUD, SERIAL_8N1, PIN_VESC_RX, PIN_VESC_TX);
    // Limit blocking read time to 100ms. The default ESP32 HardwareSerial
    // timeout is 1000ms; if the VESC sends a garbage byte stream, getVescValues()
    // would block for a full second per call — far exceeding the 200ms cycle
    // period and risking a FreeRTOS watchdog reset.
    VescSerial.setTimeout(100);
    vesc.setSerialPort(&VescSerial);

    state = S_BOOT;
    showBootScreen();

    Serial.print(F("# Serene Mota bench firmware v2.1 ready. heap_free="));
    Serial.println(heap_free_at_boot);

    delay(800);  // brief banner; motor not driving yet

    // Blocking startup state machine (permitted outside loop())
    runStartup();

    // Flush any UART data the VESC sent while runStartup() was blocking.
    // If the VESC is powered during startup, it transmits telemetry continuously.
    // Without this flush, getVescValues() on the first tick reads a mix of
    // stale + new bytes — a corrupt packet — and a UART FIFO overflow on some
    // ESP32 core versions can panic-reset the MCU.
    while (VescSerial.available()) VescSerial.read();

    // Transition to main run loop
    state = S_RUN;
    showRunScreen();
    next_cycle_ms = millis() + CYCLE_PERIOD_MS;
}

// ------------------------------------------------------------
// 10. Startup state machine
// ------------------------------------------------------------
static void runStartup() {
    // Prompt: supply live + pot to full
    state = S_WAIT_SUPPLY;
    showWaitSupplyScreen();
    while (readPotNormalized() < POT_START_THRESHOLD) {
        delay(50);
    }

    // If switch is already ON at boot, prompt OFF first (safety)
    if (readSwitchOn()) {
        state = S_WAIT_SWITCH_OFF;
        showWaitSwitchOffScreen();
        while (readSwitchOn()) delay(50);
    }

    // Now wait for switch ON
    state = S_WAIT_SWITCH_ON;
    showWaitSwitchOnScreen();
    while (!readSwitchOn()) delay(50);

    state = S_READY;
    // No dedicated "ready" screen; fall through to RUN in caller.
}

// ------------------------------------------------------------
// 11. loop() — scheduler only
// ------------------------------------------------------------
void loop() {
    if (state == S_FAULT) {
        // Latched fault: periodically re-assert zero duty, then idle.
        static uint32_t last_safe_ms = 0;
        uint32_t now = millis();
        if (now - last_safe_ms >= 500) {
            last_safe_ms = now;
            vesc.setDuty(0.0f);
        }
        // Cooperative yield to FreeRTOS; prevents IDLE0 watchdog starvation.
        delay(10);
        return;
    }

    uint32_t now = millis();
    if ((int32_t)(now - next_cycle_ms) >= 0) {
        next_cycle_ms += CYCLE_PERIOD_MS;  // exact 200 ms increments
        tick();
        return;
    }
    // Cooperative yield to FreeRTOS while waiting for the next tick.
    // This is a yield, not a pacing delay — the 5 Hz cadence is still
    // driven by the next_cycle_ms comparison above.
    delay(1);
}

// ------------------------------------------------------------
// 12. tick() — main per-cycle work
// ------------------------------------------------------------
static void tick() {
    ++tick_count;
    uint32_t ts = millis();

    switch_on = readSwitchOn();

    // SAFETY: switch OFF → zero duty, reset smoothing, stay in SAFE.
    // Exception: in COOLDOWN, the OFF observation only arms the resume
    // gate. Do not transition to SAFE — the COOLDOWN tick must continue
    // (sensor read + LCD temp update + telemetry) so the operator can
    // watch the temperature drop.
    if (!switch_on) {
        if (state == S_COOLDOWN) {
            switch_was_off_since_cooldown = true;
        } else {
            // FIX: reset duty_command_prev to 0 alongside duty_command so
            // runSignalProcessing() does not see a large spurious duty_delta
            // on the first tick back in RUN, which previously caused the
            // stability gate to fire differently on the first off→on cycle.
            duty_command_prev = 0.0f;
            duty_command = 0.0f;
            vesc.setDuty(0.0f);
            resetSmoothed();
            pot_duty = 0.0f;
            unstable = true;
            if (state != S_SAFE) {
                state = S_SAFE;
                showSafeScreen();
            }
            emitJson(ts);
            return;
        }
    }

    // Coming out of SAFE back into RUN
    if (state == S_SAFE) {
        state = S_RUN;
        showRunScreen();
    }

    readSensors();

    // VESC timeout → FAULT (10 consecutive failures)
    if (!snap.vesc_ok && vesc_fail_count >= VESC_FAIL_THRESHOLD) {
        enterFault(FC_VESC_TIMEOUT);
        return;
    }

    // Overtemp trigger (RUN → COOLDOWN). Switch-OFF is handled above; this
    // fires only when state is still RUN and the VESC reading is valid.
    if (state == S_RUN && snap.vesc_ok && snap.temp_mosfet_C >= TEMP_TRIGGER_C) {
        enterCooldown(snap.temp_mosfet_C);
    }

    // Overtemp resume (COOLDOWN → RUN). Both gates must hold:
    // (i) temp ≤ resume threshold and (ii) operator has cycled the run
    // switch OFF→ON since COOLDOWN entry.
    if (state == S_COOLDOWN
        && snap.vesc_ok
        && snap.temp_mosfet_C <= TEMP_RESUME_C
        && switch_was_off_since_cooldown
        && switch_on) {
        exitCooldown(snap.temp_mosfet_C);
    }

    runSignalProcessing();
    runControl();

    emitJson(ts);

    // LCD cadence: every tick during COOLDOWN so the live °F tracks reality;
    // every 3 ticks otherwise (existing 600 ms RUN cadence).
    if (state == S_COOLDOWN || (tick_count % LCD_UPDATE_EVERY_N_TICK) == 0) {
        updateLcd();
    }
}

// ------------------------------------------------------------
// 13. readSensors()
// ------------------------------------------------------------
static void readSensors() {
    // INA260 (generator side). Library returns mV / mA as float.
    float gen_v_mV = ina260.readBusVoltage();
    float gen_i_mA = ina260.readCurrent();
    snap.gen_voltage_V = gen_v_mV / 1000.0f;
    snap.gen_current_A = gen_i_mA / 1000.0f;  // signed
    snap.gen_power_W   = snap.gen_voltage_V * snap.gen_current_A;

    // VESC UART
    bool ok = vesc.getVescValues();
    snap.vesc_ok = ok;

    if (ok) {
        vesc_fail_count = 0;
        snap.vesc_voltage_V     = vesc.data.inpVoltage;
        snap.vesc_current_A     = vesc.data.avgInputCurrent;
        snap.rpm                = (float)vesc.data.rpm;
        snap.duty_measured_pct  = vesc.data.dutyCycleNow * 100.0f;
        snap.temp_mosfet_C      = vesc.data.tempMosfet;

        last_vesc_voltage  = snap.vesc_voltage_V;
        last_vesc_current  = snap.vesc_current_A;
        last_vesc_rpm      = snap.rpm;
        last_vesc_duty_pct = snap.duty_measured_pct;
        last_vesc_temp     = snap.temp_mosfet_C;
    } else {
        if (vesc_fail_count < 255) ++vesc_fail_count;
        // Use last-good values for this tick; do not enter FAULT immediately.
        snap.vesc_voltage_V     = last_vesc_voltage;
        snap.vesc_current_A     = last_vesc_current;
        snap.rpm                = last_vesc_rpm;
        snap.duty_measured_pct  = last_vesc_duty_pct;
        snap.temp_mosfet_C      = last_vesc_temp;
    }

    snap.vesc_power_W = snap.vesc_voltage_V * snap.vesc_current_A;
}

// ------------------------------------------------------------
// 14. runSignalProcessing()
// ------------------------------------------------------------
static inline float ema(float prev, float raw) {
    return prev + EMA_ALPHA * (raw - prev);
}

static void runSignalProcessing() {
    // Smoothing (fixed 200 ms dt → α = 0.15 applies uniformly)
    gen_v_s  = ema(gen_v_s,  snap.gen_voltage_V);
    gen_i_s  = ema(gen_i_s,  snap.gen_current_A);   // signed preserved
    gen_p_s  = ema(gen_p_s,  snap.gen_power_W);
    vesc_p_s = ema(vesc_p_s, snap.vesc_power_W);
    rpm_s    = ema(rpm_s,    snap.rpm);

    // Stability gate — any one condition sets unstable
    float duty_delta = fabsf(duty_command - duty_command_prev);
    bool ratio_glitch = (vesc_p_s > 0.0f)
                        ? (gen_p_s > vesc_p_s * STAB_POWER_RATIO_MAX)
                        : true;

    unstable =  (vesc_p_s < STAB_MIN_POWER_W)
             || (duty_delta > STAB_DUTY_DELTA_THRESH)
             || ratio_glitch
             || (!snap.vesc_ok);

    // COOLDOWN forces unstable=true so §9 efficiency fields emit 0.000
    // (matches SAFE-state semantics; see CHANGES.md v2.1).
    if (state == S_COOLDOWN) {
        unstable = true;
    }

    // Efficiency: update only when stable and power is positive.
    // No constrain(0,1) — transient >1.0 values are physical.
    if (!unstable && vesc_p_s > 0.0f) {
        float raw_eff = gen_p_s / vesc_p_s;
        system_eff_s = ema(system_eff_s, raw_eff);
    }
    // else: keep system_eff_s; emitted value is zeroed below via `unstable`.
}

// ------------------------------------------------------------
// 15. runControl()
// ------------------------------------------------------------
static float readPotNormalized() {
    uint32_t sum = 0;
    for (uint8_t i = 0; i < POT_SAMPLES; ++i) {
        sum += (uint32_t)analogRead(PIN_POT);
    }
    return (float)sum / (float)(POT_SAMPLES * 4095);
}

static bool readSwitchOn() {
    // Active LOW (INPUT_PULLUP): LOW == ON
    return digitalRead(PIN_SWITCH) == LOW;
}

static void runControl() {
    // COOLDOWN: force duty=0 before any pot read. Mirrors the SAFE branch
    // semantics in tick() (operator pot is irrelevant while motor is gated off).
    if (state == S_COOLDOWN) {
        duty_command_prev = duty_command;
        duty_command = 0.0f;
        pot_duty = 0.0f;
        vesc.setDuty(0.0f);
        return;
    }

    float pot_norm = readPotNormalized();
    if (pot_norm < 0.0f) pot_norm = 0.0f;
    if (pot_norm > 1.0f) pot_norm = 1.0f;

    // Map pot range [0,1] to duty range [MIN_DUTY, 1.0]
    pot_duty = MIN_DUTY + pot_norm * (1.0f - MIN_DUTY);

    // Save previous commanded duty for next-tick stability-gate comparison
    duty_command_prev = duty_command;

    // Ramp-limited update toward pot_duty
    float delta = pot_duty - duty_command;
    if (delta >  MAX_DUTY_STEP) delta =  MAX_DUTY_STEP;
    if (delta < -MAX_DUTY_STEP) delta = -MAX_DUTY_STEP;
    duty_command += delta;

    vesc.setDuty(duty_command);
}

// ------------------------------------------------------------
// 16. emitJson()
// ------------------------------------------------------------
static void emitJson(uint32_t timestamp_ms) {
    // Build exact field values per §9 contract.
    float gen_v = gen_v_s;
    float gen_i = gen_i_s;
    if (gen_i < 0.0f) gen_i = 0.0f;        // clamp only the emitted gen_current
    float gen_p = gen_p_s;

    float vesc_v = snap.vesc_voltage_V;    // raw (no smoothing)
    float vesc_i = snap.vesc_current_A;    // raw (no smoothing)
    float vesc_p = vesc_p_s;               // smoothed V×A

    float sys_eff = unstable ? 0.0f : system_eff_s;

    // sqrt of system_eff, guarded against negative
    float per_machine = (system_eff_s > 0.0f) ? sqrtf(system_eff_s) : 0.0f;
    float mot_eff = unstable ? 0.0f : per_machine;
    float gen_eff = unstable ? 0.0f : per_machine;

    // rpm: smoothed (integer)
    long rpm_int = (long)lroundf(rpm_s);

    float duty_meas = snap.duty_measured_pct;
    float temp_c    = snap.temp_mosfet_C;

    // Buffer size: the formatted JSON line is ~290 chars at typical values
    // and up to ~330 chars at worst case (negative values, max timestamps).
    // 384 gives comfortable headroom. Do not reduce below 384.
    char buf[384];
    int n = snprintf(buf, sizeof(buf),
        "{\"timestamp_ms\":%lu,\"gen_voltage\":%.3f,\"gen_current\":%.3f,"
        "\"gen_power\":%.3f,\"vesc_voltage\":%.3f,\"vesc_current\":%.3f,"
        "\"vesc_power\":%.3f,\"system_efficiency\":%.3f,\"motor_efficiency\":%.3f,"
        "\"generator_efficiency\":%.3f,\"rpm\":%ld,\"duty\":%.2f,"
        "\"potduty\":%.3f,\"temp_mosfet\":%.2f}",
        (unsigned long)timestamp_ms, gen_v, gen_i, gen_p,
        vesc_v, vesc_i, vesc_p, sys_eff, mot_eff, gen_eff,
        (long)rpm_int, duty_meas, pot_duty, temp_c);
    if (n > 0 && n < (int)sizeof(buf)) Serial.println(buf);
}

// ------------------------------------------------------------
// 17. updateLcd()
// ------------------------------------------------------------
static void showBootScreen() {
    lcd.clear();
    lcdResetCacheAfterClear();
    lcdSetLine(0, "Serene Mota v2.1");
    lcdSetLine(1, "SM-FW-SPEC-v1.1");
    lcdSetLine(2, "Initializing...");
    lcdSetLine(3, "");
    lcdCommit();
}

static void showWaitSupplyScreen() {
    lcd.clear();
    lcdResetCacheAfterClear();
    lcdSetLine(0, "Set supply 22-28V");
    lcdSetLine(1, "Keep metal clear");
    lcdSetLine(2, "Turn pot to full");
    lcdSetLine(3, "Waiting...");
    lcdCommit();
}

static void showWaitSwitchOffScreen() {
    lcd.clear();
    lcdResetCacheAfterClear();
    lcdSetLine(0, "Switch is ON");
    lcdSetLine(1, "Flip switch OFF");
    lcdSetLine(2, "before continuing");
    lcdSetLine(3, "");
    lcdCommit();
}

static void showWaitSwitchOnScreen() {
    lcd.clear();
    lcdResetCacheAfterClear();
    lcdSetLine(0, "Ready to run");
    lcdSetLine(1, "Flip switch ON");
    lcdSetLine(2, "to start");
    lcdSetLine(3, "");
    lcdCommit();
}

// FIX: showRunScreen and showSafeScreen no longer call lcd.clear().
// The diff-write cache system (lcdCommit) handles overwriting prior content
// character-by-character with no visible blank flash. lcd.clear() is only
// needed during boot/startup where the display state is truly unknown.

static void showRunScreen() {
    lcdSetLine(0, "V:--.- I:--.- D:---");
    lcdSetLine(1, "In:---W Out:---W");
    lcdSetLine(2, "MEff:--   RPM:----");
    lcdSetLine(3, "SysEff:--  T:---F");
    lcdCommit();
}

static void showSafeScreen() {
    lcdSetLine(0, "Serene Mota: OFF");
    lcdSetLine(1, "Switch to ON");
    lcdSetLine(2, "Duty: 0.00");
    lcdSetLine(3, "RPM: 0");
    lcdCommit();
}

static void showFaultScreen(FaultCode code) {
    lcd.clear();
    lcdResetCacheAfterClear();
    const char* code_str = "UNKNOWN";
    const char* desc_str = "";
    switch (code) {
        case FC_INA260_INIT:
            code_str = "INA260_INIT";
            desc_str = "Sensor not found";
            break;
        case FC_VESC_TIMEOUT:
            code_str = "VESC_TIMEOUT";
            desc_str = "VESC UART lost";
            break;
        case FC_I2C_LOCKUP:
            code_str = "I2C_LOCKUP";
            desc_str = "I2C bus stuck";
            break;
        default: break;
    }
    char line0[21];
    snprintf(line0, sizeof(line0), "FAULT: %s", code_str);
    lcdSetLine(0, line0);
    lcdSetLine(1, desc_str);
    lcdSetLine(2, "Switch OFF to reset");
    lcdSetLine(3, "");
    lcdCommit();
}

static void showCooldownScreen() {
    // One-time transition: clear + write static lines + initial T placeholder.
    // Live °F is repainted each tick by updateLcd()'s COOLDOWN branch.
    lcd.clear();
    lcdResetCacheAfterClear();
    char line[24];
    lcdSetLine(0, "COOLDOWN: OVERTEMP");
    snprintf(line, sizeof(line), "T:---F (limit %dF)", (int)TEMP_TRIGGER_F);
    lcdSetLine(1, line);
    snprintf(line, sizeof(line), "Wait until T<=%dF", (int)TEMP_RESUME_F);
    lcdSetLine(2, line);
    lcdSetLine(3, "Then OFF then ON");
    lcdCommit();
}

static void updateLcd() {
    // COOLDOWN-state live rendering. Diff-write only; no lcd.clear().
    if (state == S_COOLDOWN) {
        char line[24];
        int  temp_f_int = (int)lroundf(snap.temp_mosfet_C * 9.0f / 5.0f + 32.0f);
        lcdSetLine(0, "COOLDOWN: OVERTEMP");
        snprintf(line, sizeof(line), "T:%dF (limit %dF)",
                 temp_f_int, (int)TEMP_TRIGGER_F);
        lcdSetLine(1, line);
        snprintf(line, sizeof(line), "Wait until T<=%dF", (int)TEMP_RESUME_F);
        lcdSetLine(2, line);
        lcdSetLine(3, "Then OFF then ON");
        lcdCommit();
        return;
    }

    // RUN-state live rendering. Diff-write only; no lcd.clear().
    float gen_v_disp = gen_v_s;
    float gen_i_disp = (gen_i_s < 0.0f) ? 0.0f : gen_i_s;
    float vesc_p_disp = vesc_p_s;
    float gen_p_disp  = gen_p_s;
    float temp_f      = snap.temp_mosfet_C * 9.0f / 5.0f + 32.0f;
    long  rpm_int     = (long)lroundf(rpm_s);

    char line[24];

    // Line 0: gen V, gen I, pot duty
    snprintf(line, sizeof(line), "V:%4.1f I:%4.2f D:%4.2f",
             gen_v_disp, gen_i_disp, pot_duty);
    lcdSetLine(0, line);

    // Line 1: VESC input power, generator output power
    snprintf(line, sizeof(line), "In:%4.1fW Out:%4.1fW",
             vesc_p_disp, gen_p_disp);
    lcdSetLine(1, line);

    // Line 2: motor efficiency, smoothed RPM
    if (unstable) {
        snprintf(line, sizeof(line), "MEff:--    RPM:%ld", rpm_int);
    } else {
        float per_machine = (system_eff_s > 0.0f) ? sqrtf(system_eff_s) : 0.0f;
        float meff_pct = per_machine * 100.0f;
        snprintf(line, sizeof(line), "MEff:%4.1f%% RPM:%ld", meff_pct, rpm_int);
    }
    lcdSetLine(2, line);

    // Line 3: system efficiency, mosfet temperature (°F)
    if (unstable) {
        snprintf(line, sizeof(line), "SysEff:--  T:%3dF", (int)lroundf(temp_f));
    } else {
        float seff_pct = system_eff_s * 100.0f;
        snprintf(line, sizeof(line), "SysEff:%4.1f%% T:%3dF",
                 seff_pct, (int)lroundf(temp_f));
    }
    lcdSetLine(3, line);

    lcdCommit();
}

// ------------------------------------------------------------
// 18. enterFault()
// ------------------------------------------------------------
static void resetSmoothed() {
    gen_v_s      = 0.0f;
    gen_i_s      = 0.0f;
    gen_p_s      = 0.0f;
    vesc_p_s     = 0.0f;
    rpm_s        = 0.0f;
    system_eff_s = 0.0f;
}

static void enterFault(FaultCode code) {
    state      = S_FAULT;
    fault_code = code;
    duty_command      = 0.0f;
    duty_command_prev = 0.0f;
    // Best-effort motor-off (may no-op if VESC UART is the faulting path).
    vesc.setDuty(0.0f);
    showFaultScreen(code);
    Serial.print(F("# FAULT code="));
    Serial.println((int)code);
}

// COOLDOWN is a recoverable runtime state — distinct from FAULT, which is
// latched until power cycle. Entered only from RUN; exits to RUN when the
// resume gates close. See FIRMWARE_REWRITE_SPEC.md §5.4.
static void enterCooldown(float trigger_temp_c) {
    state                         = S_COOLDOWN;
    duty_command_prev             = duty_command;
    duty_command                  = 0.0f;
    pot_duty                      = 0.0f;
    unstable                      = true;
    cooldown_trigger_temp_c       = trigger_temp_c;
    switch_was_off_since_cooldown = false;
    vesc.setDuty(0.0f);
    resetSmoothed();

    // Single-line event JSON. Separate from §9 telemetry — analysis filters
    // on the presence of the "event" key. Stack buffer; no String, no malloc.
    float temp_f = trigger_temp_c * 9.0f / 5.0f + 32.0f;
    char buf[128];
    int n = snprintf(buf, sizeof(buf),
        "{\"event\":\"overtemp\",\"timestamp_ms\":%lu,\"temp_f\":%.1f,\"trigger_f\":%.1f}",
        (unsigned long)millis(), temp_f, (double)TEMP_TRIGGER_F);
    if (n > 0 && n < (int)sizeof(buf)) Serial.println(buf);

    showCooldownScreen();
}

static void exitCooldown(float resume_temp_c) {
    float temp_f = resume_temp_c * 9.0f / 5.0f + 32.0f;
    char buf[128];
    int n = snprintf(buf, sizeof(buf),
        "{\"event\":\"overtemp_clear\",\"timestamp_ms\":%lu,\"temp_f\":%.1f,\"resume_f\":%.1f}",
        (unsigned long)millis(), temp_f, (double)TEMP_RESUME_F);
    if (n > 0 && n < (int)sizeof(buf)) Serial.println(buf);

    state                         = S_RUN;
    switch_was_off_since_cooldown = false;
    showRunScreen();
}
