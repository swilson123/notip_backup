#!/usr/bin/env python3
"""Draft patent block diagrams (FIG. 3 - FIG. 9) for application LANDX-02U,
"CARGO DELIVERY SYSTEM".

Each figure supports one or more of the highlighted passages on pages 6-9 of
the marked-up application. The application currently has only Fig. 1 and Fig. 2
(perspective views) and uses reference numerals 10, 12, 14, 16, 18 and 20, so
new figures start at FIG. 3 and new numerals continue the even series from 22.

Run:  python3 generate_patent_figures_pdf.py
"""

import os

from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas as pdfcanvas

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "LANDX-02U_draft_figures.pdf")

PAGE_W, PAGE_H = landscape(letter)      # 792 x 612
LINE, THIN, DASH = 1.0, 0.7, (3, 3)


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------
def box(c, x, y, w, h, lines, numeral=None, dashed=False, title_only=False,
        num_side="tr", num_dx=0, num_dy=0, title_right=False):
    """One block. `lines` = [(text, style)] where style is 'b' bold, 'n' normal,
    'i' small italic qualifier."""
    c.saveState()
    c.setLineWidth(LINE)
    if dashed:
        c.setDash(*DASH)
    c.rect(x, y, w, h)
    c.restoreState()

    if title_only:
        c.setFont("Helvetica-Bold", 8)
        if title_right:
            c.drawRightString(x + w - 8, y + h - 15, lines[0][0])
        else:
            c.drawString(x + 8, y + h - 15, lines[0][0])
        for i, (t, _s) in enumerate(lines[1:]):
            c.setFont("Helvetica-Oblique", 6.6)
            if title_right:
                c.drawRightString(x + w - 8, y + h - 25 - i * 8.5, t)
            else:
                c.drawString(x + 8, y + h - 25 - i * 8.5, t)
    else:
        heights = {"b": 10.0, "n": 9.4, "i": 8.4}
        total = sum(heights[s] for _, s in lines)
        cy = y + h / 2 + total / 2 - 8
        for text, style in lines:
            if style == "b":
                c.setFont("Helvetica-Bold", 7.6)
            elif style == "n":
                c.setFont("Helvetica", 7.4)
            else:
                c.setFont("Helvetica-Oblique", 6.6)
            c.drawCentredString(x + w / 2, cy, text)
            cy -= heights[style]

    if numeral is not None:
        lead(c, x, y, w, h, numeral, num_side, num_dx, num_dy)


def lead(c, x, y, w, h, numeral, side="tr", dx=0, dy=0):
    """Reference numeral on a short lead line touching the block."""
    c.setFont("Helvetica", 9)
    if side == "tr":
        x0, y0 = x + w, y + h
        x1, y1 = x0 + 13 + dx, y0 + 11 + dy
        if x1 < x0:
            c.drawRightString(x1 - 1, y1 - 3, str(numeral))
        else:
            c.drawString(x1 + 1, y1 - 3, str(numeral))
    elif side == "tl":
        x0, y0 = x, y + h
        x1, y1 = x0 - 13 + dx, y0 + 11 + dy
        c.drawRightString(x1 - 1, y1 - 3, str(numeral))
    elif side == "bl":
        x0, y0 = x, y
        x1, y1 = x0 - 13 + dx, y0 - 11 + dy
        c.drawRightString(x1 - 1, y1 - 3, str(numeral))
    elif side == "r":
        x0, y0 = x + w, y + h / 2
        x1, y1 = x0 + 15 + dx, y0 + dy
        c.drawString(x1 + 1, y1 - 3, str(numeral))
    elif side == "l":
        x0, y0 = x, y + h / 2
        x1, y1 = x0 - 15 + dx, y0 + dy
        c.drawRightString(x1 - 1, y1 - 3, str(numeral))
    else:  # br
        x0, y0 = x + w, y
        x1, y1 = x0 + 13 + dx, y0 - 11 + dy
        c.drawString(x1 + 1, y1 - 3, str(numeral))
    c.setLineWidth(THIN)
    c.line(x0, y0, x1, y1)


def path(c, pts, dashed=False, head=True, width=THIN, head_both=False):
    c.saveState()
    c.setLineWidth(width)
    if dashed:
        c.setDash(*DASH)
    p = c.beginPath()
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    c.drawPath(p)
    c.restoreState()
    if head:
        arrowhead(c, pts[-2], pts[-1])
    if head_both:
        arrowhead(c, pts[1], pts[0])


def arrowhead(c, frm, to):
    ax, ay = to
    dx, dy = to[0] - frm[0], to[1] - frm[1]
    s = 5.0
    if abs(dx) >= abs(dy):
        sgn = 1 if dx > 0 else -1
        pts = [(ax, ay), (ax - sgn * s * 1.6, ay + s * .62), (ax - sgn * s * 1.6, ay - s * .62)]
    else:
        sgn = 1 if dy > 0 else -1
        pts = [(ax, ay), (ax + s * .62, ay - sgn * s * 1.6), (ax - s * .62, ay - sgn * s * 1.6)]
    p = c.beginPath()
    p.moveTo(*pts[0]); p.lineTo(*pts[1]); p.lineTo(*pts[2]); p.close()
    c.drawPath(p, fill=1, stroke=0)


def note(c, x, y, text, size=6.4, anchor="l", italic=True):
    c.setFont("Helvetica-Oblique" if italic else "Helvetica", size)
    if anchor == "c":
        c.drawCentredString(x, y, text)
    elif anchor == "r":
        c.drawRightString(x, y, text)
    else:
        c.drawString(x, y, text)


def caption(c, n):
    c.setFont("Helvetica-Bold", 13)
    c.drawCentredString(PAGE_W / 2, 20, "FIG. %d" % n)


def wrap(c, text, font, size, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if c.stringWidth(trial, font, size) <= width:
            cur = trial
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines


# ===========================================================================
# FIG. 3 - SYSTEM ARCHITECTURE
#   Supports: "The delivery vehicle 16 may be transported in a docking bay 18
#   of the [primary] vehicle 10"; "the integrated robotic delivery vehicle 16
#   in a manned primary vehicle 10 with a human driver on board"; "The primary
#   vehicle 10 may include sensor mounting and the integration of the internal
#   delivery vehicle 16."
# ===========================================================================
def fig3(c):
    # external / off-board
    box(c, 230, 540, 210, 44,
        [("REMOTE OPERATOR INTERFACE", "b"), ("MONITOR AND INTERVENE", "i")], 36, num_side="tl")
    box(c, 490, 540, 210, 44,
        [("FLEET / DISPATCH SERVER", "b")], 38)

    # primary vehicle envelope
    box(c, 40, 100, 480, 380, [("PRIMARY VEHICLE (AUTOCYCLE CARRIER)", "b")], 10,
        title_only=True)

    # left column - vehicle systems
    box(c, 56, 390, 200, 56,
        [("VEHICLE CONTROL ELECTRONICS", "b"), ("AND AUTONOMY STACK", "b")], 26, num_side="tl")
    box(c, 56, 320, 200, 56,
        [("SENSOR MOUNTING", "b"), ("AND SENSOR ARRAY", "b")], 28, num_side="tl")
    box(c, 56, 250, 200, 56, [("TRACTION BATTERY", "b")], 24, num_side="tl")
    box(c, 56, 160, 200, 64,
        [("ONBOARD DRIVER STATION", "b"), ("MANNED EMBODIMENT -", "i"), ("OPTIONAL", "i")],
        30, num_side="tl")

    # docking bay
    box(c, 286, 120, 214, 330,
        [("DOCKING BAY", "b"), ("SECURE, ELECTRONICALLY LOCKED,", "i"), ("TAMPER-RESISTANT", "i")],
        18, dashed=True, title_only=True)
    box(c, 298, 300, 190, 104, [("DELIVERY VEHICLE (ROVER)", "b")], 16,
        title_only=True, num_side="tl", num_dy=-30)
    box(c, 316, 312, 154, 40, [("PAYLOAD / PACKAGE", "b")], 32, num_side="bl", num_dy=4)
    box(c, 298, 232, 190, 52,
        [("CHARGING INTERFACE", "b"), ("WIRED OR WIRELESS", "i")], 22, num_side="tl")
    box(c, 298, 156, 190, 52,
        [("DOCKING ALIGNMENT FEATURES", "b"), ("RAILS, MAGNETS, VISUAL MARKERS", "i")],
        34, num_side="tl")

    # ramp and ground
    box(c, 524, 162, 64, 44, [("RAMP", "b")], 20, num_side="br")
    box(c, 624, 158, 130, 52, [("CURB / GROUND", "b"), ("SURFACE", "b")], 42, num_side="tl")
    path(c, [(488, 184), (524, 184)], head_both=True)
    path(c, [(588, 184), (624, 184)], head_both=True)
    note(c, 566, 232, "INGRESS / EGRESS")

    # internal couplings
    path(c, [(256, 418), (286, 418)], head_both=True)     # electronics <-> bay
    path(c, [(256, 258), (298, 258)])                     # battery -> charging interface
    path(c, [(393, 284), (393, 300)])                     # charging interface -> rover

    # wireless links
    path(c, [(335, 540), (335, 500), (150, 500), (150, 446)], dashed=True)
    path(c, [(595, 540), (595, 470), (393, 470), (393, 450)], dashed=True)
    note(c, 350, 504, "WIRELESS COMMUNICATION LINK")
    c.setLineWidth(THIN)
    c.line(250, 500, 266, 514)
    c.setFont("Helvetica", 9)
    c.drawString(268, 511, "40")

    note(c, 624, 430, "DELIVERY VEHICLE 16 IS SHOWN")
    note(c, 624, 420, "STOWED IN DOCKING BAY 18;")
    note(c, 624, 410, "IT DEPARTS AND RETURNS VIA")
    note(c, 624, 400, "RAMP 20 (SEE FIG. 4).")

    caption(c, 3)


# ===========================================================================
# FIG. 4 - DELIVERY CYCLE / LAST 100 FEET SEQUENCE
#   Supports: "an L4 geofenced delivery vehicle 16 capable of operating from
#   the warehouse/restaurant to the curb and then to the doorstep"; "the last
#   100 feet ... and back into the primary vehicle 10 via the ramp 20".
# ===========================================================================
def fig4(c):
    W, H = 150, 60
    xs = [50, 240, 430, 620]

    # row 1 - left to right
    r1y = 430
    box(c, xs[0], r1y, W, H, [("LOAD AT ORIGIN", "b"), ("WAREHOUSE / RESTAURANT", "i")], 44, num_side="tl")
    box(c, xs[1], r1y, W, H, [("ROADWAY TRANSIT", "b"), ("PRIMARY VEHICLE 10", "i")], 46, num_side="tl")
    box(c, xs[2], r1y, W, H, [("ARRIVE AND STOP", "b"), ("AT CURB", "b")], 48, num_side="tl")
    box(c, xs[3], r1y, W, H, [("DEPLOY RAMP 20,", "b"), ("ROVER 16 EGRESSES BAY 18", "i")], 50, num_side="tl")

    # row 2 - right to left, inside the geofenced last-100-feet group
    r2y = 300
    box(c, 36, 270, 748, 110,
        [("LAST 100 FEET - L4 GEOFENCED AUTONOMOUS OPERATION", "b")], 52,
        dashed=True, title_only=True, num_side="tl")
    box(c, xs[3], r2y, W, H, [("AUTONOMOUS NAVIGATION", "b"), ("RTK GPS + LIDAR + VISION", "i"), ("(FIG. 6)", "i")], 54, num_side="bl")
    box(c, xs[2], r2y, W, H, [("ARRIVE AT", "b"), ("DELIVERY SITE / DOORSTEP", "i")], 56, num_side="bl")
    box(c, xs[1], r2y, W, H, [("POSITION AND UNLOAD", "b"), ("PACKAGE (FIG. 7)", "i")], 58, num_side="bl")
    box(c, xs[0], r2y, W, H, [("AUTHENTICATE DELIVERY", "b"), ("QR / RFID / MOBILE APP (FIG. 8)", "i")], 60, num_side="bl")

    # row 3 - left to right
    r3y = 170
    box(c, xs[0], r3y, W, H, [("RETURN NAVIGATION", "b"), ("TO PRIMARY VEHICLE 10", "i")], 62, num_side="tl")
    box(c, xs[1], r3y, W, H, [("RE-ENTER BAY 18", "b"), ("VIA RAMP 20", "i")], 64, num_side="tl")
    box(c, xs[2], r3y, W, H, [("DOCK, ALIGN AND LOCK", "b"), ("RAILS / MAGNETS / MARKERS", "i")], 66, num_side="tl")
    box(c, xs[3], r3y, W, H, [("CHARGE AND STAND BY", "b"), ("FOR NEXT ASSIGNMENT", "i")], 68, num_side="tl")

    # connectors
    for i in range(3):
        path(c, [(xs[i] + W, r1y + H / 2), (xs[i + 1], r1y + H / 2)])
        path(c, [(xs[i + 1], r2y + H / 2), (xs[i] + W, r2y + H / 2)])
        path(c, [(xs[i] + W, r3y + H / 2), (xs[i + 1], r3y + H / 2)])
    path(c, [(xs[3] + W / 2, r1y), (xs[3] + W / 2, r2y + H)])
    path(c, [(xs[0] + W / 2, r2y), (xs[0] + W / 2, r3y + H)])

    # return-to-service loop
    path(c, [(xs[3] + W / 2, r3y), (xs[3] + W / 2, 120), (28, 120), (28, 460), (50, 460)])
    note(c, 360, 128, "NEXT DELIVERY CYCLE - VEHICLE 10 MAY SUPPORT PARALLEL CYCLES (FIG. 9)")

    caption(c, 4)


# ===========================================================================
# FIG. 5 - POWERTRAIN, ELECTRONICS AND CHARGING
#   Supports: "Endurance software, electronics and hub motor production";
#   "a vehicle charger for the primary vehicle 10".
# ===========================================================================
def fig5(c):
    c1, c2, c3, c4, W = 36, 226, 416, 606, 140

    box(c, 206, 125, 560, 360, [("PRIMARY VEHICLE", "b")], 10, dashed=True, title_only=True,
        num_side="tl")

    box(c, c1, 430, W, 64, [("DC FAST-CHARGE", "b"), ("NETWORK", "b"), ("INCLUDING TESLA NETWORK", "i")], 70, num_side="tl")
    box(c, c1, 330, W, 64, [("J1772 AC", "b"), ("CHARGING SOURCE", "b"), ("HOME / DEPOT", "i")], 72, num_side="tl")

    box(c, c2, 380, W, 70, [("CHARGE PORT AND", "b"), ("ONBOARD VEHICLE CHARGER", "b")], 74, num_side="tl")
    box(c, c2, 150, W, 70, [("VEHICLE CONTROL", "b"), ("ELECTRONICS AND SOFTWARE", "b")], 26, num_side="tl")

    box(c, c3, 380, W, 70, [("TRACTION BATTERY", "b")], 24, num_side="tl")
    box(c, c3, 265, W, 70, [("POWER ELECTRONICS /", "b"), ("MOTOR CONTROLLER", "b")], 76, num_side="tl")
    box(c, c3, 150, W, 70, [("DOCKING BAY", "b"), ("CHARGING INTERFACE", "b")], 22, num_side="tl")

    box(c, c4, 380, W, 70, [("FRONT WHEELS 12 AND", "b"), ("REAR WHEEL 14", "b")], None)
    box(c, c4, 265, W, 70, [("HUB MOTOR", "b"), ("DRIVE UNITS", "b")], 78, num_side="tl")
    box(c, 598, 126, 158, 110, [("DELIVERY VEHICLE", "b")], 16, dashed=True, title_only=True, num_side="tl")
    box(c, c4, 150, W, 64, [("ROVER BATTERY", "b")], 80, num_side="bl")

    # power flow
    path(c, [(c1 + W, 462), (196, 462), (196, 424), (c2, 424)])
    path(c, [(c1 + W, 362), (196, 362), (196, 406), (c2, 406)])
    path(c, [(c2 + W, 415), (c3, 415)])
    path(c, [(c3 + W / 2, 380), (c3 + W / 2, 335)])
    path(c, [(c3 + W, 300), (c4, 300)])
    path(c, [(c4 + W / 2, 335), (c4 + W / 2, 380)])
    path(c, [(c3, 395), (400, 395), (400, 195), (c3, 195)])
    path(c, [(c3 + W, 185), (c4, 185)])

    # control
    path(c, [(c2 + W, 185), (386, 185), (386, 290), (c3, 290)], dashed=True)
    path(c, [(c2 + W / 2, 220), (c2 + W / 2, 380)], dashed=True)
    note(c, 300, 300, "CONTROL")
    note(c, 300, 291, "AND BMS")

    note(c, 404, 248, "PACK-TO-BAY POWER")

    caption(c, 5)


# ===========================================================================
# FIG. 6 - NAVIGATION AND HAZARD DETECTION
#   Supports: "Navigation may be via RTK GPS high-precision location. LiDAR and
#   vision sensors on the delivery vehicle 16 may detect obstacles, sidewalks,
#   steps, and other hazards."
# ===========================================================================
def fig6(c):
    box(c, 60, 508, 186, 44, [("GNSS SATELLITE", "b"), ("CONSTELLATION", "b")], 82, num_side="tl")
    box(c, 300, 508, 186, 44,
        [("RTK BASE STATION /", "b"), ("NETWORK CORRECTION SERVICE", "n")], 84, num_side="tl")
    box(c, 540, 508, 186, 44,
        [("REMOTE OPERATOR INTERFACE /", "n"), ("FLEET SERVER", "b")], 36)

    box(c, 30, 42, 732, 426, [("DELIVERY VEHICLE (ROVER)", "b")], 16, title_only=True,
        title_right=True)

    # sensor suite
    box(c, 46, 76, 170, 350, [("SENSOR SUITE", "b")], 86, dashed=True, title_only=True, num_side="tl")
    sx, sw = 58, 146
    for y, lines, num in [
        (352, [("RTK GNSS RECEIVER", "b"), ("CENTIMETER-LEVEL", "i"), ("POSITION FIX", "i")], 88),
        (286, [("INERTIAL / HEADING", "b"), ("MODULE", "b"), ("HEADING, PITCH, ROLL", "i")], 90),
        (220, [("LIDAR SENSOR", "b"), ("RANGE AND BEARING", "i")], 92),
        (154, [("VISION SENSOR", "b"), ("COLOR AND DEPTH IMAGE", "i")], 94),
        (88,  [("WHEEL ODOMETRY", "b")], 96),
    ]:
        box(c, sx, y, sw, 50, lines, num, num_side="tl")

    # controller
    box(c, 268, 110, 288, 336,
        [("NAVIGATION AND PERCEPTION CONTROLLER", "b")], 98, dashed=True, title_only=True)
    box(c, 280, 380, 240, 40,
        [("POSITION AND ATTITUDE", "b"), ("ESTIMATION MODULE", "b")], 100)

    box(c, 280, 248, 240, 118, [("HAZARD AND PATH PERCEPTION", "b")], 102,
        dashed=True, title_only=True)
    box(c, 288, 258, 72, 64, [("OBSTACLE", "b"), ("DETECTION", "b")], 104)
    box(c, 368, 258, 72, 64, [("SIDEWALK /", "b"), ("PATH EDGE", "b"), ("DETECTION", "b")], 106)
    box(c, 448, 258, 72, 64, [("STEP AND", "b"), ("DROP-OFF", "b"), ("DETECTION", "b")], 108)

    box(c, 280, 190, 240, 40,
        [("WAYPOINT ROUTE PLANNER", "b"), ("OUTBOUND, DELIVER, RETURN", "i")], 110)
    box(c, 280, 126, 240, 46,
        [("MOTION ARBITRATION MODULE", "b"), ("INCLUDES EMERGENCY STOP", "i")], 112)

    # vehicle control
    box(c, 596, 150, 150, 278, [("VEHICLE CONTROL", "b")], 114, dashed=True, title_only=True)
    box(c, 608, 342, 126, 56, [("MOTION CONTROLLER", "b")], 116)
    box(c, 608, 256, 126, 56, [("DRIVE MOTORS", "b")], 118)
    box(c, 608, 170, 126, 56, [("STEERING ACTUATOR", "b")], 120)

    # sensors -> controller
    path(c, [(204, 377), (240, 377), (240, 406), (280, 406)])
    path(c, [(204, 311), (248, 311), (248, 394), (280, 394)])
    path(c, [(204, 245), (240, 245), (240, 330), (280, 330)])
    path(c, [(204, 179), (232, 179), (232, 306), (280, 306)])
    path(c, [(204, 113), (256, 113), (256, 384), (280, 384)])

    # chain
    path(c, [(400, 380), (400, 366)])
    path(c, [(400, 248), (400, 230)])
    path(c, [(400, 190), (400, 172)])
    path(c, [(520, 290), (536, 290), (536, 149), (520, 149)])
    note(c, 524, 208, "EMERGENCY", size=5.8)
    note(c, 524, 200, "STOP", size=5.8)

    # controller -> vehicle control
    path(c, [(520, 160), (568, 160), (568, 370), (608, 370)])
    path(c, [(671, 342), (671, 312)])
    path(c, [(640, 256), (640, 226)])
    path(c, [(608, 284), (580, 284), (580, 96), (131, 96), (131, 88)])
    note(c, 300, 100, "WHEEL ODOMETRY FEEDBACK")

    # off-board links
    path(c, [(153, 508), (153, 446), (131, 446), (131, 402)], dashed=True)
    path(c, [(393, 508), (393, 484), (140, 484), (140, 402)], dashed=True)
    path(c, [(633, 508), (633, 492), (412, 492), (412, 420)], dashed=True)
    # to unloading
    path(c, [(671, 170), (671, 120), (600, 120)])
    note(c, 590, 116, "TO UNLOADING MECHANISM (FIG. 7)", anchor="r")

    caption(c, 6)


# ===========================================================================
# FIG. 7 - PAYLOAD HANDLING AND AUTONOMOUS UNLOADING
#   Supports: "the rover 16 may autonomously position itself and uses an
#   integrated unloading mechanism (e.g., sliding tray, robotic arm, or tilting
#   platform)".
# ===========================================================================
def fig7(c):
    box(c, 40, 90, 480, 420, [("DELIVERY VEHICLE (ROVER)", "b")], 16, title_only=True)

    box(c, 60, 370, 200, 84,
        [("PAYLOAD RETENTION AND", "b"), ("TAMPER-RESISTANT ENCLOSURE", "i")], 122,
        title_only=True, num_side="tl")
    box(c, 78, 382, 164, 34, [("PAYLOAD / PACKAGE", "b")], 32,
        num_side="tr", num_dx=-40, num_dy=-6)

    box(c, 60, 268, 200, 76,
        [("PLACEMENT POSITION", "b"), ("CONTROL MODULE", "b"), ("POSITIONS VEHICLE 16 AT SITE", "i")],
        132, num_side="tl")

    box(c, 60, 150, 200, 76,
        [("NAVIGATION AND PERCEPTION", "b"), ("CONTROLLER (FIG. 6)", "i")], 98, num_side="tl")

    box(c, 290, 130, 210, 340,
        [("UNLOADING MECHANISM", "b"), ("ALTERNATIVE EMBODIMENTS", "i")], 124,
        dashed=True, title_only=True)
    box(c, 302, 356, 186, 56, [("SLIDING TRAY", "b")], 126, num_side="tr", num_dx=-44)
    box(c, 302, 272, 186, 56, [("ROBOTIC ARM", "b")], 128, num_side="tr", num_dx=-44)
    box(c, 302, 188, 186, 56, [("TILTING PLATFORM", "b")], 130, num_side="tr", num_dx=-44)

    box(c, 596, 330, 160, 70, [("PACKAGE PLACED", "b"), ("AT DOORSTEP", "b")], 32, num_side="tl")
    box(c, 596, 190, 160, 70, [("DELIVERY SITE /", "b"), ("DOORSTEP", "b")], 56, num_side="tl")
    box(c, 596, 70, 160, 60, [("DELIVERY AUTHENTICATION", "b"), ("(FIG. 8)", "i")], 134, num_side="tl")

    path(c, [(260, 410), (276, 410), (276, 384), (302, 384)])
    path(c, [(260, 306), (275, 306), (275, 300), (302, 300)])
    path(c, [(260, 188), (275, 188), (275, 216), (302, 216)])
    path(c, [(160, 268), (160, 226)], head_both=True)
    path(c, [(500, 384), (548, 384), (548, 365), (596, 365)])
    path(c, [(500, 300), (548, 300), (548, 355), (596, 355)])
    path(c, [(500, 216), (548, 216), (548, 345), (596, 345)])
    path(c, [(676, 330), (676, 260)])
    path(c, [(676, 190), (676, 130)])
    note(c, 528, 400, "PLACEMENT")

    caption(c, 7)


# ===========================================================================
# FIG. 8 - DELIVERY AUTHENTICATION, RETURN AND REDOCKING
#   Supports: "Delivery authentication can be verified using a QR code, RFID,
#   or mobile app."; "Docking alignment may use rails, magnets, or visual
#   markers."
# ===========================================================================
def fig8(c):
    note(c, 210, 552, "DELIVERY AUTHENTICATION", size=8, italic=False, anchor="c")
    note(c, 595, 552, "RETURN, REDOCK AND RECHARGE", size=8, italic=False, anchor="c")
    c.setLineWidth(THIN)
    c.setDash(2, 4)
    c.line(410, 60, 410, 545)
    c.setDash()

    # -------- left half: authentication --------
    box(c, 60, 470, 280, 56,
        [("DELIVERY AUTHENTICATION MODULE", "b")], 134, num_side="tl")

    box(c, 40, 230, 320, 220, [("ALTERNATIVE EMBODIMENTS", "b")], None,
        dashed=True, title_only=True)
    box(c, 56, 370, 288, 48, [("QR CODE", "b"), ("SCANNED OR DISPLAYED", "i")], 136,
        num_side="tr", num_dx=-44)
    box(c, 56, 310, 288, 48, [("RFID", "b"), ("TAG AND READER", "i")], 138,
        num_side="tr", num_dx=-44)
    box(c, 56, 250, 288, 48, [("MOBILE APPLICATION", "b")], 140,
        num_side="tr", num_dx=-44)

    box(c, 120, 150, 160, 52, [("RECIPIENT", "b"), ("DEVICE", "b")], 142, num_side="tl")
    box(c, 120, 60, 160, 52,
        [("FLEET / DISPATCH SERVER", "b"), ("DELIVERY CONFIRMED, LOGGED", "i")], 38, num_side="tl")

    path(c, [(200, 470), (200, 450)])
    path(c, [(344, 394), (372, 394)], head=False)
    path(c, [(344, 334), (372, 334)], head=False)
    path(c, [(344, 274), (372, 274)], head=False)
    path(c, [(372, 394), (372, 176), (280, 176)])
    path(c, [(200, 150), (200, 112)], dashed=True)
    note(c, 206, 128, "CONFIRMATION")

    # -------- right half: return and redock --------
    rx, rw = 470, 250
    steps = [
        (470, [("RETURN NAVIGATION", "b"), ("TO PRIMARY VEHICLE 10", "i")], 62),
        (394, [("ALIGNMENT SENSOR", "b"), ("READS DOCKING FEATURES", "i")], 144),
        (318, [("DOCKING ALIGNMENT FEATURES", "b"), ("RAILS, MAGNETS, VISUAL MARKERS", "i")], 34),
        (242, [("DOCKING BAY", "b"), ("ROVER 16 SECURED", "i")], 18),
        (166, [("CHARGING INTERFACE", "b"), ("WIRED OR WIRELESS", "i")], 22),
        (90,  [("ROVER BATTERY", "b"), ("REPLENISHED", "i")], 80),
    ]
    for y, lines, num in steps:
        box(c, rx, y, rw, 56, lines, num, num_side="tl")
    for i in range(len(steps) - 1):
        y_top = steps[i][0]
        y_bot = steps[i + 1][0] + 56
        path(c, [(rx + rw / 2, y_top), (rx + rw / 2, y_bot)])
    path(c, [(340, 498), (470, 498)])
    note(c, 356, 504, "DELIVERY COMPLETE")
    path(c, [(rx, 118), (440, 118), (440, 60), (760, 60)], head=False)
    path(c, [(760, 60), (760, 498), (rx + rw, 498)])
    note(c, 600, 64, "READY FOR NEXT DELIVERY CYCLE (FIG. 9)", anchor="c")

    caption(c, 8)


# ===========================================================================
# FIG. 9 - MULTIPLE ROVERS, PARALLEL CYCLES AND SAFETY SUPERVISION
#   Supports: "The trifecta primary vehicle 10 may carry and support multiple
#   rovers 16, enabling parallel delivery and charging cycles."
# ===========================================================================
def fig9(c):
    box(c, 40, 528, 200, 54, [("FAIL-SAFE", "b"), ("RETURN-TO-CARRIER", "b")], 148, num_side="tl")
    box(c, 268, 528, 250, 54,
        [("REMOTE OPERATOR INTERFACE", "b"), ("REAL-TIME MONITORING", "i")], 36, num_side="tl")
    box(c, 552, 528, 200, 54, [("EMERGENCY STOP", "b")], 150, num_side="tl")

    # primary vehicle with three stowed rovers
    box(c, 36, 110, 300, 380, [("PRIMARY VEHICLE", "b")], 10, title_only=True, num_side="tl")
    box(c, 52, 130, 268, 340, [("DOCKING BAY", "b")], 18, dashed=True, title_only=True, num_side="tl")
    for y, tag in [(380, "16a"), (300, "16b"), (220, "16c")]:
        box(c, 68, y, 236, 56, [("DELIVERY VEHICLE (ROVER) " + tag, "b")], None)
        lead(c, 68, y, 236, 56, 16, side="tl")
        path(c, [(68, y + 14), (60, y + 14)], dashed=True, head=False)
    box(c, 68, 140, 236, 46,
        [("CHARGING INTERFACE - PARALLEL CHARGING", "b")], 22, num_side="tl")
    path(c, [(60, 394), (60, 163), (68, 163)], dashed=True)

    # geofenced operating area with parallel cycles
    box(c, 386, 110, 384, 380,
        [("GEOFENCED OPERATING AREA", "b"), ("MAPPED DELIVERY RADIUS", "i")], 146,
        dashed=True, title_only=True, num_side="tl")
    for y, tag in [(380, "16a"), (300, "16b"), (220, "16c")]:
        box(c, 400, y, 168, 56, [("DEPLOY AND DELIVER", "b"), ("ROVER " + tag, "i")], None)
        box(c, 590, y, 168, 56, [("RETURN, REDOCK", "b"), ("AND CHARGE", "b")], None)
        path(c, [(568, y + 28), (590, y + 28)])
        path(c, [(304, y + 38), (400, y + 38)])
        path(c, [(674, y), (674, y - 18), (186, y - 18), (186, y)])
    note(c, 400, 150, "EACH DELIVERY VEHICLE 16 EXECUTES AN INDEPENDENT, CONCURRENT")
    note(c, 400, 140, "DELIVERY AND CHARGING CYCLE WITHIN GEOFENCED AREA 146")

    # supervision links
    path(c, [(393, 528), (393, 500), (186, 500), (186, 490)], dashed=True)
    path(c, [(652, 528), (652, 502), (578, 502), (578, 490)], dashed=True)
    path(c, [(140, 528), (140, 506), (120, 506), (120, 490)], dashed=True)
    note(c, 200, 506, "MONITORING AND INTERVENTION LINKS")

    caption(c, 9)


# ===========================================================================
# BACK MATTER - reference numeral list, draft specification language, notes
# ===========================================================================
ELEMENTS = [
    (10, "Primary vehicle (autocycle carrier)", "existing"),
    (12, "Front wheels", "existing"),
    (14, "Rear wheel", "existing"),
    (16, "Delivery vehicle / rover", "existing"),
    (18, "Docking bay", "existing"),
    (20, "Ramp", "existing"),
    (22, "Charging interface, wired or wireless", "3, 5, 8, 9"),
    (24, "Traction battery of primary vehicle 10", "3, 5"),
    (26, "Vehicle control electronics and autonomy stack", "3, 5"),
    (28, "Sensor mounting and sensor array of vehicle 10", "3"),
    (30, "Onboard driver station (manned embodiment)", "3"),
    (32, "Payload / package", "3, 7"),
    (34, "Docking alignment features (rails, magnets, visual markers)", "3, 8"),
    (36, "Remote operator interface", "3, 6, 9"),
    (38, "Fleet / dispatch server", "3, 8"),
    (40, "Wireless communication link", "3"),
    (42, "Curb / ground surface", "3"),
    (44, "Load at origin (warehouse / restaurant)", "4"),
    (46, "Roadway transit by primary vehicle 10", "4"),
    (48, "Arrival and stop at curb", "4"),
    (50, "Ramp deployment and rover egress", "4"),
    (52, "Last 100 feet, L4 geofenced autonomous operation", "4"),
    (54, "Autonomous navigation to delivery site", "4"),
    (56, "Delivery site / doorstep", "4, 7"),
    (58, "Position and unload package", "4"),
    (60, "Delivery authentication step", "4"),
    (62, "Return navigation to primary vehicle 10", "4, 8"),
    (64, "Re-entry into docking bay 18 via ramp 20", "4"),
    (66, "Docking, alignment and locking", "4"),
    (68, "Charging and standby", "4"),
    (70, "DC fast-charge network", "5"),
    (72, "J1772 AC charging source", "5"),
    (74, "Charge port and onboard vehicle charger", "5"),
    (76, "Power electronics / motor controller", "5"),
    (78, "Hub motor drive units", "5"),
    (80, "Rover battery", "5, 8"),
    (82, "GNSS satellite constellation", "6"),
    (84, "RTK base station / network correction service", "6"),
    (86, "Sensor suite of delivery vehicle 16", "6"),
    (88, "RTK GNSS receiver", "6"),
    (90, "Inertial / heading module", "6"),
    (92, "LiDAR sensor", "6"),
    (94, "Vision sensor (color and depth)", "6"),
    (96, "Wheel odometry", "6"),
    (98, "Navigation and perception controller", "6, 7"),
    (100, "Position and attitude estimation module", "6"),
    (102, "Hazard and path perception subsystem", "6"),
    (104, "Obstacle detection module", "6"),
    (106, "Sidewalk / path edge detection module", "6"),
    (108, "Step and drop-off detection module", "6"),
    (110, "Waypoint route planner", "6"),
    (112, "Motion arbitration module, including emergency stop", "6"),
    (114, "Vehicle control of delivery vehicle 16", "6"),
    (116, "Motion controller", "6"),
    (118, "Drive motors", "6"),
    (120, "Steering actuator", "6"),
    (122, "Payload retention and tamper-resistant enclosure", "7"),
    (124, "Unloading mechanism", "7"),
    (126, "Sliding tray", "7"),
    (128, "Robotic arm", "7"),
    (130, "Tilting platform", "7"),
    (132, "Placement position control module", "7"),
    (134, "Delivery authentication module", "7, 8"),
    (136, "QR code", "8"),
    (138, "RFID tag and reader", "8"),
    (140, "Mobile application", "8"),
    (142, "Recipient device", "8"),
    (144, "Alignment sensor", "8"),
    (146, "Geofenced operating area", "9"),
    (148, "Fail-safe return-to-carrier", "9"),
    (150, "Emergency stop", "9"),
]

BLOCKS = [
    ("h1", "DRAFT FIGURES FOR LANDX-02U - WORKING SHEET FOR COUNSEL"),
    ("p", "These sheets accompany the seven draft block diagrams FIG. 3 through FIG. 9. They are "
          "a working aid and are not intended to be filed as drawings. Each figure is keyed to a "
          "passage highlighted on pages 6 through 9 of the marked-up application. The application "
          "presently discloses only Fig. 1 and Fig. 2 and uses reference numerals 10, 12, 14, 16, "
          "18 and 20, so the new figures begin at FIG. 3 and new numerals continue the even "
          "series from 22."),

    ("h2", "ADDITION TO THE BRIEF DESCRIPTION OF THE DRAWINGS (paragraphs 15-16)"),
    ("p", "Fig. 3 is a block diagram of a cargo delivery system according to one embodiment of "
          "this invention, showing a delivery vehicle stowed in a docking bay of a primary vehicle;"),
    ("p", "Fig. 4 is a flow diagram of a delivery cycle according to this invention, from an "
          "origin to a delivery site and back into the primary vehicle;"),
    ("p", "Fig. 5 is a block diagram of a powertrain, electronics and charging arrangement of the "
          "primary vehicle according to this invention;"),
    ("p", "Fig. 6 is a block diagram of a navigation and hazard detection arrangement of the "
          "delivery vehicle according to this invention;"),
    ("p", "Fig. 7 is a block diagram of a payload handling and autonomous unloading arrangement "
          "of the delivery vehicle according to this invention;"),
    ("p", "Fig. 8 is a block diagram of delivery authentication and of return and redocking of the "
          "delivery vehicle according to this invention; and"),
    ("p", "Fig. 9 is a block diagram of a plurality of delivery vehicles carried by the primary "
          "vehicle in parallel delivery and charging cycles according to this invention."),
    ("i", "Note: the word \"and\" presently ending the Fig. 1 clause moves to the end of the Fig. 8 "
          "clause, and the Fig. 2 clause takes a semicolon."),

    ("h2", "DRAFT DETAILED DESCRIPTION LANGUAGE, BY FIGURE"),

    ("h3", "FIG. 3 - System architecture"),
    ("q", "Highlighted, p. 7: \"The delivery vehicle 16 may be transported in a docking bay 18 of "
          "the delivery vehicle 10.\" / \"the integrated robotic delivery vehicle 16 in a manned "
          "primary vehicle 10 with a human driver on board\" ... p. 8: \"The primary vehicle 10 may "
          "include sensor mounting and the integration of the internal delivery vehicle 16.\""),
    ("p", "Referring to FIG. 3, primary vehicle 10 may carry delivery vehicle 16 within a docking "
          "bay 18 that may be secure, electronically locked and tamper-resistant. Delivery vehicle "
          "16 may hold a payload 32 while stowed. Docking bay 18 may include a charging interface "
          "22, which may be wired or wireless, and docking alignment features 34 such as rails, "
          "magnets or visual markers. Delivery vehicle 16 may enter and leave docking bay 18 by "
          "way of a ramp 20 extending to a curb or ground surface 42. Primary vehicle 10 may "
          "further include vehicle control electronics and an autonomy stack 26, sensor mounting "
          "and a sensor array 28, and a traction battery 24 that may supply charging interface 22. "
          "In a manned embodiment, primary vehicle 10 may include an onboard driver station 30 "
          "occupied by a human driver who may address unforeseen circumstances. A remote operator "
          "interface 36 and a fleet or dispatch server 38 may communicate with primary vehicle 10 "
          "and delivery vehicle 16 over a wireless communication link 40, permitting monitoring "
          "and intervention at any point in the delivery process."),

    ("h3", "FIG. 4 - Delivery cycle and the last 100 feet"),
    ("q", "Highlighted, pp. 6-7: \"an L4 geofenced delivery vehicle 16 capable of operating from "
          "the warehouse/restaurant to the curb and then to the doorstep.\" ... p. 8: \"the last 100 "
          "feet of the delivery from the primary vehicle 10 at the curb to the delivery site is "
          "accomplished by a small, wheeled robotic delivery vehicle 16 ... and back into the "
          "primary vehicle 10 via the ramp 20 or other arrangement.\""),
    ("p", "Referring to FIG. 4, goods may be loaded at an origin 44 such as a warehouse or "
          "restaurant, whereupon primary vehicle 10 may transit a roadway 46 and arrive and stop "
          "at a curb 48. Ramp 20 may then deploy and delivery vehicle 16 may egress docking bay "
          "18 at step 50. The remainder of the delivery, on the order of the last 100 feet, may be "
          "performed as an L4 geofenced autonomous operation 52 in which delivery vehicle 16 "
          "autonomously navigates 54 to a delivery site or doorstep 56, positions itself and "
          "unloads the package 58, and obtains delivery authentication 60. Delivery vehicle 16 may "
          "then navigate back 62 to primary vehicle 10, re-enter docking bay 18 by way of ramp 20 "
          "at step 64, dock, align and lock at step 66, and charge and stand by at step 68 for a "
          "further assignment. Because the last 100 feet are traversed by a small, wheeled robotic "
          "vehicle rather than by a vehicle operating on public roads, this portion of the "
          "delivery presents substantially fewer regulatory obstacles."),

    ("h3", "FIG. 5 - Powertrain, electronics and charging"),
    ("q", "Highlighted, p. 8: \"Endurance software, electronics and hub motor production.\" / \"a "
          "vehicle charger for the primary vehicle 10\""),
    ("p", "Referring to FIG. 5, primary vehicle 10 may include a charge port and onboard vehicle "
          "charger 74 that may receive energy from a DC fast-charge network 70, which may include "
          "the Tesla network, and from a J1772 AC charging source 72 such as a home or depot "
          "supply. Charger 74 may replenish a traction battery 24, which may supply power "
          "electronics or a motor controller 76 driving hub motor drive units 78 coupled to front "
          "wheels 12 and rear wheel 14. Vehicle control electronics and software 26, which may be "
          "derived from an existing production software, electronics and hub motor program, may "
          "govern power electronics 76 and may manage battery 24. Traction battery 24 may further "
          "supply charging interface 22 of docking bay 18, which may replenish a rover battery 80 "
          "of delivery vehicle 16, so that delivery vehicle 16 may be recharged from primary "
          "vehicle 10 between deliveries."),

    ("h3", "FIG. 6 - Navigation and hazard detection"),
    ("q", "Highlighted, p. 9: \"Navigation may be via RTK GPS high-precision location. LiDAR and "
          "vision sensors on the delivery vehicle 16 may detect obstacles, sidewalks, steps, and "
          "other hazards.\""),
    ("p", "Referring to FIG. 6, delivery vehicle 16 may carry a sensor suite 86 and a navigation "
          "and perception controller 98. Navigation may be via RTK GPS high-precision location: an "
          "RTK GNSS receiver 88 may receive signals from a GNSS satellite constellation 82 "
          "together with correction data from an RTK base station or network correction service "
          "84, whereby receiver 88 may resolve position to centimeter-level accuracy by measuring "
          "the phase of the satellite carrier wave and solving for integer ambiguity in real time. "
          "An inertial or heading module 90 and wheel odometry 96 may supplement receiver 88, and "
          "a position and attitude estimation module 100 may combine these inputs into an "
          "estimated pose of delivery vehicle 16, so that navigation may continue when the RTK fix "
          "is degraded or momentarily unavailable."),
    ("p", "A LiDAR sensor 92 and a vision sensor 94 may supply a hazard and path perception "
          "subsystem 102, in which an obstacle detection module 104 may identify obstructions in "
          "the travel corridor, a sidewalk or path edge detection module 106 may locate a lateral "
          "edge of a walking surface so that delivery vehicle 16 may be held at a desired offset "
          "from that edge, and a step and drop-off detection module 108 may identify vertical "
          "discontinuities such as curbs, steps and drop-offs. A waypoint route planner 110 may "
          "sequence an outbound route, a delivery event and a return route, and a motion "
          "arbitration module 112 may combine the route command with the output of perception "
          "subsystem 102 to produce steering and speed commands for vehicle control 114, including "
          "a motion controller 116, drive motors 118 and a steering actuator 120. Perception "
          "subsystem 102 may further assert an emergency stop directly to arbitration module 112, "
          "independently of route planner 110. A remote operator interface 36 may monitor "
          "navigation and may intervene should delivery vehicle 16 encounter an obstacle or a "
          "delivery complication."),

    ("h3", "FIG. 7 - Payload handling and autonomous unloading"),
    ("q", "Highlighted, p. 9: \"the rover 16 may autonomously position itself and uses an "
          "integrated unloading mechanism\" (e.g., sliding tray, robotic arm, or tilting platform)"),
    ("p", "Referring to FIG. 7, payload 32 may be secured within delivery vehicle 16 by a payload "
          "retention and tamper-resistant enclosure 122 during transit. At the delivery point, a "
          "placement position control module 132, responsive to navigation and perception "
          "controller 98, may autonomously position delivery vehicle 16 at delivery site 56. An "
          "integrated unloading mechanism 124 may then place payload 32 safely at the doorstep. "
          "Unloading mechanism 124 may comprise a sliding tray 126, a robotic arm 128, a tilting "
          "platform 130, or another arrangement for transferring payload 32 from enclosure 122 to "
          "the delivery site."),

    ("h3", "FIG. 8 - Delivery authentication, return and redocking"),
    ("q", "Highlighted, p. 9: \"Delivery authentication can be verified using a QR code, RFID, or "
          "mobile app.\" / \"Docking alignment may use rails, magnets, or visual markers.\""),
    ("p", "Referring to FIG. 8, a delivery authentication module 134 may verify the delivery. "
          "Verification may be by a QR code 136, by RFID 138, or by a mobile application 140, any "
          "of which may interact with a recipient device 142, and confirmation may be reported to "
          "fleet or dispatch server 38. After delivery, delivery vehicle 16 may autonomously "
          "return 62 to primary vehicle 10. An alignment sensor 144 may read docking alignment "
          "features 34, which may comprise rails, magnets or visual markers, whereby delivery "
          "vehicle 16 may be guided into docking bay 18 and secured. Docking bay 18 may include "
          "charging interface 22, which may be wired or wireless, to replenish rover battery 80, "
          "whereupon delivery vehicle 16 may stand ready for a further delivery cycle."),

    ("h3", "FIG. 9 - Multiple rovers, parallel cycles and safety supervision"),
    ("q", "Highlighted, p. 9: \"The trifecta primary vehicle 10 may carry and support multiple "
          "rovers 16, enabling parallel delivery and charging cycles.\""),
    ("p", "Referring to FIG. 9, primary vehicle 10 may carry a plurality of delivery vehicles 16, "
          "shown as rovers 16a, 16b and 16c, within docking bay 18, and charging interface 22 may "
          "charge more than one of them at a time. Each delivery vehicle 16 may execute an "
          "independent, concurrent cycle of deployment, delivery, return, redocking and charging "
          "within a geofenced operating area 146, which may be a well-defined or mapped radius "
          "about a store or restaurant, whereby parallel delivery and charging cycles may be "
          "sustained. A remote operator interface 36 may monitor navigation, unloading and "
          "delivery status in real time for each delivery vehicle 16, and an emergency stop 150 "
          "and a fail-safe return-to-carrier function 148 may act upon any of them."),

    ("h2", "NOTES AND QUESTIONS FOR COUNSEL"),
    ("b", "Page 7, paragraph 22 reads \"transported in a docking bay 18 of the delivery vehicle "
          "10.\" Element 10 is the primary vehicle throughout; this appears to be a typographical "
          "error for \"primary vehicle 10.\" FIG. 3 is drawn on the assumption it is."),
    ("b", "Page 8, paragraph 24 reads \"The delivery vehicle 16 may being manufactured with all of "
          "the software\"; likely \"may be manufactured.\""),
    ("b", "Every block is drawn functionally rather than as a specific part, so the figures should "
          "read on equivalents rather than on one bill of materials. No commercial supplier is "
          "named in any figure; the \"Endurance\" reference in the specification is rendered in "
          "FIG. 5 as generic control electronics and hub motor drive units."),
    ("b", "The emergency-stop path in FIG. 6, running from perception subsystem 102 directly to "
          "arbitration module 112 and bypassing route planner 110, is drawn deliberately to "
          "support a limitation in which hazard detection may halt the vehicle independently of "
          "the route planner."),
    ("b", "Modules 104, 106 and 108 in FIG. 6 are drawn separately so that sidewalk edge tracking "
          "and step or drop-off detection may be claimed independently of general obstacle "
          "avoidance. The specification's four hazards - obstacles, sidewalks, steps and other "
          "hazards - map onto 104, 106, 108 and 102 respectively."),
    ("b", "Blocks 88, 90 and 96 in FIG. 6 all feed estimation module 100, supporting a dependent "
          "claim to continued navigation during RTK degradation or dropout. Paragraph 7 of the "
          "background already recites the centimeter-level localization problem, so this may be "
          "worth an express sentence in the detailed description."),
    ("b", "FIG. 4 steps 44 through 68 are numbered as method steps. If a method claim is intended, "
          "consider whether the step numerals should be a separate series (e.g. 200, 202 ...) to "
          "keep apparatus and method numerals visually distinct."),
    ("b", "Alternatives are drawn as separate blocks within a dashed group (126/128/130 in FIG. 7; "
          "136/138/140 in FIG. 8) rather than as a single block with a list, so that any one may "
          "be claimed alone."),
]


def back_matter(c):
    col_x, col_w = [40, 412], 340
    top, bottom = PAGE_H - 46, 46
    st = {"col": 0, "y": top, "page": 1}

    def newcol():
        if st["col"] == 0:
            st["col"], st["y"] = 1, top
        else:
            c.showPage()
            st["col"], st["y"], st["page"] = 0, top, st["page"] + 1

    def emit(lines, font, size, lead_, indent=0, gap=4, keep=1):
        if st["y"] - keep * lead_ < bottom:
            newcol()
        for ln in lines:
            if st["y"] - lead_ < bottom:
                newcol()
            c.setFont(font, size)
            c.drawString(col_x[st["col"]] + indent, st["y"], ln)
            st["y"] -= lead_
        st["y"] -= gap

    for kind, text in BLOCKS:
        if kind == "h1":
            emit([text], "Helvetica-Bold", 10.5, 13, gap=6)
        elif kind == "h2":
            st["y"] -= 6
            emit(wrap(c, text, "Helvetica-Bold", 9, col_w), "Helvetica-Bold", 9, 11.5, gap=5, keep=3)
        elif kind == "h3":
            st["y"] -= 3
            emit(wrap(c, text, "Helvetica-Bold", 8.2, col_w), "Helvetica-Bold", 8.2, 10.5, gap=3, keep=4)
        elif kind == "q":
            emit(wrap(c, text, "Helvetica-Oblique", 7.2, col_w - 12), "Helvetica-Oblique", 7.2,
                 9, indent=12, gap=5, keep=3)
        elif kind == "i":
            emit(wrap(c, text, "Helvetica-Oblique", 7.4, col_w), "Helvetica-Oblique", 7.4, 9.4, gap=5)
        elif kind == "b":
            ls = wrap(c, text, "Helvetica", 7.6, col_w - 12)
            if st["y"] - 3 * 9.6 < bottom:
                newcol()
            c.setFont("Helvetica", 7.6)
            c.drawString(col_x[st["col"]], st["y"], "-")
            for i, ln in enumerate(ls):
                if st["y"] - 9.6 < bottom:
                    newcol()
                c.setFont("Helvetica", 7.6)
                c.drawString(col_x[st["col"]] + 12, st["y"], ln)
                st["y"] -= 9.6
            st["y"] -= 4
        else:
            emit(wrap(c, text, "Helvetica", 8, col_w), "Helvetica", 8, 10, gap=6, keep=3)

    # reference numeral list on its own sheet
    c.showPage()
    c.setFont("Helvetica-Bold", 11)
    c.drawString(40, PAGE_H - 46, "REFERENCE NUMERAL LIST")
    c.setFont("Helvetica-Oblique", 7.6)
    c.drawString(40, PAGE_H - 60,
                 "Numerals 10-20 already appear in the application; 22-150 are proposed and may be "
                 "renumbered. The right-hand column gives the figures in which each appears.")
    c.setLineWidth(0.8)
    c.line(40, PAGE_H - 68, PAGE_W - 40, PAGE_H - 68)

    rows_per_col = 24
    cx = [40, 292, 544]
    y0 = PAGE_H - 86
    for i, (num, name, figs) in enumerate(ELEMENTS):
        col = i // rows_per_col
        row = i % rows_per_col
        if col > 2:
            break
        x = cx[col]
        y = y0 - row * 20
        c.setFont("Helvetica-Bold", 8)
        c.drawString(x, y, str(num))
        c.setFont("Helvetica", 7.6)
        for j, ln in enumerate(wrap(c, name, "Helvetica", 7.6, 172)):
            c.drawString(x + 26, y - j * 8.6, ln)
        c.setFont("Helvetica-Oblique", 6.8)
        c.drawRightString(x + 232, y, "FIG. " + figs if figs != "existing" else "in app.")
    c.showPage()


def main():
    c = pdfcanvas.Canvas(OUT_PATH, pagesize=(PAGE_W, PAGE_H))
    c.setTitle("LANDX-02U - Draft Figures 3-9")
    for fn in (fig3, fig4, fig5, fig6, fig7, fig8, fig9):
        fn(c)
        c.showPage()
    back_matter(c)
    c.save()
    print("wrote", OUT_PATH)


if __name__ == "__main__":
    main()
