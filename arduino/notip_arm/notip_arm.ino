#include <Servo.h>
#include <ArduinoJson.h>
#include <AccelStepper.h>

//Servos.................................................................................
Servo arm;
Servo belt;

int arm_pin = 5;
int belt_pin = 9;
int belt_direction_pin = 10; // Set stepping direction
int belt_enable_pin = 8; // LOW: Driver enabled, HIGH: Driver disabled
AccelStepper actuator(AccelStepper::DRIVER, belt_pin, belt_direction_pin);

//States...................................................................................
bool auto_delivery = false;
String arm_state = "stopped";
String belt_state = "stopped";

//Servo Timeouts..................................................................................
int arm_extend_timeout = 5000;
int arm_retract_timeout = 5000;

int belt_extend_timeout = 11000;
int belt_retract_timeout = 11000;

//Extend and Retract values.................................................................
int arm_extend_value = 200;
int arm_retract_value = 0;


int belt_extend_value = 200;
int belt_retract_value = 20000;


//Timestamps...............................................................................
long arm_time_stamp = 0;
long belt_time_stamp = 0;
long current_time_stamp = 0;
long old_time_stamp = 0;
long move_time_stamp = 0;
long current_move_time_stamp = 0;

//Serial string................................................................................
String inputString = "";            // a string to hold incoming data from companion computer


//Setup......................................................................................
void setup() {

  //Belt Pins...........
  actuator.setMaxSpeed(1000);      // steps/sec
  actuator.setAcceleration(500);   // steps/sec^2
  actuator.setCurrentPosition(0);
  pinMode(belt_enable_pin, OUTPUT);
  digitalWrite(belt_enable_pin, LOW);

  Serial.begin(115200);      //Set Baud Rate
  arm.attach(arm_pin);
  belt.attach(belt_pin);
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
  }


}





//Belt Actuator..................................................................................
void extend_belt() {
  move_belt(true);
  belt_state = "extend";
  belt_time_stamp = millis();
}


void retract_belt() {
  move_belt(false);
  belt_state = "retract";
  belt_time_stamp = millis();
}

void open_belt() {
  belt_state = "open";

  if (auto_delivery) {
    //Belt extended next lower the arm........
    retract_arm();
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
  current_move_time_stamp = millis();
  digitalWrite(belt_enable_pin, HIGH);

  if (current_move_time_stamp  > move_time_stamp + 1000) {
    move_time_stamp = current_move_time_stamp;

    if (direction) {
      actuator.moveTo(belt_extend_value);   // move forward

    } else {
      actuator.moveTo(belt_retract_value);       // move back

    }

  }

}
