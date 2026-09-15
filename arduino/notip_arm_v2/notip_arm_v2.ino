#include <Servo.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>

// BOARD: Arduino UNO R4 (Renesas RA4M1, renesas_uno core) — NOT the ATmega328P
// this sketch was first written for. Select an UNO R4 in the IDE; the interrupt
// code below is written against the RA4M1's ICU, not AVR pin-change interrupts.
//
// Companion-computer link — the companion computer (notip.js) connects over the
// R4's native USB, which IS `Serial` here. Unlike the 328P, `Serial` is not the
// pins 0/1 UART — that is `Serial1`, and nothing uses it, so D0/D1 are free.
// Two R4 consequences worth knowing: the baud value is cosmetic on USB CDC (it
// still must not contradict notip.js, which opens at 38400), and opening the
// port does NOT reset the board the way the 328P's auto-reset did — so the boot
// state at the end of setup() is established on real power-up only, not on
// every companion reconnect.
//
// The arm is a SERVO again (2026-08-31) — the same actuator notip_arm.ino
// drives, back on a single pin. The DC gearmotor this file was written for is
// gone, and with it arm_lpwm/arm_rpwm, both arm Hall channels, arm_position
// and the shared driver enable. The telescope is still a DC gearmotor on an
// H-bridge, and it now owns telescope_enable_pin alone.
//
// Servo.h is therefore back, and on the R4 it is safe where it was not on the
// 328P. There an arm servo would have fought Timer1, the PWM source for pins
// 9 and 10. The R4's Servo never touches the pin's PWM — one periodic GPT
// timer toggles the pin from an ISR — so arm_pin needs no PWM channel of its
// own and can sit on 10. It does claim a GPT timer, and that timer is the one
// ordering rule in setup(); read the note there before moving arm.attach().

//Servos....................................................................................
Servo arm;

//Motor / Actuator Pins.....................................................................
int arm_pin = 10;               // servo signal — the arm's ONLY pin. No H-bridge, no enable,
                                // no Hall channel: the servo holds its own commanded angle.

int telescope_pin_rpwm = 5;     // extend  (PWM)
int telescope_pin_lpwm = 6;     // retract (PWM)
int telescope_enable_pin = 9;   // enables the telescope driver (the arm is a servo — no enable)
int telescope_pin_hall_1 = 8;   // pulse            (HALL 1 / YELLOW wire) — external interrupt.
                                // WAS pin 7. Moved for the R4: D7 has no ICU interrupt (see below).
int telescope_pin_hall_2 = 7;   // quadrature phase (HALL 2 / WHITE wire)  WAS pin 8.
                                // REWIRE: the two telescope Hall wires swap header pins. Yellow is
                                // still the pulse channel and white still the phase, so the
                                // quadrature direction sense is unchanged — only the pins moved.

int belt_pin = 3;               // step
int belt_direction_pin = 4;
int belt_enable_pin = 2;
int belt_extend_limit_switch_pin = A4;
int belt_retract_limit_switch_pin = A5;

int hook_limit_switch_pin = A3;

// Previous (v1) wiring, kept for reference:
//   arm = servo on 4, belt step 9 / dir 10 / enable 8, telescope rpwm 11 / lpwm 6 /
//   enable 3 / hall 2,5, hook switch 7.


AccelStepper actuator(AccelStepper::DRIVER, belt_pin, belt_direction_pin);

//Hall Position Tracking..........................................................................
// Calibrate: extend fully, read telescope_position from heartbeat, set that value here.
#define TELESCOPE_FULL_EXTEND_PULSES 50000

volatile long telescope_position = 0;   // signed pulse count; 0 = fully retracted
volatile bool new_telescope_hall_pulse = false;
volatile bool telescope_has_moved = false;  // guards position stop from firing before first pulse
unsigned long last_telescope_hall_pulse_ms = 0;
long telescope_retract_start_pos = 0;

// The telescope's HALL 1 is the only interrupt in this sketch — the arm is a
// servo and counts nothing. On the 328P even this one had to be done with PCINT
// registers, because pins 2 and 3 — the only INT0/INT1 pins — belong to the belt
// driver. The RA4M1 has no such two-pin limit, so it is a plain attachInterrupt()
// now, still on the CHANGE edge: pulse counts keep their old scale and
// TELESCOPE_FULL_EXTEND_PULSES stays valid.
//
// READ THIS BEFORE MOVING A HALL 1 PIN. Only a subset of pins is wired to the
// RA4M1's interrupt controller, and attachInterrupt() on any other pin fails
// SILENTLY — it compiles, it runs, and the pulses simply never arrive: position
// frozen at 0, stall detection blind. Interrupt-capable on BOTH R4 variants
// (Minima and WiFi):
//     D0, D1, D2, D3, D8, D12, A1, A2, A3, A4, A5
// D4, D5, D7, D9, D10 and A0 are not, on either board. D6, D11 and D13 are
// interrupt-capable on one variant and not the other — do not use them.
// Verified against the installed core's variant pin tables (variants/*/pinmux.inc,
// PIN_INTERRUPT entries), not from a pinout diagram.
//
// Two further constraints, both silent when violated:
//   • The core allocates exactly EXT_INTERRUPTS_HOWMANY = 2 external-interrupt
//     slots. The telescope Hall uses one; the arm's motor Hall used to use the
//     other, and giving that slot back is the only gain from the servo swap
//     here. At most one more attachInterrupt() will work anywhere in this
//     sketch — a third does nothing, silently.
//   • Two pins in use at once must sit on different ICU channels. D8 is
//     channel 9; nothing else here opens an interrupt, so nothing can clash.

void telescope_hall_isr() {
  new_telescope_hall_pulse = true;
  telescope_has_moved = true;
  // Quadrature: phase of hall_2 determines direction
  if (digitalRead(telescope_pin_hall_2) == LOW) {
    telescope_position++;   // extending
  } else {
    telescope_position--;   // retracting
  }
}


//States...................................................................................
bool auto_delivery = false;
bool package_dropped = false;   // hook released during delivery (package gone). Report-only:
                                // tells the companion computer to start the return trip.
                                // Does NOT alter the auto-delivery retract/stow sequence.
bool stow_arm_active = false;
bool stow_arm_arm_commanded = false;
bool stowed = false;
bool telescope_stall = false;   // set when motor is driving but Hall pulses stop arriving
bool telescope_ignore_hall = true; // command-driven mode: ignore Hall-based stop decisions
bool belt_hold_position = true; // keep the belt driver energised at standstill so the
                                // carriage is BRAKED whenever the board is powered.
                                // The old screw actuator was self-locking — a screw
                                // holds its load with the motor dead. The FPB45 is a
                                // belt module and holds nothing: with the driver off
                                // the carriage free-wheels, and Noah's own throttle
                                // and hard stops throw it up and down the rail.
                                // Stepper holding torque IS the brake here; there is
                                // no other one. Set false only to free the carriage
                                // by hand (see the heat note at update comment below).
String arm_state = "stopped";
String telescope_state = "stopped";
String belt_state = "stopped";
bool hook_switch_state = false;
bool belt_extend_switch_state = false;
bool belt_retract_switch_state = false;

//Timeouts (failsafe only — the servo arm reaches its angle on its own)....................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int telescope_extend_timeout = 30000;   // safety backup if Hall signal is lost
int telescope_retract_timeout = 30000;

int belt_extend_timeout = 30000;
int belt_retract_timeout = 30000;

//Extend and Retract values.................................................................
// The arm's three are SERVO ANGLES again (notip_arm.ino's own values), not the PWM
// duty the gearmotor took. Servo::write() constrains to 0-180 on both cores, so 200
// simply means "full extend" — it is the 0-200 scale radio_claw_commands.js sends,
// not 200 degrees. The telescope's two below are still PWM duty (0-255).
int arm_extend_value = 200;
int arm_retract_value = 25;
int arm_delivery_value = 0;

int telescope_extend_value = 200;
int telescope_retract_value = 200;

//Timestamps...............................................................................
long arm_time_stamp = 0;
long belt_time_stamp = 0;
long telescope_time_stamp = 0;
long current_time_stamp = 0;
long old_time_stamp = 0;

//Serial string................................................................................
String inputString = "";


//Setup......................................................................................
void setup() {

  //Belt Pins...........
  actuator.setMaxSpeed(3000);
  actuator.setAcceleration(1200);
  actuator.setCurrentPosition(0);
  // BELT DIRECTION REVERSED (2026-08-24). The FPB45 is wired so that the DIR
  // level the library calls "forward" drives the carriage the wrong way — it
  // ran backwards to the screw actuator it replaced. This is a fact about the
  // DIR pin, so it is stated at the pin: one flag, and every layer above keeps
  // its meaning. extend_belt() still extends, the A4/A5 limit switches still
  // guard the ends they are bolted to, the stow sequence is untouched, and
  // actuator.currentPosition() still counts UP while extending — the same
  // positive-is-extending convention telescope_position uses.
  // This is the ONLY place the belt's direction is flipped. If it ever needs
  // reversing again, flip it here; do not also swap the signs in move_belt(),
  // or the two cancel out and nothing appears to change.
  actuator.setPinsInverted(true, false, false);   // (direction, step, enable)
  pinMode(hook_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_extend_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_retract_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_enable_pin, OUTPUT);
  digitalWrite(belt_enable_pin, belt_hold_position ? HIGH : LOW);

  //Telescope Driver Pins...........
  pinMode(telescope_enable_pin, OUTPUT);
  digitalWrite(telescope_enable_pin, LOW);
  pinMode(telescope_pin_rpwm, OUTPUT);
  pinMode(telescope_pin_lpwm, OUTPUT);
  // These two analogWrite(…, 0) calls are what actually open the telescope's PWM
  // channels, and they MUST stay ahead of arm.attach() below. Renesas detail with
  // no warning when you get it wrong: the R4's Servo takes the lowest FREE GPT
  // timer, and D6 — telescope_pin_lpwm, the RETRACT direction — is GPT channel 0,
  // the very first one it would take. Attach the servo first and the telescope's
  // later analogWrite() finds its own channel already claimed. Extend would still
  // work, retract would not, and nothing would say why. Keep this order.
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);

  //Hall Sensor Pins...........
  pinMode(telescope_pin_hall_1, INPUT_PULLUP);
  pinMode(telescope_pin_hall_2, INPUT_PULLUP);
  // After the pinMode calls above, deliberately: the core preserves whatever
  // pull-up state the pin already has when the interrupt is opened.
  attachInterrupt(digitalPinToInterrupt(telescope_pin_hall_1), telescope_hall_isr, CHANGE);

  Serial.begin(38400);

  //Arm Servo........... (after the telescope's analogWrite calls — see the note above)
  arm.attach(arm_pin);
  arm.write(arm_retract_value);   // move to stowed position on boot so the arm doesn't raise
  arm_state = "close";
  stowed = true;

}


//Loop......................................................................................
void loop() {
  read_companion();
  heartbeat();
  actuator.run();
}


//Serial..................................................................................
void read_companion() {
  while (Serial.available()) {
    char inChar = (char)Serial.read();
    if (inChar == '\n') {
      message_received(inputString);
      inputString = "";
    } else {
      inputString += inChar;
    }
  }
}

//Message received from Companion Computer........................................................
void message_received(String json) {
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, json);

  String message = doc["message"];
  int value = doc["value"];
  int value_invert = 200 - value;

  if (message == "deliver_package") {
    stow_arm_active = false;
    stow_arm_arm_commanded = false;
    stowed = false;
    deliver_package(value);
  }
  else if (message == "stow_arm") {
    auto_delivery = false;
    stow_arm();
  }
  else if (message == "belt") {
    // The belt is the ONE actuator whose RC value arrives as raw PWM: the arm and
    // the telescope above are pre-scaled to 0-200 by convertActuatorValue() in
    // radio_claw_commands.js, the belt is not (that file sends chan12_raw straight
    // through — it is the only sender of this message).
    //
    // The window must therefore be symmetric about 1500 and sit well inside the
    // channel's real travel. It was `> 1800` / `< 1100`, which is neither, and
    // the low edge had almost no margin: convertActuatorValue() in that same JS
    // file clamps these aux channels to 1050-1950, i.e. the low end of a channel
    // this transmitter actually produces sits within ~50us of the 1100 threshold
    // while the high end clears 1800 by ~150us. Any endpoint trim, failsafe
    // rescale or switch that only travels to ~1100 puts the retract half of the
    // stick in the neutral branch permanently — the belt then extends on command
    // and refuses to retract, which reads as a wiring fault but is not one.
    // 1300/1700 gives 200us of equal margin on both sides.
    if (value > 1700) {
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
      extend_belt();
    } else if (value < 1300) {
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
      retract_belt();
    } else {
      belt_state = "stopped";
      stop_belt_motor();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
    }
  }
  else if (message == "arm") {
    // Servo again, so the 0-200 value is a POSITION, not a three-way switch like
    // the telescope below: the whole stick travel is live and the angle is written
    // straight through. The servo holds it — there is nothing to stop.
    if (value != arm_retract_value) {
      stowed = false;
    }
    arm.write(value);
    auto_delivery = false;
    stow_arm_active = false;
    stow_arm_arm_commanded = false;
  }
  else if (message == "telescope") {
    if (value < 10) {
      extend_telescope();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
    } else if (value > 120) {
      retract_telescope();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
    } else {
      telescope_state = "stopped";
      stop_telescope_motor();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
    }
  }
  else {
    Serial.print("unknown message: ");
    Serial.println(message);
  }
}


//Start Package Delivery...........................................................................
void deliver_package(int value) {
  if (!auto_delivery) {
    package_dropped = false;   // fresh delivery — clear the previous drop flag
    auto_delivery = true;
    extend_belt();
  }
}

void stow_arm() {
  stow_arm_active = true;
  stow_arm_arm_commanded = false;

  bool telescope_home = telescope_ignore_hall ? (telescope_state == "close") : (telescope_position <= 0);
  bool already_stowed = (digitalRead(belt_retract_limit_switch_pin) == HIGH) && telescope_home && (arm_state == "close");
  if (!already_stowed) {
    stowed = false;
  }

  // Start these in parallel when needed.
  if (digitalRead(belt_retract_limit_switch_pin) == HIGH) {
    close_belt();
  } else {
    retract_belt();
  }

  if (telescope_ignore_hall) {
    retract_telescope();
  } else {
    if (telescope_position <= 0) {
      telescope_position = 0;
      close_telescope();
    } else {
      retract_telescope();
    }
  }
}

//Send Current delivery states to companion computer................................................
void send_current_state() {
  Serial.print("{'belt_state':'");
  Serial.print(belt_state);
  Serial.print("','arm_state':'");
  Serial.print(arm_state);
  // The arm's two hard facts, read off the Servo object itself — attach() can fail
  // silently on the R4 (no free GPT timer), and write() is then a no-op forever.
  // arm_attached 0 = the pin was never driving. arm_attached 1 with arm_us moving
  // as the stick moves = the board IS pulsing D10, and the fault is past this pin.
  Serial.print("','arm_attached':'");
  Serial.print(arm.attached());
  Serial.print("','arm_us':'");
  Serial.print(arm.readMicroseconds());
  Serial.print("','telescope_state':'");
  Serial.print(telescope_state);
  Serial.print("','telescope_position':'");
  Serial.print(telescope_position);
  Serial.print("','hook_switch_state':'");
  Serial.print(hook_switch_state);
  Serial.print("','belt_extend_switch_state':'");
  Serial.print(belt_extend_switch_state);
  Serial.print("','belt_retract_switch_state':'");
  Serial.print(belt_retract_switch_state);
  Serial.print("','auto_delivery':'");
  Serial.print(auto_delivery);
  Serial.print("','package_dropped':'");
  Serial.print(package_dropped);
  Serial.print("','stow_arm_active':'");
  Serial.print(stow_arm_active);
  Serial.print("','stowed':'");
  Serial.print(stowed);
  Serial.print("','telescope_stall':'");
  Serial.print(telescope_stall);
  Serial.print("','telescope_hall_age_ms':'");
  Serial.print(last_telescope_hall_pulse_ms > 0 ? (long)(current_time_stamp - last_telescope_hall_pulse_ms) : -1);
  Serial.println("'}");
}


//Heartbeat ........................................................................................
void heartbeat() {
  current_time_stamp = millis();

  // Latch last pulse timestamp safely in main loop (avoid millis() inside ISR)
  if (new_telescope_hall_pulse) {
    last_telescope_hall_pulse_ms = current_time_stamp;
    new_telescope_hall_pulse = false;
  }

  //Serial....................
  if (current_time_stamp > old_time_stamp + 1000) {
    send_current_state();
    old_time_stamp = current_time_stamp;
  }

  //Arm Up — the timeout is how long the servo is given to reach the angle.
  if (arm_state == "extend" && arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_extend_timeout) {
    open_arm();
  }

  //Arm Down.......................
  if (arm_state == "retract" && arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_retract_timeout) {
    close_arm();
  }

  //Telescope Extend — position-based stop (timeout is failsafe only)
  if (telescope_state == "extend") {
    // Reinforce enable pin — a glitch low would stall the motor silently.
    digitalWrite(telescope_enable_pin, HIGH);

    if (!telescope_ignore_hall && telescope_has_moved && telescope_position >= TELESCOPE_FULL_EXTEND_PULSES) {
      open_telescope();
    } else if (telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_extend_timeout) {
      open_telescope();  // failsafe: Hall signal may have been lost
    }

    // Stall detection: motor commanded, first pulse received, but no new pulses for 500 ms.
    if (!telescope_ignore_hall && telescope_has_moved && last_telescope_hall_pulse_ms > 0 && (current_time_stamp - last_telescope_hall_pulse_ms) > 500) {
      telescope_stall = true;
    }
  }

  //Telescope Retract — position-based stop; zero counter when home is reached
  if (telescope_state == "retract") {
    // Reinforce enable pin — a glitch low would stall the motor silently.
    digitalWrite(telescope_enable_pin, HIGH);

    if (!telescope_ignore_hall && telescope_has_moved && telescope_position <= 0) {
      telescope_position = 0;
      close_telescope();
    } else if (telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_retract_timeout) {
      telescope_position = 0;  // assume home after failsafe timeout
      close_telescope();
    }

    // Stall detection: motor commanded, first pulse received, but no new pulses for 500 ms.
    if (!telescope_ignore_hall && telescope_has_moved && last_telescope_hall_pulse_ms > 0 && (current_time_stamp - last_telescope_hall_pulse_ms) > 500) {
      telescope_stall = true;
    }
  }

  //Belt Hold.......................
  // The belt driver's enable is the carriage's ONLY brake — reinforced every tick
  // for the same reason the arm/telescope enable is above: a single glitch low
  // would silently release it, and here that means the carriage starts sliding.
  if (belt_hold_position) {
    digitalWrite(belt_enable_pin, HIGH);
  }

  //Belt Extended.......................
  if (belt_state == "extend" && belt_time_stamp != 0 && current_time_stamp > belt_time_stamp + belt_extend_timeout) {
    open_belt();
  }

  //Belt Retracted.......................
  if (belt_state == "retract" && belt_time_stamp != 0 && current_time_stamp > belt_time_stamp + belt_retract_timeout) {
    close_belt();
  }

  //Any active motion means rover is no longer in a stowed hold state.
  if (stowed && (belt_state == "extend" || belt_state == "retract" || arm_state == "extend" || arm_state == "retract" || telescope_state == "extend" || telescope_state == "retract")) {
    stowed = false;
  }

  //Hook Limit Switch................
  if (digitalRead(hook_limit_switch_pin) == HIGH) {
    // A released hook during an active delivery means the package has dropped.
    // Latch it so the companion computer can start the return trip immediately;
    // the auto-delivery retract/stow sequence is left running untouched.
    if (auto_delivery && arm_state == "retract") {
      package_dropped = true;
    }
    if (hook_switch_state == false && (arm_state == "close" || arm_state == "retract")) {
      delay(250);
      close_arm();
      hook_switch_state = true;
    }
  } else {
    hook_switch_state = false;
  }

  //Belt Extend Limit Switch................
  if (digitalRead(belt_extend_limit_switch_pin) == HIGH) {
    if (belt_extend_switch_state == false && belt_state == "extend") {
      open_belt();
      belt_extend_switch_state = true;
    }
  } else {
    belt_extend_switch_state = false;
  }

  //Belt Retract Limit Switch................
  if (digitalRead(belt_retract_limit_switch_pin) == HIGH) {
    if (belt_retract_switch_state == false && belt_state == "retract") {
      close_belt();
      belt_retract_switch_state = true;
    }
  } else {
    belt_retract_switch_state = false;
  }

  //Stow Sequence: once belt+telescope are both home, retract arm to 0.
  if (stow_arm_active && !stow_arm_arm_commanded) {
    bool belt_retracted = (digitalRead(belt_retract_limit_switch_pin) == HIGH) || belt_state == "close";
    bool telescope_retracted = telescope_ignore_hall ? (telescope_state == "close") : ((telescope_position <= 0) || telescope_state == "close");

    if (belt_retracted && telescope_retracted) {
      telescope_position = 0;
      retract_arm();
      stow_arm_arm_commanded = true;
    }
  }

  if (stow_arm_active && stow_arm_arm_commanded && arm_state == "close") {
    stowed = true;
    stow_arm_active = false;
  }
}


//Arm Actuator...............................................................................
// A servo: one write is the whole command. The angle is the position, the servo
// holds it, and the timeouts in heartbeat() only mark when it has arrived.
void extend_arm() {
  arm.write(arm_extend_value);
  arm_state = "extend";
  arm_time_stamp = millis();
}

void retract_arm() {
  arm.write(arm_retract_value);
  arm_state = "retract";
  arm_time_stamp = millis();
}

void delivery_arm() {
  arm.write(arm_delivery_value);
  arm_state = "retract";
  arm_time_stamp = millis();
}

void open_arm() {
  arm_state = "open";
  if (auto_delivery) {
    retract_belt();
  }
}

void close_arm() {
  arm_state = "close";
  if (auto_delivery) {

    extend_arm();
    retract_telescope();
  }
}

//Telescope Actuator...............................................................................
void extend_telescope() {
  telescope_stall = false;
  telescope_has_moved = false;
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(telescope_pin_rpwm, telescope_extend_value);
  analogWrite(telescope_pin_lpwm, 0);
  telescope_state = "extend";
  telescope_time_stamp = millis();
}

void retract_telescope() {
  // If already at home, don't start the motor — position-based stop would
  // never fire (retract_start_pos <= 10 guard) and motor would run until timeout.
  if (!telescope_ignore_hall && telescope_position <= 0) {
    telescope_position = 0;
    close_telescope();
    return;
  }
  telescope_stall = false;
  telescope_retract_start_pos = telescope_position;
  telescope_has_moved = false;
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(telescope_pin_lpwm, telescope_retract_value);
  analogWrite(telescope_pin_rpwm, 0);
  telescope_state = "retract";
  telescope_time_stamp = millis();
}

// The enable drops with the PWM now. It used to be shared with the arm motor, so
// it could only fall when neither was driving; the servo arm doesn't use it, and
// the telescope is free to release its own driver.
void stop_telescope_motor() {
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);
  digitalWrite(telescope_enable_pin, LOW);
}

void open_telescope() {
  telescope_state = "open";
  stop_telescope_motor();
}

void close_telescope() {
  // Clamp position to 0 — prevents negative drift that breaks future retract stops.
  if (telescope_position < 0) telescope_position = 0;
  telescope_state = "close";
  stop_telescope_motor();
}


//Belt Actuator..................................................................................
void extend_belt() {
  move_belt(true);
  belt_state = "extend";
  belt_time_stamp = millis();
  if (auto_delivery) {
    extend_telescope();
  }
}

void retract_belt() {
  move_belt(false);
  belt_state = "retract";
  belt_time_stamp = millis();
  if (auto_delivery) {
    retract_telescope();
  }
}

void open_belt() {
  belt_state = "open";
  stop_belt_motor();
  if (auto_delivery) {
    delivery_arm();
    extend_telescope();
  }
}

void close_belt() {
  belt_state = "close";
  stop_belt_motor();
  if (auto_delivery) {
    auto_delivery = false;
  }
}


//Stop Belt....................................................................
// The belt's stop_*_motor(), same shape as the arm's and the telescope's — with
// one difference that matters: stopping the belt does NOT release it. The driver
// stays energised (belt_hold_position) so the carriage is held where it stopped.
//
// NOT actuator.stop(): that only schedules a deceleration ramp — at maxSpeed
// 3000 / accel 1200 the ramp is 3750 steps, over a second of pulses. Those
// pulses are real now that the driver stays on, so the ramp would keep creeping
// the carriage after the stick was already centred. setCurrentPosition() is the
// honest stop: it zeroes the speed, the step interval and the target in one
// call, and holding torque takes it from there.
//
// HEAT/CURRENT: an energised stepper draws its full rated phase current at
// standstill and gets hot doing it. Most step drivers have an idle current
// reduction (auto half-current after ~1s, usually a DIP switch) — make sure it
// is on, and check the motor's temperature after Noah has sat powered for ten
// minutes before trusting this for a long mission.
void stop_belt_motor() {
  actuator.setCurrentPosition(actuator.currentPosition());
  digitalWrite(belt_enable_pin, belt_hold_position ? HIGH : LOW);
}


//Move Belt....................................................................
// true = extend, and positive steps ARE extend — the physical reversal lives on
// the DIR pin in setup() (setPinsInverted), not in these signs. Leave them alone.
void move_belt(bool direction) {
  digitalWrite(belt_enable_pin, HIGH);
  if (direction) {
    actuator.moveTo(actuator.currentPosition() + 100000);
  } else {
    actuator.moveTo(actuator.currentPosition() - 100000);
  }
}
