#include <Servo.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>

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
String arm_state = "stopped";
String telescope_state = "stopped";
String belt_state = "stopped";
bool hook_switch_state = false;
bool belt_extend_switch_state = false;
bool belt_retract_switch_state = false;

//Timeouts (failsafe only — position control is primary for telescope)......................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int telescope_extend_timeout = 15000;   // safety backup if Hall signal is lost
int telescope_retract_timeout = 15000;

int belt_extend_timeout = 25000;
int belt_retract_timeout = 25000;

//Extend and Retract values.................................................................
int arm_extend_value = 200;
int arm_retract_value = 0;

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

  Serial.begin(115200);
  arm.attach(arm_pin);

}


//Loop......................................................................................
void loop() {
  heartbeat();
  actuator.run();
}


//Serial..................................................................................
void serialEvent() {
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
    deliver_package(value);
  }
  else if (message == "belt") {
    if (value < 1100) {
      auto_delivery = false;
      if (!belt_extend_switch_state) {
        extend_belt();
      }
    } else if (value > 1800) {
      auto_delivery = false;
      if (!belt_retract_switch_state) {
        retract_belt();
      }
    } else {
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      auto_delivery = false;
    }
  }
  else if (message == "arm") {
    arm.write(value);
    auto_delivery = false;
  }
  else if (message == "telescope") {
    if (value < 90) {
      extend_telescope();
      auto_delivery = false;
    } else if (value > 110) {
      retract_telescope();
      auto_delivery = false;
    } else {
      analogWrite(telescope_pin_rpwm, 0);
      analogWrite(telescope_pin_lpwm, 0);
      digitalWrite(telescope_enable_pin, LOW);
      auto_delivery = false;
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
    auto_delivery = true;
    extend_belt();
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
  Serial.print("','hook_switch_state':'");
  Serial.print(hook_switch_state);
  Serial.print("','belt_extend_switch_state':'");
  Serial.print(belt_extend_switch_state);
  Serial.print("','belt_retract_switch_state':'");
  Serial.print(belt_retract_switch_state);
  Serial.print("','auto_delivery':'");
  Serial.print(auto_delivery);
  Serial.println("'}");
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
    if (telescope_has_moved && telescope_position >= TELESCOPE_FULL_EXTEND_PULSES) {
      open_telescope();
    } else if (telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_extend_timeout) {
      open_telescope();  // failsafe: Hall signal may have been lost
    }
  }

  //Telescope Retract — position-based stop; zero counter when home is reached
  if (telescope_state == "retract") {
    if (telescope_has_moved && telescope_position <= 0 && telescope_retract_start_pos > 10) {
      telescope_position = 0;
      close_telescope();
    } else if (telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_retract_timeout) {
      telescope_position = 0;  // assume home after failsafe timeout
      close_telescope();
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

  //Hook Limit Switch................
  if (digitalRead(hook_limit_switch_pin) == HIGH) {
    if (hook_switch_state == false && (arm_state == "close" || arm_state == "retract")) {
      delay(250);
      close_arm();
      hook_switch_state = true;
    }
  } else {
    hook_switch_state = false;
  }

  //Belt Extend Limit Switch................
  if (digitalRead(belt_extend_limit_switch_pin) == LOW) {
    if (belt_extend_switch_state == false) {
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      open_belt();
      belt_extend_switch_state = true;
    }
  } else {
    belt_extend_switch_state = false;
  }

  //Belt Retract Limit Switch................
  if (digitalRead(belt_retract_limit_switch_pin) == LOW) {
    if (belt_retract_switch_state == false) {
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      close_belt();
      belt_retract_switch_state = true;
    }
  } else {
    belt_retract_switch_state = false;
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
  telescope_has_moved = false;
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(telescope_pin_rpwm, telescope_extend_value);
  analogWrite(telescope_pin_lpwm, 0);
  telescope_state = "extend";
  telescope_time_stamp = millis();
}

void retract_telescope() {
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
