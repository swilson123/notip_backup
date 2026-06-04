#!/usr/bin/env python3
"""Generate an end-user manual PDF for Noah rover RC behaviors."""

from datetime import datetime
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak


OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "noah_manual.pdf")


def h(text):
    return Paragraph(text, STYLES["Heading2"])


def p(text):
    return Paragraph(text, STYLES["BodyText"])


def b(text):
    return Paragraph(f"• {text}", STYLES["BulletBody"])


BASE = getSampleStyleSheet()
STYLES = {
    "Title": ParagraphStyle(
        "TitleCustom",
        parent=BASE["Title"],
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=26,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#13293D"),
        spaceAfter=12,
    ),
    "Subtitle": ParagraphStyle(
        "Subtitle",
        parent=BASE["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#2F4858"),
        spaceAfter=14,
    ),
    "Heading2": ParagraphStyle(
        "Heading2Custom",
        parent=BASE["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=18,
        textColor=colors.HexColor("#1B3A4B"),
        spaceBefore=10,
        spaceAfter=6,
    ),
    "BodyText": ParagraphStyle(
        "BodyCustom",
        parent=BASE["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        alignment=TA_LEFT,
        textColor=colors.HexColor("#1F2933"),
        spaceAfter=4,
    ),
    "BulletBody": ParagraphStyle(
        "BulletBody",
        parent=BASE["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        leftIndent=14,
        textColor=colors.HexColor("#1F2933"),
        spaceAfter=2,
    ),
    "Small": ParagraphStyle(
        "Small",
        parent=BASE["BodyText"],
        fontName="Helvetica-Oblique",
        fontSize=8.5,
        leading=11,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#4A5568"),
        spaceAfter=8,
    ),
}


def add_switch_table(story):
    data = [
        ["Control", "Channel", "What It Does"],
        ["Steering", "CH1", "Manual steering in RC mode."],
        ["Throttle", "CH3", "Manual forward/reverse speed in RC mode."],
        ["Yaw / Spin", "CH4", "Spin-in-place behavior in RC mode when outside center."],
        ["Claw Manual Enable", "CH5", "Enable/disable claw manual controls."],
        ["Dock / Undock", "CH7", "High = undock sequence. Low = dock authorization during mission, test-dock in RC/manual."],
        ["Actuator", "CH8", "Claw actuator command when claw manual is enabled."],
        ["Obstacle Avoidance Toggle", "CH9", "High disables lidar avoidance, low enables it."],
        ["RC / Mission Mode", "CH11", "High = RC mode. Low = mission request/start."],
        ["Belt", "CH12", "Belt command when claw manual is enabled."],
    ]
    table = Table(data, colWidths=[1.65 * inch, 0.9 * inch, 4.55 * inch], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#D9E6F2")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#102A43")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#BCCCDC")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7FAFC")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(table)


def build_manual():
    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title="Noah Rover End-User Manual",
        author="Noah Rover Team",
    )

    story = []

    story.append(Paragraph("Noah Rover End-User Manual", STYLES["Title"]))
    story.append(Paragraph(
        "RC Controller Behaviors, Mission Flow, Obstacle Avoidance, Edge Guidance, Docking, and LCD Meanings",
        STYLES["Subtitle"],
    ))
    story.append(Paragraph(
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        STYLES["Small"],
    ))

    story.append(h("1) Safety First"))
    story.append(b("Keep people and pets clear before arming, undocking, docking, or mission start."))
    story.append(b("Use RC mode (CH11 high) as your operator override for mission and obstacle-avoidance behaviors."))
    story.append(b("If an unexpected sequence is active, use dock switch OFF to stop dock/undock sequences and hold the rover."))
    story.append(b("On any abnormal behavior, stop movement first, then troubleshoot."))

    story.append(h("2) RC Switch/Stick Map"))
    add_switch_table(story)

    story.append(Spacer(1, 0.15 * inch))
    story.append(h("3) Mission Mode Behavior (CH11)"))
    story.append(b("Mission request/start: CH11 low after a valid high-to-low switch transition."))
    story.append(b("RC mode: CH11 high disables mission mode and returns manual drive control."))
    story.append(b("If mission is requested during undock, mission start is queued until undock completes."))
    story.append(b("At mission start, avoidance state is reset and a short startup grace window is applied."))

    story.append(h("4) Undock Behavior (CH7 high)"))
    story.append(b("CH7 high starts undock sequence only. It does not directly start mission."))
    story.append(b("Undock uses pitch transitions to detect ramp travel and drives clear of dock before stopping."))
    story.append(b("If mission was requested during undock (CH11 low), mission auto-starts right after undock complete."))

    story.append(h("5) Docking Behavior on Return"))
    story.append(b("After delivery, rover returns to the recorded undock latitude/longitude and aligns to undock heading."))
    story.append(b("If dock/undock switch was NOT turned off during mission, rover proceeds to automatic light-seeking docking."))
    story.append(b("If CH7 was switched OFF during mission, rover waits for an explicit dock command (CH7 low) before docking."))
    story.append(b("When dock command is received while mission is active, docking is authorized for the return handoff."))

    story.append(h("6) Object Avoidance: What Triggers It"))
    story.append(b("Obstacle avoidance is active only when mission mode is on, RC link is valid, and avoidance toggle is enabled (CH9 low)."))
    story.append(b("Primary trigger is a blocked front arc: LiDAR front zones (11/12) red, or RealSense front vision zones red when fresh."))
    story.append(b("A short block-confirm delay is used to reduce false triggers from momentary noise."))
    story.append(b("Avoidance turns toward nearest non-front green zone, then creeps forward until corridor is stable-clear."))
    story.append(b("First-leg commitment gate: at mission start, stale pre-start detections are ignored until rover commits to the first leg."))

    story.append(h("7) Edge Detection / RealSense Guidance"))
    story.append(b("RealSense edge guidance assists steering during mission two-wheel forward segments."))
    story.append(b("Guidance favors visible sidewalk edge geometry with confidence checks and stale-data timeout."))
    story.append(b("If edge confidence drops, steering authority latches then fades back to GPS guidance."))
    story.append(b("RealSense obstacle persistence can trigger fallback behavior if path stays blocked too long."))

    story.append(PageBreak())

    story.append(h("8) LCD Screen Meanings"))
    story.append(p("Noah uses three LCD screens:"))
    story.append(b("LCD 1 (mouth): animated smile/frown. Smile means all-systems-good; frown indicates at least one major subsystem not connected."))
    story.append(b("LCD 2 (status): device connections, battery voltage, visible satellites, and heading."))
    story.append(b("LCD 3 (vision): left/right edge seen and confidence, edge offsets, avoidance state, LiDAR front state, RealSense front state, and IRLock visibility."))

    story.append(Spacer(1, 0.08 * inch))
    story.append(p("LCD 3 shorthand:"))
    story.append(b("AV: CLR = clear, BLK = currently blocked, TMO = avoidance timeout."))
    story.append(b("L: G/Y/R = LiDAR front-arc status green/yellow/red."))
    story.append(b("V: G/Y/R = RealSense front object zone status green/yellow/red."))
    story.append(b("IRL: 1/0 = IRLock light fresh/not fresh."))

    story.append(h("9) Typical End-User Sequences"))
    story.append(p("Start mission with undock:") )
    story.append(b("Arm rover."))
    story.append(b("Set CH7 high to undock."))
    story.append(b("Set CH11 low during undock or after undock to start mission."))

    story.append(p("Require manual dock permission on return:") )
    story.append(b("During mission, flip CH7 to OFF once."))
    story.append(b("Rover returns and aligns, then waits."))
    story.append(b("Flip CH7 to dock/low to authorize and begin docking."))

    story.append(h("10) Troubleshooting Quick Notes"))
    story.append(b("Mission will not start: verify RC channels are valid and CH11 has a proper high-to-low transition."))
    story.append(b("Rover waiting near dock and not docking: likely manual dock is required; set CH7 to dock/low."))
    story.append(b("Avoidance not reacting: ensure mission mode is active and CH9 is set to enable avoidance."))
    story.append(b("Unexpected early avoidance at mission start should be reduced by first-leg commitment logic; if seen, re-check GPS readiness and sensor freshness."))

    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph("End of Manual", STYLES["Small"]))

    doc.build(story)


if __name__ == "__main__":
    build_manual()
    print(f"Wrote {OUT_PATH}")
