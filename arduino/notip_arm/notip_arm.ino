#include <Servo.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>
#include <SoftwareSerial.h>

// Companion-computer / Pixhawk link.
// Moved OFF the hardware UART (pins 0/1) so USB flashing no longer collides
// with this link. RX = 12 (was pin 0), TX = 13 (was pin 1).
// NOTE: SoftwareSerial blocks interrupts while sending/receiving, which can
// delay the Hall ISR (pin 2) and AccelStepper.run() timing. 38400 is the
// reliable SoftwareSerial max here; must match the companion side (notip.js).
int pixhawk_rx_pin = 12;   // was hardware Serial RX (pin 0)
int pixhawk_tx_pin = 13;   // was hardware Serial TX (pin 1)
SoftwareSerial companion(pixhawk_rx_pin, pixhawk_tx_pin);

//Servos.................................................................................
Servo arm;
Servo belt;

int arm_pin = 4;
int belt_pin = 9;
int telescope_pin_rpwm = 11;
int telescope_pin_lpwm = 6;
int telescope_enable_pin = 3;
int telescope_pin_hall_1 = 2;   // INT0 — hardware interrupt (HALL 1 / YELLOW wire)
int telescope_pin_hall_2 = 5;   // quadrature phase   (HALL 2 / WHITE wire)  NOTE: pin 1 = Serial TX — do NOT use
int hook_limit_switch_pin = 7;
int belt_extend_limit_switch_pin = A4;
int belt_retract_limit_switch_pin = A5;
int belt_direction_pin = 10;
int belt_enable_pin = 8;
AccelStepper actuator(AccelStepper::DRIVER, belt_pin, belt_direction_pin);

//Hall Position Tracking..........................................................................
// Calibrate: extend fully, read telescope_position from heartbeat, set that value here.
#define TELESCOPE_FULL_EXTEND_PULSES 50000

volatile long telescope_position = 0;   // signed pulse count; 0 = fully retracted
volatile bool new_hall_pulse = false;
volatile bool telescope_has_moved = false;  // guards position stop from firing before first pulse
unsigned long last_hall_pulse_ms = 0;
long telescope_retract_start_pos = 0;

void hall_1_isr() {
  new_hall_pulse = true;
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
String arm_state = "stopped";
String telescope_state = "stopped";
String belt_state = "stopped";
bool hook_switch_state = false;
bool belt_extend_switch_state = false;
bool belt_retract_switch_state = false;

//Timeouts (failsafe only — position control is primary for telescope)......................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int telescope_extend_timeout = 20000;   // safety backup if Hall signal is lost
int telescope_retract_timeout = 20000;

int belt_extend_timeout = 25000;
int belt_retract_timeout = 25000;

//Extend and Retract values.................................................................
int arm_extend_value = 200;
int arm_retract_value = 25;

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

  pinMode(telescope_enable_pin, OUTPUT);
  digitalWrite(telescope_enable_pin, LOW);
  pinMode(telescope_pin_rpwm, OUTPUT);
  pinMode(telescope_pin_lpwm, OUTPUT);

  //Hall Sensor Pins...........
  pinMode(telescope_pin_hall_1, INPUT_PULLUP);
  pinMode(telescope_pin_hall_2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(telescope_pin_hall_1), hall_1_isr, CHANGE);

  companion.begin(38400);   // SoftwareSerial on 16 MHz AVR — 38400 is the reliable max
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
// serialEvent() only auto-fires for the hardware UART. The companion link is now
// on SoftwareSerial (pins 12/13), so we poll it explicitly from loop().
void read_companion() {
  while (companion.available()) {
    char inChar = (char)companion.read();
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
    if (value != arm_retract_value) {
      stowed = false;
    }
    arm.write(value);
    auto_delivery = false;
    stow_arm_active = false;
    stow_arm_arm_commanded = false;
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
      analogWrite(telescope_pin_rpwm, 0);
      analogWrite(telescope_pin_lpwm, 0);
      digitalWrite(telescope_enable_pin, LOW);
      auto_delivery = false;
      stow_arm_active = false;
      stow_arm_arm_commanded = false;
    }
  }
  else {
    companion.print("unknown message: ");
    companion.println(message);
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
  companion.print("{'belt_state':'");
  companion.print(belt_state);
  companion.print("','arm_state':'");
  companion.print(arm_state);
  companion.print("','telescope_state':'");
  companion.print(telescope_state);
  companion.print("','telescope_position':'");
  companion.print(telescope_position);
  companion.print("','hook_switch_state':'");
  companion.print(hook_switch_state);
  companion.print("','belt_extend_switch_state':'");
  companion.print(belt_extend_switch_state);
  companion.print("','belt_retract_switch_state':'");
  companion.print(belt_retract_switch_state);
  companion.print("','auto_delivery':'");
  companion.print(auto_delivery);
  companion.print("','package_dropped':'");
  companion.print(package_dropped);
  companion.print("','stow_arm_active':'");
  companion.print(stow_arm_active);
  companion.print("','stowed':'");
  companion.print(stowed);
  companion.print("','telescope_stall':'");
  companion.print(telescope_stall);
  companion.print("','telescope_hall_age_ms':'");
  companion.print(last_hall_pulse_ms > 0 ? (long)(current_time_stamp - last_hall_pulse_ms) : -1);
  companion.println("'}");
}


//Heartbeat ........................................................................................
void heartbeat() {
  current_time_stamp = millis();

  // Latch last pulse timestamp safely in main loop (avoid millis() inside ISR)
  if (new_hall_pulse) {
    last_hall_pulse_ms = current_time_stamp;
    new_hall_pulse = false;
  }

  //Serial....................
  if (current_time_stamp > old_time_stamp + 1000) {
    send_current_state();
    old_time_stamp = current_time_stamp;
  }

  //Arm Up.......................
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
    if (!telescope_ignore_hall && telescope_has_moved && last_hall_pulse_ms > 0 && (current_time_stamp - last_hall_pulse_ms) > 500) {
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
    if (!telescope_ignore_hall && telescope_has_moved && last_hall_pulse_ms > 0 && (current_time_stamp - last_hall_pulse_ms) > 500) {
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
    if (auto_delivery) {
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


//Arm Actuator...............................................................................
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

void open_telescope() {
  telescope_state = "open";
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);
  digitalWrite(telescope_enable_pin, LOW);
}

void close_telescope() {
  // Clamp position to 0 — prevents negative drift that breaks future retract stops.
  if (telescope_position < 0) telescope_position = 0;
  telescope_state = "close";
  analogWrite(telescope_pin_rpwm, 0);
  analogWrite(telescope_pin_lpwm, 0);
  digitalWrite(telescope_enable_pin, LOW);
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
    retract_arm();
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
