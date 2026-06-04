#!/usr/bin/env python3
"""Generate a professional full-system overview and operator manual PDF for the Noah rover.

Covers: system overview, electrical components, RC controls, mission flow, undock,
dock, object avoidance, edge detection, and LCD screen messages — written for a
first-time operator. Run:  python3 generate_system_manual_pdf.py
"""

from datetime import datetime
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    PageTemplate,
    Frame,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    HRFlowable,
    KeepTogether,
    NextPageTemplate,
)

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "noah_system_manual.pdf")

# ----------------------------------------------------------------------------
# Color palette
# ----------------------------------------------------------------------------
NAVY = colors.HexColor("#13293D")
STEEL = colors.HexColor("#1B3A4B")
SLATE = colors.HexColor("#2F4858")
ACCENT = colors.HexColor("#2C7DA0")
LIGHT = colors.HexColor("#D9E6F2")
LIGHTER = colors.HexColor("#F2F7FB")
INK = colors.HexColor("#1F2933")
RULE = colors.HexColor("#BCCCDC")
GREEN = colors.HexColor("#2E7D32")
AMBER = colors.HexColor("#B26A00")
RED = colors.HexColor("#B3261E")

BASE = getSampleStyleSheet()

S = {
    "Cover": ParagraphStyle("Cover", parent=BASE["Title"], fontName="Helvetica-Bold",
                            fontSize=34, leading=40, alignment=TA_CENTER, textColor=NAVY, spaceAfter=6),
    "CoverSub": ParagraphStyle("CoverSub", parent=BASE["BodyText"], fontName="Helvetica",
                               fontSize=14, leading=20, alignment=TA_CENTER, textColor=SLATE, spaceAfter=4),
    "CoverMeta": ParagraphStyle("CoverMeta", parent=BASE["BodyText"], fontName="Helvetica-Oblique",
                                fontSize=10, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#4A5568")),
    "H1": ParagraphStyle("H1", parent=BASE["Heading1"], fontName="Helvetica-Bold",
                         fontSize=18, leading=22, textColor=colors.white, spaceBefore=2, spaceAfter=2),
    "H2": ParagraphStyle("H2", parent=BASE["Heading2"], fontName="Helvetica-Bold",
                         fontSize=13, leading=17, textColor=STEEL, spaceBefore=12, spaceAfter=5),
    "H3": ParagraphStyle("H3", parent=BASE["Heading3"], fontName="Helvetica-Bold",
                         fontSize=11, leading=15, textColor=ACCENT, spaceBefore=8, spaceAfter=3),
    "Body": ParagraphStyle("Body", parent=BASE["BodyText"], fontName="Helvetica",
                           fontSize=10, leading=14.5, alignment=TA_JUSTIFY, textColor=INK, spaceAfter=5),
    "Bullet": ParagraphStyle("Bullet", parent=BASE["BodyText"], fontName="Helvetica",
                             fontSize=10, leading=14, leftIndent=16, bulletIndent=4,
                             textColor=INK, spaceAfter=3),
    "Lead": ParagraphStyle("Lead", parent=BASE["BodyText"], fontName="Helvetica-Oblique",
                           fontSize=10.5, leading=15, textColor=SLATE, spaceAfter=8),
    "TOC": ParagraphStyle("TOC", parent=BASE["BodyText"], fontName="Helvetica",
                          fontSize=11, leading=20, textColor=INK),
    "Small": ParagraphStyle("Small", parent=BASE["BodyText"], fontName="Helvetica-Oblique",
                            fontSize=8.5, leading=11, alignment=TA_CENTER, textColor=colors.HexColor("#4A5568")),
    "Cell": ParagraphStyle("Cell", parent=BASE["BodyText"], fontName="Helvetica",
                           fontSize=8.7, leading=11.5, textColor=INK),
    "CellB": ParagraphStyle("CellB", parent=BASE["BodyText"], fontName="Helvetica-Bold",
                            fontSize=8.7, leading=11.5, textColor=STEEL),
    "CellH": ParagraphStyle("CellH", parent=BASE["BodyText"], fontName="Helvetica-Bold",
                            fontSize=9, leading=11.5, textColor=colors.HexColor("#102A43")),
    "Note": ParagraphStyle("Note", parent=BASE["BodyText"], fontName="Helvetica",
                           fontSize=9.5, leading=13.5, textColor=INK, leftIndent=8, rightIndent=8,
                           spaceBefore=2, spaceAfter=2),
}


# ----------------------------------------------------------------------------
# Flowable helpers
# ----------------------------------------------------------------------------
def para(text, style="Body"):
    return Paragraph(text, S[style])


def bullet(text):
    return Paragraph(text, S["Bullet"], bulletText="•")


def section_banner(number, title):
    """A full-width colored section header bar."""
    t = Table([[Paragraph(f"{number}&nbsp;&nbsp;&nbsp;{title}", S["H1"])]],
              colWidths=[7.1 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), STEEL),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def callout(title, text, kind="info"):
    """Boxed note / warning / tip."""
    palette = {
        "info": (LIGHT, STEEL),
        "warn": (colors.HexColor("#FBE9E7"), RED),
        "tip": (colors.HexColor("#E6F4EA"), GREEN),
    }[kind]
    bg, bar = palette
    inner = [
        Paragraph(title, ParagraphStyle("ct", parent=S["Note"], fontName="Helvetica-Bold",
                                        textColor=bar, fontSize=9.5, spaceAfter=2)),
        Paragraph(text, S["Note"]),
    ]
    t = Table([[inner]], colWidths=[7.0 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, bar),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([Spacer(1, 4), t, Spacer(1, 4)])


def make_table(rows, col_widths, header=True, align_left_cols=None, font_size=8.7):
    """Build a styled table. rows[0] is the header when header=True."""
    align_left_cols = align_left_cols or []
    data = []
    for r_idx, row in enumerate(rows):
        cells = []
        for c_idx, val in enumerate(row):
            if isinstance(val, Paragraph):
                cells.append(val)
            else:
                if r_idx == 0 and header:
                    cells.append(Paragraph(str(val), S["CellH"]))
                elif c_idx == 0:
                    cells.append(Paragraph(str(val), S["CellB"]))
                else:
                    cells.append(Paragraph(str(val), S["Cell"]))
        data.append(cells)

    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("GRID", (0, 0), (-1, -1), 0.35, RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style += [
            ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
            ("TOPPADDING", (0, 0), (-1, 0), 5),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHTER]),
        ]
    else:
        style += [("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, LIGHTER])]
    t.setStyle(TableStyle(style))
    return t


# ----------------------------------------------------------------------------
# Page furniture (header rule + footer with page number)
# ----------------------------------------------------------------------------
def on_page(canvas, doc):
    canvas.saveState()
    width, height = letter
    # Footer
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(0.7 * inch, 0.62 * inch, width - 0.7 * inch, 0.62 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#6B7785"))
    canvas.drawString(0.7 * inch, 0.46 * inch, "Noah Rover — System Overview & Operator Manual")
    canvas.drawRightString(width - 0.7 * inch, 0.46 * inch, f"Page {doc.page}")
    canvas.restoreState()


def on_cover(canvas, doc):
    canvas.saveState()
    width, height = letter
    # top and bottom accent bands
    canvas.setFillColor(NAVY)
    canvas.rect(0, height - 1.0 * inch, width, 1.0 * inch, stroke=0, fill=1)
    canvas.setFillColor(ACCENT)
    canvas.rect(0, height - 1.12 * inch, width, 0.12 * inch, stroke=0, fill=1)
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, width, 0.55 * inch, stroke=0, fill=1)
    canvas.restoreState()


# ----------------------------------------------------------------------------
# Document assembly
# ----------------------------------------------------------------------------
def build():
    doc = BaseDocTemplate(
        OUT_PATH,
        pagesize=letter,
        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        title="Noah Rover — System Overview & Operator Manual",
        author="Dry Water Corp",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id="main")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=on_cover),
        PageTemplate(id="body", frames=[frame], onPage=on_page),
    ])

    story = []

    # ---------------- COVER ----------------
    story.append(Spacer(1, 1.7 * inch))
    story.append(para("NOAH", "Cover"))
    story.append(para("Autonomous Delivery Rover", "CoverSub"))
    story.append(Spacer(1, 0.1 * inch))
    story.append(HRFlowable(width="40%", thickness=1.2, color=ACCENT, spaceBefore=6, spaceAfter=14))
    story.append(para("System Overview &amp; Operator Manual", "CoverSub"))
    story.append(Spacer(1, 0.25 * inch))
    story.append(para(
        "A first-time operator's guide to the rover's hardware, radio controls, "
        "autonomous mission, docking and undocking, obstacle avoidance, sidewalk "
        "edge guidance, and on-board status displays.", "Lead"))
    story.append(Spacer(1, 1.6 * inch))
    story.append(para(f"Generated {datetime.now().strftime('%B %d, %Y')}", "CoverMeta"))
    story.append(para("Platform: Raspberry Pi 5 (16 GB) &nbsp;•&nbsp; Node.js + Python vision", "CoverMeta"))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    # ---------------- TABLE OF CONTENTS ----------------
    story.append(para("Contents", "H2"))
    story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=10))
    toc_items = [
        ("1", "Safety First"),
        ("2", "System Overview"),
        ("3", "Electrical Components &amp; Wiring"),
        ("4", "The RC Transmitter — Channel Map"),
        ("5", "Operating Modes: RC vs. Mission"),
        ("6", "Undocking"),
        ("7", "The Autonomous Mission"),
        ("8", "Docking (Return &amp; Light-Seeking)"),
        ("9", "Object Avoidance"),
        ("10", "Sidewalk Edge Detection &amp; Guidance"),
        ("11", "LCD Screen Messages"),
        ("12", "Typical Operating Sequences"),
        ("13", "Troubleshooting"),
        ("14", "Quick Reference — Key Settings"),
    ]
    for num, title in toc_items:
        story.append(Paragraph(
            f'<font color="#2C7DA0"><b>{num}.</b></font>&nbsp;&nbsp;{title}', S["TOC"]))
    story.append(PageBreak())

    # ---------------- 1. SAFETY ----------------
    story.append(section_banner("1", "Safety First"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Noah is a self-driving vehicle that can start moving on its own. Read this section "
        "before powering the rover on for the first time.", "Lead"))
    story.append(bullet("Keep people, pets, and obstructions clear before arming, undocking, docking, or starting a mission."))
    story.append(bullet("The RC transmitter is your master override. Putting the rover into <b>RC mode</b> (channel 11 high) immediately cancels an autonomous mission and returns manual control of steering and throttle."))
    story.append(bullet("Always know where the throttle stick (CH3) is. In RC mode, centering it stops the wheels."))
    story.append(bullet("If a dock or undock sequence is doing something unexpected, move the dock switch (CH7) to its <b>center</b> position — this halts dock/undock sequences."))
    story.append(bullet("On any abnormal behavior: stop movement first, then diagnose."))
    story.append(callout("Important",
        "The rover must be armed on the Pixhawk flight controller before any radio stick or "
        "switch has an effect. The radio does not arm or disarm the vehicle — it selects modes "
        "and controls behavior once the Pixhawk is armed.", "warn"))

    # ---------------- 2. SYSTEM OVERVIEW ----------------
    story.append(PageBreak())
    story.append(section_banner("2", "System Overview"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Noah is an autonomous delivery rover built on a <b>Raspberry Pi 5 (16 GB)</b> running a "
        "Node.js application. Its job is simple to state: drive a route of GPS waypoints from its "
        "dock to a delivery point, release the package, and return home to re-dock — while avoiding "
        "obstacles and keeping itself on the sidewalk along the way."))
    story.append(para(
        "The Raspberry Pi is the brain. It talks to a <b>Pixhawk flight controller</b> over a serial "
        "link for GPS, attitude, servo output, and the RC radio. A separate <b>Python vision program</b> "
        "processes the Intel RealSense depth camera and streams results back to the main application as "
        "JSON. Motor drivers, the steering servos, the package-delivery Arduino, the LiDAR, the IMU, the "
        "dock beacon sensor, and three LCD status screens all connect to the Pi as well."))

    story.append(para("How the pieces fit together", "H3"))
    story.append(bullet("<b>Sensing:</b> a Here+ RTK base sharpens GPS to centimeters; GPS + IMU give position and heading; RPLiDAR and the RealSense camera see obstacles; the camera also finds the sidewalk edge; an IRLock sensor finds the dock's IR beacon."))
    story.append(bullet("<b>Thinking:</b> A control loop runs every <b>250&nbsp;ms</b>. Each tick it decides where to steer, how fast to drive, and whether it must stop or go around something."))
    story.append(bullet("<b>Acting:</b> Two ZLAC8015D drivers spin the four wheel motors; steering servos (driven through the Pixhawk) point the wheels; an Arduino runs the package-delivery mechanism."))
    story.append(bullet("<b>Communicating:</b> Three LCD screens show a face, a device-health panel, and a live vision panel so an operator can read rover status at a glance."))

    story.append(para("The mission at a glance", "H3"))
    story.append(para(
        "<b>Undock</b> (drive down the dock ramp) &rarr; <b>Outbound</b> (follow GPS waypoints, hold the "
        "sidewalk edge) &rarr; <b>Deliver</b> (turn around, release package) &rarr; <b>Return</b> "
        "(retrace the route) &rarr; <b>Dock</b> (align to the recorded heading and home in on the IR "
        "beacon). Obstacle avoidance and emergency stop run the entire time."))

    # ---------------- 3. ELECTRICAL ----------------
    story.append(PageBreak())
    story.append(section_banner("3", "Electrical Components & Wiring"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Every device below connects to the Raspberry Pi 5. Serial devices use UART/USB ports; the "
        "IMU, dock beacon, and LCD screens share the I²C bus. The exact ports come from "
        "<font face='Courier'>setup.json</font>."))

    story.append(para("Serial / USB devices", "H3"))
    serial_rows = [
        ["Device", "Role", "Port", "Baud", "Protocol"],
        ["Pixhawk flight controller", "GPS, attitude, RC radio in, servo out", "/dev/ttyAMA0", "57,600", "MAVLink"],
        ["RPLiDAR", "360° obstacle scanning", "/dev/ttyAMA4", "1,000,000", "ultra_simple"],
        ["RealSense camera link", "Depth camera / vision subprocess", "/dev/ttyAMA2", "115,200", "JSON"],
        ["ZLAC8015D driver 1", "Front-wheel motors (R-front, L-front)", "/dev/ttySC0", "115,200", "Modbus RTU"],
        ["ZLAC8015D driver 2", "Rear-wheel motors (R-rear, L-rear)", "/dev/ttySC1", "115,200", "Modbus RTU"],
        ["Arduino", "Package-delivery mechanism", "/dev/ttyACM0", "115,200", "JSON"],
    ]
    story.append(make_table(serial_rows,
                            [1.55 * inch, 2.15 * inch, 1.1 * inch, 0.85 * inch, 1.0 * inch]))

    story.append(Spacer(1, 8))
    story.append(para("I²C bus devices (Bus 1)", "H3"))
    i2c_rows = [
        ["Device", "Address", "Role"],
        ["BNO055 IMU", "0x28", "Heading, pitch, roll (9-DOF fusion); polled every 50 ms"],
        ["IRLock beacon sensor", "0x54", "Finds the dock's IR beacon for final docking approach"],
        ["LCD 1 — Face", "0x27", "Animated mouth: smile = healthy, frown = a device is offline"],
        ["LCD 2 — Status", "0x26", "Device health, battery voltage, satellites, heading"],
        ["LCD 3 — Vision", "0x25", "Edge detection, avoidance state, LiDAR/vision/beacon status"],
    ]
    story.append(make_table(i2c_rows, [1.7 * inch, 0.9 * inch, 4.05 * inch]))

    story.append(Spacer(1, 8))
    story.append(para("Other hardware", "H3"))
    story.append(bullet("<b>Steering servos</b> (4): driven through the Pixhawk as servo outputs 11–14 (front-left, rear-left, front-right, rear-right)."))
    story.append(bullet("<b>RPLiDAR motor enable:</b> GPIO 23 turns the LiDAR spin motor on/off."))
    story.append(bullet("<b>Delivery-type switch:</b> a GPIO input (BCM 17) selects the package-delivery style (arm vs. dump)."))
    story.append(bullet("<b>RealSense depth camera:</b> 640×480 @ ~15 fps, mounted 0.406 m above ground; processed by the Python vision program."))
    story.append(bullet("<b>Battery monitoring:</b> read from the Pixhawk; a low-battery voice alert repeats when voltage falls below <b>20 V</b>."))
    story.append(callout("Note",
        "The four steering servos are commanded through the Pixhawk, not directly from the Pi. "
        "Wheel/turning geometry (e.g. wheelbase math) is separate from the physical wheel diameter, "
        "which is set as <font face='Courier'>voice.wheel_diameter_m</font> and used to convert "
        "encoder pulses into distance traveled.", "info"))

    story.append(para("GPS positioning &amp; the Here+ RTK base (M8P)", "H3"))
    story.append(para(
        "Plain GPS is accurate to only a few meters — not enough to keep a rover centered on a "
        "sidewalk. To tighten that down to centimeters, Noah uses <b>RTK (Real-Time Kinematic)</b> "
        "positioning with a <b>Here+ RTK base station (u-blox M8P)</b>."))
    story.append(bullet("<b>How it works:</b> the Here+ base sits on a known, fixed point and plugs into a laptop. It computes GPS correction data (RTCM messages) and that correction stream is relayed to the rover's GPS receiver."))
    story.append(bullet("<b>What you get:</b> with corrections flowing, the rover's fix improves from a normal <b>3D</b> fix to an <b>RTK float</b> solution and then, once the carrier phase locks, an <b>RTK fixed</b> solution — centimeter-level position. This is what makes sidewalk edge guidance and accurate waypoint arrival possible."))
    story.append(bullet("<b>Setup tips:</b> give the base a clear view of the sky and let it settle before driving; keep the correction link to the rover alive throughout the run; the closer the rover stays to the base, the faster it holds an RTK-fixed solution."))
    story.append(callout("Watch the fix on the screen",
        "The rover's GPS fix type and precision are shown live on the bottom row of LCD 3 (the vision "
        "screen) — for example <font face='Courier'>GPS:RTKfix HDOP:0.6</font>. Before starting a "
        "mission, confirm it reads <b>RTKflt</b> or ideally <b>RTKfix</b>, not just 3D. See "
        "&sect;11 for the full breakdown.", "tip"))

    # ---------------- 4. RC CHANNEL MAP ----------------
    story.append(PageBreak())
    story.append(section_banner("4", "The RC Transmitter — Channel Map"))
    story.append(Spacer(1, 8))
    story.append(para(
        "The radio receiver feeds the Pixhawk, which passes channel values to the rover. Every channel "
        "reading must fall in a valid range (roughly 800–2200 µs); if the signal is lost or a channel "
        "reads invalid, the frame is rejected and RC-driven actions stop. Below, <b>Low</b>, "
        "<b>Center</b>, and <b>High</b> describe stick/switch position."))
    rc_rows = [
        ["Ch", "Control", "Low", "Center", "High"],
        ["CH1", "Steering", "Turn left", "Straight", "Turn right"],
        ["CH3", "Throttle", "Reverse (to −max)", "Stop", "Forward (to +max)"],
        ["CH4", "Yaw / mode", "Spin left in place", "2-wheel steering mode", "Spin right in place"],
        ["CH5", "Claw manual enable", "Auto-delivery mode", "—", "Manual claw controls on"],
        ["CH7", "Dock / Undock", "Dock (mission) / test-dock (RC)", "Neutral · stops sequences", "Undock sequence"],
        ["CH8", "Arm actuator", "Lower", "Idle", "Raise"],
        ["CH9", "Avoidance toggle", "Avoidance ON", "—", "Avoidance OFF"],
        ["CH11", "RC / Mission", "Mission start / request", "—", "RC mode (cancels mission)"],
        ["CH12", "Belt motor", "Reverse", "Stop", "Forward"],
    ]
    story.append(make_table(rc_rows,
                            [0.5 * inch, 1.5 * inch, 1.85 * inch, 1.45 * inch, 1.35 * inch]))
    story.append(Spacer(1, 6))
    story.append(para(
        "<b>Claw controls (CH5, CH8, CH12) and the telescope (CH2)</b> only respond when the claw "
        "manual-enable switch (CH5) is high. With CH5 low the rover uses automatic package delivery "
        "during a mission."))
    story.append(callout("How CH7 is armed",
        "After power-up the dock switch (CH7) must pass through its center position once before it will "
        "act. This prevents a stale switch position from triggering an undock or dock the instant the "
        "rover boots.", "info"))
    story.append(callout("Throttle is RC-mode only",
        "CH3 throttle and CH1/CH4 steering only drive the rover in RC mode. During an autonomous "
        "mission the sticks are ignored — the rover steers itself. (An active voice command can also "
        "be cancelled by simply nudging a stick.)", "tip"))

    # ---------------- 5. MODES ----------------
    story.append(PageBreak())
    story.append(section_banner("5", "Operating Modes: RC vs. Mission"))
    story.append(Spacer(1, 8))
    story.append(para(
        "The rover is always in one of two modes, selected by <b>channel 11</b>."))
    story.append(para("RC mode (CH11 high)", "H3"))
    story.append(bullet("You drive manually: CH1 steers, CH3 is throttle, CH4 spins the rover in place."))
    story.append(bullet("Raising CH11 while a mission is running <b>immediately cancels the mission</b>, stops the motors, and re-centers the wheels. This is your override."))
    story.append(para("Mission mode (CH11 low)", "H3"))
    story.append(bullet("To start a mission, raise CH11 to arm it, then lower it. The high-to-low transition is what launches the mission."))
    story.append(bullet("The 250 ms autonomous control loop begins, and the rover follows its GPS waypoints."))
    story.append(bullet("If you request a mission while the rover is still undocking, the mission is queued and starts automatically the moment undock completes."))
    story.append(bullet("At launch, a short grace window suppresses obstacle avoidance so the rover can pull cleanly off the dock before it starts reacting to nearby structures."))

    # ---------------- 6. UNDOCK ----------------
    story.append(PageBreak())
    story.append(section_banner("6", "Undocking"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Undocking drives the rover forward off its dock ramp. It is triggered by raising the dock "
        "switch (<b>CH7 high</b>) and runs as a self-contained sequence; it does not by itself start a "
        "mission.", "Lead"))
    story.append(para("What happens, step by step", "H3"))
    story.append(bullet("<b>Record start pose.</b> The rover saves its current GPS position, heading, and pitch as the dock reference."))
    story.append(bullet("<b>Drive forward.</b> All four motors creep forward at low speed."))
    story.append(bullet("<b>Detect the ramp.</b> The rover watches its pitch. A change of about 0.12 rad (~7°) from the dock reference means it is on the ramp. If no ramp is seen within ~5 seconds, it assumes flat ground and proceeds anyway."))
    story.append(bullet("<b>Roll down and level out.</b> Travel continues until pitch returns to within ~0.07 rad (~4°) of level for at least a second — the ramp is behind it. If the IR beacon is visible, the rover steers to stay centered on it while descending."))
    story.append(bullet("<b>Clear the dock.</b> It drives forward a little longer (a couple of seconds) to fully clear the structure, then stops and records its <b>undock position and heading</b>. These are reused later to return and re-dock."))
    story.append(callout("Undock then mission",
        "If you set CH11 low (mission request) during the undock, the mission auto-starts the moment "
        "undock completes — you don't need to time it perfectly.", "tip"))

    # ---------------- 7. MISSION ----------------
    story.append(PageBreak())
    story.append(section_banner("7", "The Autonomous Mission"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Once running, the mission loop ticks every <b>250 ms</b>. Each tick it reads GPS and heading, "
        "checks for obstacles, decides how to steer and how fast to go, and watches for arrival at the "
        "next waypoint."))

    story.append(para("Following GPS waypoints", "H3"))
    story.append(bullet("Waypoints are uploaded to the rover (latitude/longitude, in order). The rover computes the bearing to the current waypoint and the difference from its current heading (the <b>yaw error</b>)."))
    story.append(bullet("A waypoint is considered <b>reached</b> when the rover's GPS sits within about half a meter of it for a few consecutive ticks (so GPS jitter can't cause false arrivals). Then it advances to the next waypoint."))

    story.append(para("Two ways to steer", "H3"))
    story.append(bullet("<b>2-wheel (Ackermann) steering</b> for small heading corrections: the front wheels angle and the rover drives forward, gently curving onto the bearing. Speed automatically eases off as the yaw error grows."))
    story.append(bullet("<b>4-wheel spin-in-place</b> for big turns: when the yaw error exceeds about <b>20°</b> (<font face='Courier'>mission_yaw_start_deg</font>), the rover stops, points all four wheels, and rotates on the spot until it is roughly aligned, then resumes forward driving. Hysteresis around the threshold prevents it from flip-flopping between modes."))

    story.append(para("Delivering the package", "H3"))
    story.append(bullet("When the rover reaches the final waypoint, it turns to face back the way it came (toward the previous waypoint) so it is lined up for the return trip."))
    story.append(bullet("It then runs the delivery mechanism via the Arduino. A 10-second fallback timer guarantees the mission proceeds even if the mechanism doesn't report completion."))

    story.append(para("Returning home", "H3"))
    story.append(bullet("The rover retraces its route — preferentially replaying a breadcrumb trail of points it recorded on the way out, otherwise reversing through the waypoint list."))
    story.append(bullet("On the final approach it overrides the last waypoint with the exact <b>undock position</b> it recorded earlier, then aligns to the <b>undock heading</b> and hands off to docking."))

    story.append(para("The sidewalk-following gate", "H3"))
    story.append(para(
        "Camera-based sidewalk following starts <b>off</b> — this prevents false steering from driveways "
        "and roads near the dock. Reaching a waypoint whose route turn exceeds <b>90°</b> "
        "(<font face='Courier'>sidewalk_gate_turn_deg</font>) on the way <b>out</b> turns sidewalk "
        "following ON; passing back through that same waypoint on the <b>return</b> turns it OFF. Place "
        "one sharp (&gt;90°) waypoint at the sidewalk entrance to mark the boundary. Obstacle avoidance, "
        "emergency stop, and LiDAR run regardless."))

    # ---------------- 8. DOCKING ----------------
    story.append(PageBreak())
    story.append(section_banner("8", "Docking (Return & Light-Seeking)"))
    story.append(Spacer(1, 8))
    story.append(para(
        "After the rover returns to its undock position and aligns to the saved undock heading, it docks. "
        "Whether docking is automatic or waits for your command depends on how the dock switch (CH7) was "
        "handled during the mission.", "Lead"))

    story.append(para("Automatic vs. manual dock authorization", "H3"))
    story.append(bullet("<b>Automatic:</b> if the dock switch was left untouched (or set low to authorize docking) during the mission, the rover docks on its own as soon as it returns and aligns."))
    story.append(bullet("<b>Manual:</b> if you moved CH7 to <b>center</b> during the mission, the rover returns, aligns, and then <b>waits</b>. It will not dock until you explicitly command it by moving CH7 <b>low</b>."))

    story.append(para("Light-seeking final approach", "H3"))
    story.append(bullet("The IRLock sensor looks for the dock's IR beacon. If the beacon isn't visible, the rover spins slowly in place to search for it (giving up after about a minute if it never appears)."))
    story.append(bullet("Once the beacon is found, the rover backs toward the dock, steering to keep the beacon centered. Brief beacon dropouts are tolerated (it holds course for a couple of seconds before re-searching)."))
    story.append(bullet("It climbs the ramp — detected the same way as undocking, by watching pitch — drives forward a little at the top to seat itself, and records the final dock pose. Docking is complete."))
    story.append(bullet("If the beacon is never available, a pitch-only fallback backs the rover straight up the ramp."))
    story.append(callout("Center = stop",
        "Moving CH7 to its center position at any time stops dock and undock sequences and holds the "
        "rover. Use it if a docking approach looks wrong.", "warn"))

    # ---------------- 9. OBJECT AVOIDANCE ----------------
    story.append(PageBreak())
    story.append(section_banner("9", "Object Avoidance"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Obstacle avoidance uses the RPLiDAR and the RealSense camera together. The LiDAR's sweep is "
        "divided into zones: the two <b>front zones (11 and 12)</b> tell the rover whether the path "
        "straight ahead is blocked, while <b>zones 1–10</b> around the rover are candidate directions to "
        "turn toward. The camera, mounted lower than the LiDAR, catches short obstacles the LiDAR can "
        "miss."))

    story.append(para("When it engages", "H3"))
    story.append(bullet("Avoidance is active only during a mission, with a valid RC link, and with the avoidance toggle enabled (<b>CH9 low</b>)."))
    story.append(bullet("It triggers on a blocked front arc — front LiDAR zones turning red, or the camera's front zones flagging an object. A short confirm delay (~300 ms) filters out momentary noise so the rover doesn't swerve at flickers."))
    story.append(bullet("<b>First-leg commitment:</b> right after launch the rover ignores stale pre-start detections until it has committed to the first leg (driven roughly a meter), so the dock structure can't trigger an immediate avoidance."))

    story.append(para("How it gets around", "H3"))
    story.append(bullet("It picks the nearest clear (green) zone — biased toward the direction of the next waypoint — and turns that way. A clear zone on the right turns it right; on the left, left."))
    story.append(bullet("Once the front clears and stays clear, it creeps forward until the corridor is reliably open (about a meter of clearance), then resumes normal navigation."))
    story.append(bullet("If no clear zone exists at all, the rover stops and holds rather than guessing."))

    story.append(para("Emergency stop & blocked-path fallback", "H3"))
    story.append(bullet("A high-threat object within about <b>1 m</b> (<font face='Courier'>object_emergency_stop_m</font>) directly in the path triggers an immediate stop."))
    story.append(bullet("If the path stays blocked for <b>10 s</b> (<font face='Courier'>rs_block_timeout_ms</font>), or avoidance runs out of options (its ~30 s timeout), the rover gives up on reaching the next waypoint and performs a fallback delivery at its last confirmed position rather than sitting forever."))
    story.append(callout("Disabling avoidance",
        "Setting CH9 high turns off LiDAR-based avoidance. The camera's emergency-stop behavior and GPS "
        "navigation continue. Only disable avoidance when you have a clear reason to.", "warn"))

    # ---------------- 10. EDGE DETECTION ----------------
    story.append(PageBreak())
    story.append(section_banner("10", "Sidewalk Edge Detection & Guidance"))
    story.append(Spacer(1, 8))
    story.append(para(
        "GPS gets the rover to the right block; the camera keeps it on the sidewalk. A Python vision "
        "program processes the RealSense depth camera and streams results to the main application as "
        "JSON. Its key output for steering is the <b>sidewalk edge about two feet ahead</b> — not the "
        "whole-path centerline."))

    story.append(para("Finding the edge", "H3"))
    story.append(bullet("The vision program scans a band of the image near the lookahead distance (<font face='Courier'>edge_lookahead_m</font> ≈ 0.61 m / 2 ft) and finds the left and right sidewalk edges using a blend of cues: concrete color, depth gradient, and the signed drop-off at the curb. Each edge comes with a confidence score."))
    story.append(bullet("The rover aims to hold itself about <b>1.5 ft</b> (<font face='Courier'>edge_side_offset_m</font> ≈ 0.46 m) off the chosen edge. If both edges are visible, it uses the higher-confidence one; left-only &rarr; stay 1.5 ft to its right; right-only &rarr; stay 1.5 ft to its left."))
    story.append(bullet("The result is emitted as an angle to the desired track position (<font face='Courier'>x_angle_deg</font>), which feeds the existing 2-wheel steering layer — so edge guidance is just a steering nudge layered on top of GPS navigation."))

    story.append(para("When the edge disappears", "H3"))
    story.append(bullet("Hysteresis keeps the rover committed to one edge instead of oscillating when both are visible and confidences wobble."))
    story.append(bullet("If edge confidence drops below threshold (no edge in view), the correction <b>latches and then fades</b> over a short window, after which the rover falls back to GPS-only navigation."))
    story.append(bullet("A camera-mount sign (<font face='Courier'>correction_direction</font>) flips the correction direction if the camera is mounted such that corrections would otherwise go the wrong way."))
    story.append(callout("Edge guidance is gated",
        "Sidewalk edge steering only acts between the &gt;90° gate waypoints (see §7). On driveways, "
        "roads, and near the dock it is suppressed so the rover doesn't chase a false edge.", "info"))

    # ---------------- 11. LCD ----------------
    story.append(PageBreak())
    story.append(section_banner("11", "LCD Screen Messages"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Three 20×4 LCD screens report rover status. Screen 1 (the face) updates about twice a second; "
        "Screens 2 and 3 refresh about once a second."))

    story.append(para("LCD 1 — Face (address 0x27)", "H3"))
    story.append(bullet("<b>Smile:</b> all monitored devices are connected and healthy."))
    story.append(bullet("<b>Frown:</b> at least one major subsystem (LiDAR, Pixhawk, motor drivers, Arduino, RealSense, IMU, or IRLock) is not connected."))
    story.append(bullet("<b>Talking mouth:</b> animates while the rover is speaking (voice output)."))

    story.append(para("LCD 2 — Device Status (address 0x26)", "H3"))
    story.append(para("Shows each device as <font face='Courier'>OK</font> (connected) or <font face='Courier'>--</font> (offline), plus live telemetry:"))
    status_rows = [
        ["Field", "Meaning"],
        ["LIDAR / PIX", "RPLiDAR and Pixhawk connection status"],
        ["WAVE / ARD", "Motor drivers (both) and Arduino connection status"],
        ["RS / IMU / IRL", "RealSense, IMU connection; IRLock 1 = connected, 0 = not"],
        ["BAT", "Battery voltage, e.g. 24.5V (low-battery alert below 20 V)"],
        ["S", "Visible GPS satellites (-- if unknown)"],
        ["H", "Heading in degrees (0–359)"],
    ]
    story.append(make_table(status_rows, [1.55 * inch, 5.1 * inch]))

    story.append(Spacer(1, 8))
    story.append(para("LCD 3 — Vision, Avoidance & GPS (address 0x25)", "H3"))
    story.append(para("Rows 0–1 report the left and right sidewalk edges; row 2 reports avoidance and "
                      "sensor status; row 3 reports the GPS fix and precision."))
    vision_rows = [
        ["Field", "Meaning"],
        ["EL / ER", "Edge Left / Edge Right seen this frame: 1 = yes, 0 = no"],
        ["C", "Edge confidence (1–99), or -- when no edge"],
        ["X", "Edge lateral position from rover center (m), or ----"],
        ["Y", "Edge forward distance ahead (m), or ----"],
        ["AV", "Avoidance: CLR = clear · BLK = blocked · TMO = avoidance timed out"],
        ["L", "LiDAR front arc: G green · Y yellow · R red"],
        ["V", "RealSense front object zone: G green · Y yellow · R red"],
        ["IRL", "IRLock beacon: 1 = fresh/visible, 0 = not"],
        ["GPS", "GPS fix type (see RTK note below)"],
        ["HDOP", "Horizontal dilution of precision — lower is better; -- if unknown"],
    ]
    story.append(make_table(vision_rows, [1.1 * inch, 5.55 * inch]))
    story.append(para("Row 3 reads, for example, <font face='Courier'>GPS:RTKfix HDOP:0.6</font>. The "
                      "GPS fix type can be: <font face='Courier'>NOGPS</font>, "
                      "<font face='Courier'>NOFIX</font>, <font face='Courier'>2D</font>, "
                      "<font face='Courier'>3D</font>, <font face='Courier'>DGPS</font>, "
                      "<font face='Courier'>RTKflt</font> (RTK float), "
                      "<font face='Courier'>RTKfix</font> (RTK fixed), "
                      "<font face='Courier'>STATIC</font>, or <font face='Courier'>PPP</font>."))
    story.append(callout("Reading green/yellow/red",
        "Green means clear, yellow means something is detected at moderate range, red means an "
        "obstacle is close. If a sensor's data goes stale, its status reverts to green/clear.", "info"))

    # ---------------- 12. SEQUENCES ----------------
    story.append(PageBreak())
    story.append(section_banner("12", "Typical Operating Sequences"))
    story.append(Spacer(1, 8))

    story.append(para("A. Start a delivery mission (with undock)", "H3"))
    story.append(bullet("Confirm the area is clear and the rover is armed on the Pixhawk."))
    story.append(bullet("Cycle CH7 through center once (arms the dock switch), then set <b>CH7 high</b> to undock."))
    story.append(bullet("Set <b>CH11 low</b> during or after undock to start the mission. It auto-starts when undock finishes."))
    story.append(bullet("The rover follows its waypoints, delivers, and returns automatically."))

    story.append(para("B. Require manual permission before docking", "H3"))
    story.append(bullet("During the mission, flip <b>CH7 to center</b> once."))
    story.append(bullet("The rover returns and aligns to the dock heading, then holds and waits."))
    story.append(bullet("When you're ready, set <b>CH7 low</b> to authorize docking. The rover homes in on the beacon and docks."))

    story.append(para("C. Take over manually at any time", "H3"))
    story.append(bullet("Set <b>CH11 high</b>. The mission cancels, motors stop, wheels center."))
    story.append(bullet("Drive with CH1 (steer), CH3 (throttle), CH4 (spin in place)."))

    # ---------------- 13. TROUBLESHOOTING ----------------
    story.append(PageBreak())
    story.append(section_banner("13", "Troubleshooting"))
    story.append(Spacer(1, 8))
    tshoot_rows = [
        ["Symptom", "Likely cause / what to check"],
        ["Mission won't start",
         "Confirm the rover is armed on the Pixhawk and RC channels read valid. CH11 needs a clean high-to-low transition. If undocking, the mission is queued until undock finishes."],
        ["Rover waits near the dock and won't dock",
         "Manual dock authorization is required — you likely set CH7 to center during the mission. Set CH7 low to authorize docking."],
        ["Avoidance not reacting",
         "Make sure a mission is active and CH9 is set low (avoidance enabled). Avoidance is also held off briefly at launch and until the first-leg commitment."],
        ["Rover swerves on a driveway / chases a false edge",
         "Sidewalk following may be on outside the intended zone. Confirm a >90° gate waypoint is placed at the true sidewalk entrance."],
        ["Face screen shows a frown",
         "A device is offline. Check LCD 2 for which one reads -- and inspect that device's cable/port."],
        ["Steering corrections go the wrong way",
         "The camera-mount sign may be inverted — check correction_direction in the RealSense settings."],
        ["No GPS / satellites show --",
         "Wait for GPS lock outdoors with a clear sky view; the mission rejects zero/invalid GPS to avoid false arrivals."],
        ["GPS won't reach RTKfix (stuck at 3D)",
         "Check the Here+ base has power, a clear sky view, and that its correction link to the rover is live. Let the base settle; keep the rover nearer the base. Watch the fix on LCD 3 row 3."],
        ["Low-battery voice alert repeating",
         "Battery is below 20 V. Stop, recover the rover, and charge."],
    ]
    story.append(make_table(tshoot_rows, [2.0 * inch, 4.65 * inch]))

    # ---------------- 14. QUICK REFERENCE ----------------
    story.append(PageBreak())
    story.append(section_banner("14", "Quick Reference — Key Settings"))
    story.append(Spacer(1, 8))
    story.append(para(
        "These tunable values live in <font face='Courier'>setup.json</font>. Defaults shown; adjust "
        "with care. (Per project rule, any change to <font face='Courier'>setup.json</font> must also "
        "be mirrored in <font face='Courier'>setup_example.json</font>.)"))
    ref_rows = [
        ["Setting", "Default", "What it controls"],
        ["mission_yaw_start_deg", "20°", "Yaw error above which the rover switches to 4-wheel spin-in-place"],
        ["sidewalk_gate_turn_deg", "90°", "Route turn at a waypoint that toggles sidewalk following"],
        ["rs_block_timeout_ms", "10,000 ms", "How long a blocked path persists before fallback delivery"],
        ["object_emergency_stop_m", "1.0 m", "Distance at which a high-threat object triggers an emergency stop"],
        ["edge_lookahead_m", "0.6096 m", "How far ahead the camera reads the sidewalk edge (2 ft)"],
        ["edge_side_offset_m", "0.4572 m", "Lateral gap the rover holds off the edge (1.5 ft)"],
        ["camera_height_m", "0.406 m", "RealSense mount height above ground"],
        ["low_battery_voltage", "20 V", "Battery voltage that triggers the low-battery alert"],
        ["wheel_diameter_m", "0.2413 m", "Physical wheel diameter (9.5 in); converts encoder pulses to distance"],
        ["throttle_percentage", "25", "Base throttle scaling for motor commands"],
    ]
    story.append(make_table(ref_rows, [2.05 * inch, 1.0 * inch, 3.6 * inch]))

    story.append(Spacer(1, 20))
    story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=8))
    story.append(para("End of manual. For deeper architecture notes see CLAUDE.md and the "
                      ".claude/memory/ folder in the project repository.", "Small"))

    doc.build(story)


if __name__ == "__main__":
    build()
    print(f"Wrote {OUT_PATH}")
