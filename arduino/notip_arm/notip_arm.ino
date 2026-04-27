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
int hook_limit_switch_pin = 7; //Set this to the hook limit switch
int belt_extend_limit_switch_pin = A4; // Belt fully extended limit switch
int belt_retract_limit_switch_pin = A5; // Belt fully retracted limit switch
int belt_direction_pin = 10; // Set stepping direction
int belt_enable_pin = 8; // LOW: Driver enabled, HIGH: Driver disabled
AccelStepper actuator(AccelStepper::DRIVER, belt_pin, belt_direction_pin);

//States...................................................................................
bool auto_delivery = false;
String arm_state = "stopped";
String telescope_state = "stopped";
String belt_state = "stopped";
bool hook_switch_state = false;
bool belt_extend_switch_state = false;
bool belt_retract_switch_state = false;

//Servo Timeouts..................................................................................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int telescope_extend_timeout = 10000;
int telescope_retract_timeout = 10000;

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
String inputString = "";            // a string to hold incoming data from companion computer


//Setup......................................................................................
void setup() {

  //Belt Pins...........
  actuator.setMaxSpeed(3000);      // steps/sec
  actuator.setAcceleration(1200);  // steps/sec^2
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

  Serial.begin(115200);      //Set Baud Rate
  arm.attach(arm_pin);

}



//Loop......................................................................................
void loop() {
  //Heartbeat......................
  heartbeat();
  actuator.run();

}


//Serial..................................................................................
void serialEvent() {
  while (Serial.available()) {
    // get the new byte:
    char inChar = (char)Serial.read();

    // if the incoming character is a newline, set a flag
    // so the main loop can do something about it.
    // otherwise, add it to the inputString:
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


  // Parse JSON
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
      extend_belt();   // forward
    } else if (value > 1800) {
      auto_delivery = false;
      retract_belt();  // backward
    }
    else {
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
      //retract telescope
      digitalWrite(telescope_enable_pin, HIGH);
      analogWrite(telescope_pin_rpwm, 0);
      analogWrite(telescope_pin_lpwm, 200);
    }
    else if (value > 110) {
      //extend telescope
      digitalWrite(telescope_enable_pin, HIGH);
      analogWrite(telescope_pin_rpwm, 200);
      analogWrite(telescope_pin_lpwm, 0);
    } else {
      //stop telescope
      analogWrite(telescope_pin_rpwm, 0);
      analogWrite(telescope_pin_lpwm, 0);
      digitalWrite(telescope_enable_pin, LOW);
    }

    auto_delivery = false;
   
  }
  else {
    Serial.print("unknown message");
    Serial.println(message);
  }

}



//Start Package Delivery...........................................................................
void deliver_package(int value) {

  if (!auto_delivery) {
    //Set auto delivery to true.......
    auto_delivery = true;

    //Start auto delivery by extending belt..........
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

  //Serial....................
  if (current_time_stamp  > old_time_stamp + 1000) {
    send_current_state();
    old_time_stamp = current_time_stamp;
  }

  //Arm Up.......................
  if (arm_state == "extend" && arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_extend_timeout)
  {
    open_arm();
  }

  //Arm Down.......................
  if (arm_state == "retract" && arm_time_stamp != 0 && current_time_stamp > arm_time_stamp + arm_retract_timeout)
  {
    close_arm();
  }

  //Telescope Up.......................
  if (telescope_state == "extend" && telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_extend_timeout)
  {
    open_telescope();
  }

  //Telescope Down.......................
  if (telescope_state == "retract" && telescope_time_stamp != 0 && current_time_stamp > telescope_time_stamp + telescope_retract_timeout)
  {
    close_telescope();
  }


  //Belt Extended.......................
  if (belt_state == "extend" && belt_time_stamp != 0 && current_time_stamp > belt_time_stamp + belt_extend_timeout)
  {
    open_belt();
  }


  //Belt Retracted.......................
  if (belt_state == "retract" && belt_time_stamp != 0 && current_time_stamp > belt_time_stamp + belt_retract_timeout)
  {
    close_belt();
  }


  //Hook Limit Switch................
  if (digitalRead(hook_limit_switch_pin) == HIGH)
  {

    if (hook_switch_state == false && arm_state == "close" ||  hook_switch_state == false && arm_state == "retract") {
      //Stop and raise arm back up......
      delay(250);
      close_arm();
      hook_switch_state = true;
    }

  } else if (digitalRead(hook_limit_switch_pin) == LOW) {

    hook_switch_state = false;

  }


  //Belt Extend Limit Switch................
  if (digitalRead(belt_extend_limit_switch_pin) == HIGH)
  {

    if (belt_extend_switch_state == false && belt_state == "extend") {
      //Belt fully extended - stop immediately
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      open_belt();
      belt_extend_switch_state = true;
    }

  } else if (digitalRead(belt_extend_limit_switch_pin) == LOW) {

    belt_extend_switch_state = false;

  }


  //Belt Retract Limit Switch................
  if (digitalRead(belt_retract_limit_switch_pin) == HIGH)
  {

    if (belt_retract_switch_state == false && belt_state == "retract") {
      //Belt fully retracted - stop immediately
      digitalWrite(belt_enable_pin, LOW);
      actuator.stop();
      close_belt();
      belt_retract_switch_state = true;
    }

  } else if (digitalRead(belt_retract_limit_switch_pin) == LOW) {

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
    //move belt back
    retract_belt();
  }

}

void close_arm() {
  arm_state = "close";
  if (auto_delivery) {
    //Raise arm ........
    extend_arm();
    retract_telescope();
  }


}

//Telescope Actuator...............................................................................

void extend_telescope() {
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(telescope_pin_lpwm, telescope_extend_value);
  analogWrite(telescope_pin_rpwm, 0);
  telescope_state = "extend";
  telescope_time_stamp = millis();
}


void retract_telescope() {
  digitalWrite(telescope_enable_pin, HIGH);
  analogWrite(telescope_pin_rpwm, telescope_retract_value);
  analogWrite(telescope_pin_lpwm, 0);
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
    //Belt extended next lower the arm........
    retract_arm();

    extend_telescope();
    //stop belt
    digitalWrite(belt_enable_pin, LOW);
    actuator.stop();
  }
}

void close_belt() {
  belt_state = "close";

  if (auto_delivery) {
    //Auto delivery finished.........
    auto_delivery = false;
    //stop belt
    digitalWrite(belt_enable_pin, LOW);
    actuator.stop();
  }
}



//Move Belt....................................................................
void move_belt(bool direction) {
  digitalWrite(belt_enable_pin, HIGH);

  if (direction) {
    actuator.moveTo(actuator.currentPosition() + 100000);   // run forward until stopped
  } else {
    actuator.moveTo(actuator.currentPosition() - 100000);   // run backward until stopped
  }

}