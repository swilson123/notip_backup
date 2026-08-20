#include <ArduinoJson.h>
#include <AccelStepper.h>

// Companion-computer link — the companion computer (notip.js) connects over
// USB, which is wired to the hardware UART (pins 0/1). Baud rate must match
// the companion side (notip.js).
//
// Arm and telescope are BOTH DC gearmotors on H-bridge drivers (LPWM/RPWM),
// sharing one enable pin. The arm is no longer a servo.
//
// Servo.h is deliberately NOT included any more: on the 328P it claims Timer1,
// which is the PWM source for pins 9 and 10 — and arm_rpwm is pin 10. Attaching
// any Servo would silently kill arm PWM. Do not add it back.

//Motor / Actuator Pins.....................................................................
int arm_lpwm = 11;              // retract (Timer2 PWM)
int arm_rpwm = 10;              // extend  (Timer1 PWM)
int arm_pin_hall_1 = 12;        // pulse            (HALL 1 / YELLOW wire) — pin-change interrupt
int arm_pin_hall_2 = 13;        // quadrature phase (HALL 2 / WHITE wire)  NOTE: pin 13 carries the
                                // onboard LED, which weakens INPUT_PULLUP. If the arm ever counts
                                // one direction only, this pin read stuck — move HALL 2 off 13.

int telescope_pin_rpwm = 5;     // extend  (Timer0 PWM)
int telescope_pin_lpwm = 6;     // retract (Timer0 PWM)
int telescope_enable_pin = 9;   // enables BOTH the arm and the telescope driver
int telescope_pin_hall_1 = 7;   // pulse            (HALL 1 / YELLOW wire) — pin-change interrupt
int telescope_pin_hall_2 = 8;   // quadrature phase (HALL 2 / WHITE wire)

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

volatile long arm_position = 0;         // signed pulse count; report-only until calibrated
volatile bool new_arm_hall_pulse = false;
unsigned long last_arm_hall_pulse_ms = 0;

// Pins 2 and 3 — the only INT0/INT1 pins on the 328P — now belong to the belt
// driver, so neither Hall channel can use attachInterrupt(). Both run on AVR
// pin-change interrupts instead. Same CHANGE-edge behaviour as before, so pulse
// counts keep their old scale (TELESCOPE_FULL_EXTEND_PULSES stays valid).
// PCINT0_vect = PORTB (pins 8-13) — arm HALL 1 on 12.
// PCINT2_vect = PORTD (pins 0-7)  — telescope HALL 1 on 7.
// Move a HALL 1 pin to another port and its ISR vector must move with it.
void attach_pin_change_interrupt(int pin) {
  *digitalPinToPCMSK(pin) |= bit(digitalPinToPCMSKbit(pin));
  PCIFR |= bit(digitalPinToPCICRbit(pin));   // clear a stale flag before enabling
  PCICR |= bit(digitalPinToPCICRbit(pin));
}

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

void arm_hall_isr() {
  new_arm_hall_pulse = true;
  if (digitalRead(arm_pin_hall_2) == LOW) {
    arm_position++;   // extending
  } else {
    arm_position--;   // retracting
  }
}

ISR(PCINT0_vect) { arm_hall_isr(); }
ISR(PCINT2_vect) { telescope_hall_isr(); }

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
String arm_state = "stopped";
String telescope_state = "stopped";
String belt_state = "stopped";
bool hook_switch_state = false;
bool belt_extend_switch_state = false;
bool belt_retract_switch_state = false;

//Timeouts (failsafe only for the telescope — the ONLY stop for the arm)....................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int telescope_extend_timeout = 20000;   // safety backup if Hall signal is lost
int telescope_retract_timeout = 20000;

int belt_extend_timeout = 30000;
int belt_retract_timeout = 30000;

//Extend and Retract values.................................................................
// PWM duty (0-255) now, not servo angles — the old 25 / 0 would not turn a motor.
int arm_extend_value = 200;
int arm_retract_value = 200;
int arm_delivery_value = 200;   // speed of the delivery drop; tune separately from retract

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
  pinMode(hook_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_extend_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_retract_limit_switch_pin, INPUT_PULLUP);
  pinMode(belt_enable_pin, OUTPUT);
  digitalWrite(belt_enable_pin, LOW);

  //Arm + Telescope Driver Pins (shared enable)...........
  pinMode(telescope_enable_pin, OUTPUT);
  digitalWrite(telescope_enable_pin, LOW);
  pinMode(telescope_pin_rpwm, OUTPUT);
  pinMode(telescope_pin_lpwm, OUTPUT);
  pinMode(arm_rpwm, OUTPUT);
  pinMode(arm_lpwm, OUTPUT);
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);
  analogWrite(arm_rpwm, 0);
  analogWrite(arm_lpwm, 0);

  //Hall Sensor Pins...........
  pinMode(telescope_pin_hall_1, INPUT_PULLUP);
  pinMode(telescope_pin_hall_2, INPUT_PULLUP);
  pinMode(arm_pin_hall_1, INPUT_PULLUP);
  pinMode(arm_pin_hall_2, INPUT_PULLUP);
  attach_pin_change_interrupt(telescope_pin_hall_1);
  attach_pin_change_interrupt(arm_pin_hall_1);

  Serial.begin(38400);

  // The arm is a motor now, so boot does NOT drive it — a blind power-up move
  // would run it into a hard stop for the whole timeout. Report the stowed hold
  // state the companion expects and wait for a command.
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
    if (value > 1800) {
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
      extend_belt();
    } else if (value < 1100) {
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
      retract_belt();
    } else {
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
    }
  }
  else if (message == "arm") {
    // Motor now, not a servo — the 0-200 RC value is a three-way switch, same
    // shape and same low-stick-extends convention as the telescope below.
    if (value < 90) {
      extend_arm();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
    } else if (value > 110) {
      retract_arm();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
    } else {
      arm_state = "stopped";
      stop_arm_motor();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
    }
  }
  else if (message == "telescope") {
    if (value < 90) {
      extend_telescope();
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
      stowed = false;
    } else if (value > 110) {
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
  Serial.print("','telescope_state':'");
  Serial.print(telescope_state);
  Serial.print("','telescope_position':'");
  Serial.print(telescope_position);
  Serial.print("','arm_position':'");
  Serial.print(arm_position);
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
  Serial.print("','arm_hall_age_ms':'");
  Serial.print(last_arm_hall_pulse_ms > 0 ? (long)(current_time_stamp - last_arm_hall_pulse_ms) : -1);
  Serial.println("'}");
}


//Heartbeat ........................................................................................
void heartbeat() {
  current_time_stamp = millis();

  // Latch last pulse timestamps safely in main loop (avoid millis() inside ISR)
  if (new_telescope_hall_pulse) {
    last_telescope_hall_pulse_ms = current_time_stamp;
    new_telescope_hall_pulse = false;
  }
  if (new_arm_hall_pulse) {
    last_arm_hall_pulse_ms = current_time_stamp;
    new_arm_hall_pulse = false;
  }

  //Serial....................
  if (current_time_stamp > old_time_stamp + 1000) {
    send_current_state();
    old_time_stamp = current_time_stamp;
  }

  //Arm Up — timeout is the only stop; arm Hall count is report-only until calibrated.
  if (arm_state == "extend") {
    // Reinforce the shared enable — a glitch low would stall the motor silently.
    digitalWrite(telescope_enable_pin, HIGH);

    if (arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_extend_timeout) {
      open_arm();
    }
  }

  //Arm Down.......................
  if (arm_state == "retract") {
    digitalWrite(telescope_enable_pin, HIGH);

    if (arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_retract_timeout) {
      close_arm();
    }
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
      actuator.setCurrentPosition(actuator.currentPosition());
      digitalWrite(belt_enable_pin, LOW);
      open_belt();
      belt_extend_switch_state = true;
    }
  } else {
    belt_extend_switch_state = false;
  }

  //Belt Retract Limit Switch................
  if (digitalRead(belt_retract_limit_switch_pin) == HIGH) {
    if (belt_retract_switch_state == false && belt_state == "retract") {
      actuator.setCurrentPosition(actuator.currentPosition());
      digitalWrite(belt_enable_pin, LOW);
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


//Shared Driver Enable...........................................................................
// One pin enables both H-bridges, so it may only drop when NEITHER motor is
// driving — otherwise stopping the arm would kill a moving telescope, and the
// auto-delivery sequence drives both at once. Call after setting a motor state.
void update_motor_enable() {
  bool arm_moving = (arm_state == "extend" || arm_state == "retract");
  bool telescope_moving = (telescope_state == "extend" || telescope_state == "retract");
  digitalWrite(telescope_enable_pin, (arm_moving || telescope_moving) ? HIGH : LOW);
}


//Arm Actuator...............................................................................
// rpwm = extend, lpwm = retract — same convention as the telescope. If the arm
// runs backwards, swap these two writes (or the two wires), not the pin numbers.
void extend_arm() {
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(arm_rpwm, arm_extend_value);
  analogWrite(arm_lpwm, 0);
  arm_state = "extend";
  arm_time_stamp = millis();
}

void retract_arm() {
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(arm_lpwm, arm_retract_value);
  analogWrite(arm_rpwm, 0);
  arm_state = "retract";
  arm_time_stamp = millis();
}

void delivery_arm() {
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(arm_lpwm, arm_delivery_value);
  analogWrite(arm_rpwm, 0);
  arm_state = "retract";
  arm_time_stamp = millis();
}

void stop_arm_motor() {
  analogWrite(arm_rpwm, 0);
  analogWrite(arm_lpwm, 0);
  update_motor_enable();
}

void open_arm() {
  arm_state = "open";
  stop_arm_motor();
  if (auto_delivery) {
    retract_belt();
  }
}

void close_arm() {
  arm_state = "close";
  stop_arm_motor();
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

void stop_telescope_motor() {
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);
  update_motor_enable();
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
  if (auto_delivery) {
    delivery_arm();
    extend_telescope();
    digitalWrite(belt_enable_pin, LOW);
    actuator.stop();
  }
}

void close_belt() {
  belt_state = "close";
  if (auto_delivery) {
    auto_delivery = false;
    digitalWrite(belt_enable_pin, LOW);
    actuator.stop();
  }
}


//Move Belt....................................................................
void move_belt(bool direction) {
  digitalWrite(belt_enable_pin, HIGH);
  if (direction) {
    actuator.moveTo(actuator.currentPosition() + 100000);
  } else {
    actuator.moveTo(actuator.currentPosition() - 100000);
  }
}
