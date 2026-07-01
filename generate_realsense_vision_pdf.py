#!/usr/bin/env python3
"""Generate a technical deep-dive PDF on the RealSense vision pipeline and the
sidewalk-edge-detection tech Noah uses to stay on the sidewalk.

Covers: hardware, the Python subprocess architecture, config flow from
setup.json, the ground-mask/perspective pipeline, the two edge detectors
(Hough line-fit and line-scan), edge assembly/smoothing/selection, object
detection, and how the steering layer consumes the result. Run:
    python3 generate_realsense_vision_pdf.py
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

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "realsense_vision_guide.pdf")

# ----------------------------------------------------------------------------
# Color palette (matches noah_system_manual.pdf)
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
                            fontSize=32, leading=38, alignment=TA_CENTER, textColor=NAVY, spaceAfter=6),
    "CoverSub": ParagraphStyle("CoverSub", parent=BASE["BodyText"], fontName="Helvetica",
                               fontSize=14, leading=20, alignment=TA_CENTER, textColor=SLATE, spaceAfter=4),
    "CoverMeta": ParagraphStyle("CoverMeta", parent=BASE["BodyText"], fontName="Helvetica-Oblique",
                                fontSize=10, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#4A5568")),
    "H1": ParagraphStyle("H1", parent=BASE["Heading1"], fontName="Helvetica-Bold",
                         fontSize=17, leading=21, textColor=colors.white, spaceBefore=2, spaceAfter=2),
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
    "Mono": ParagraphStyle("Mono", parent=BASE["BodyText"], fontName="Courier",
                           fontSize=8.7, leading=12.5, textColor=INK, leftIndent=10,
                           backColor=LIGHTER, spaceBefore=4, spaceAfter=6),
}


# ----------------------------------------------------------------------------
# Flowable helpers (identical contract to noah_system_manual.pdf's generator)
# ----------------------------------------------------------------------------
def para(text, style="Body"):
    return Paragraph(text, S[style])


def bullet(text):
    return Paragraph(text, S["Bullet"], bulletText="•")


def section_banner(number, title):
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


def make_table(rows, col_widths, header=True, font_size=8.7):
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


def code(text):
    return Paragraph(text.replace("\n", "<br/>"), S["Mono"])


# ----------------------------------------------------------------------------
# Page furniture
# ----------------------------------------------------------------------------
def on_page(canvas, doc):
    canvas.saveState()
    width, height = letter
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(0.7 * inch, 0.62 * inch, width - 0.7 * inch, 0.62 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#6B7785"))
    canvas.drawString(0.7 * inch, 0.46 * inch, "Noah Rover — RealSense Vision & Sidewalk Edge Detection")
    canvas.drawRightString(width - 0.7 * inch, 0.46 * inch, f"Page {doc.page}")
    canvas.restoreState()


def on_cover(canvas, doc):
    canvas.saveState()
    width, height = letter
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
        title="Noah Rover — RealSense Vision & Sidewalk Edge Detection",
        author="Dry Water Corp",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=on_cover),
        PageTemplate(id="body", frames=[frame], onPage=on_page),
    ])

    story = []

    # ---------------- COVER ----------------
    story.append(Spacer(1, 1.7 * inch))
    story.append(para("REALSENSE VISION", "Cover"))
    story.append(para("How Noah Sees the Sidewalk", "CoverSub"))
    story.append(Spacer(1, 0.1 * inch))
    story.append(HRFlowable(width="40%", thickness=1.2, color=ACCENT, spaceBefore=6, spaceAfter=14))
    story.append(para("Technical Deep Dive: Depth Camera, Edge Detection &amp; Steering", "CoverSub"))
    story.append(Spacer(1, 0.25 * inch))
    story.append(para(
        "How the Intel RealSense depth camera, the Python vision subprocess, and the two "
        "independent edge detectors (Hough line-fit and line-scan) turn a raw depth+color "
        "frame into the single steering angle that keeps Noah on the sidewalk.", "Lead"))
    story.append(Spacer(1, 1.6 * inch))
    story.append(para(f"Generated {datetime.now().strftime('%B %d, %Y')}", "CoverMeta"))
    story.append(para("lib/realsense/realsense_vision.py &nbsp;•&nbsp; Raspberry Pi 5 (16 GB)", "CoverMeta"))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    # ---------------- TOC ----------------
    story.append(para("Contents", "H2"))
    story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=10))
    toc_items = [
        ("1", "Hardware &amp; Why a Separate Process"),
        ("2", "Data Flow: setup.json to Steering"),
        ("3", "Per-Frame Pipeline Overview"),
        ("4", "Building the Walkable Ground Mask"),
        ("5", "The Ground-Plane Filter &amp; Perspective Check"),
        ("6", "Edge Detector #1 — Hough Line-Fit (current default)"),
        ("7", "Edge Detector #2 — Line-Scan (independent bands)"),
        ("8", "Shared Edge Assembly: Smoothing, Caching, Selection"),
        ("9", "Object Detection &amp; Threat Zones"),
        ("10", "From Camera to Wheels: the Steering Consumer"),
        ("11", "Tunable Parameters Reference"),
    ]
    for num, title in toc_items:
        story.append(Paragraph(f'<font color="#2C7DA0"><b>{num}.</b></font>&nbsp;&nbsp;{title}', S["TOC"]))
    story.append(PageBreak())

    # ---------------- 1. HARDWARE ----------------
    story.append(section_banner("1", "Hardware & Why a Separate Process"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Noah uses an <b>Intel RealSense depth camera</b> (D-series) running aligned depth + color "
        "streams at 640×480, targeting ~15 fps, mounted <font face='Courier'>camera_height_m</font> "
        "(0.406 m) above the ground. The camera is deliberately treated as two synchronized frames — a "
        "depth image (millimeters per pixel) and a color image (BGR) — aligned to the same pixel grid so "
        "every color pixel has a matching real-world distance."))
    story.append(para(
        "All of the camera processing — color classification, depth math, edge fitting — happens in a "
        "<b>separate Python subprocess</b> (<font face='Courier'>lib/realsense/realsense_vision.py</font>), "
        "not in the main Node.js process. Three reasons:"))
    story.append(bullet("<b>Library boundary:</b> pyrealsense2, OpenCV, and NumPy are Python-native; there is no equivalent first-class Node binding for this camera's SDK."))
    story.append(bullet("<b>Fault isolation:</b> if the camera hangs, the driver crashes, or OpenCV throws, the vision subprocess dies and restarts on its own — it cannot take down mission control, steering, or the LCDs with it."))
    story.append(bullet("<b>CPU budgeting:</b> vision runs at its own adaptive frame rate (see below) independent of the 250&nbsp;ms mission tick, so a slow vision frame never stalls navigation."))
    story.append(para(
        "The two processes talk over stdio: Node spawns Python with <font face='Courier'>nice -n 10</font> "
        "(lower CPU priority so it never starves the mission loop or motor control) and the subprocess writes "
        "one JSON object per line to stdout for every processed frame."))
    story.append(para("Adaptive frame rate", "H3"))
    story.append(para(
        "Before each frame the subprocess samples CPU load (<font face='Courier'>psutil.cpu_percent</font>) "
        "and throttles its own target fps: 15 fps normally, dropping to 10 fps above "
        "<font face='Courier'>cpu_high_threshold</font> (70%) and 7 fps above "
        "<font face='Courier'>cpu_critical_threshold</font> (85%). This keeps the Pi's CPU headroom for the "
        "mission loop, MAVLink I/O, and motor control even under heavy vision load."))
    story.append(callout("Camera reset on startup",
        "Every time the subprocess starts it performs a hardware reset of the RealSense device "
        "(<font face='Courier'>_reset_camera</font>) and waits for it to re-enumerate before opening the "
        "pipeline. This clears a wedged firmware state left behind by an unclean shutdown or a previous "
        "crash — a common cause of “No device connected” errors on embedded Linux.", "info"))

    # ---------------- 2. DATA FLOW ----------------
    story.append(PageBreak())
    story.append(section_banner("2", "Data Flow: setup.json to Steering"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Every tunable in this document lives in <font face='Courier'>setup.json</font> under the "
        "<font face='Courier'>realsense_vision</font> key. The path that value takes to actually reach the "
        "detector is a single, deliberate line — there is no hand-maintained subset in the middle anymore:"))
    story.append(code(
        "setup.json (realsense_vision: {...})\n"
        "  -> notip.js  white_rabbit.realsense.vision_full  = the RAW section, unfiltered\n"
        "              white_rabbit.realsense.vision       = a small curated Node-side subset\n"
        "  -> connect_to_realsense.js  start_realsense_vision()\n"
        "       vision_config = Object.assign({}, vision_full, { ...path fixups... })\n"
        "       spawn('nice', ['-n','10', python_path, script_path, JSON.stringify(vision_config)])\n"
        "  -> realsense_vision.py   config = json.loads(sys.argv[1])\n"
        "  -> self.config.get(\"any_key\", default)   <- every setup.json key is live here"
    ))
    story.append(callout("This wasn't always true",
        "Two earlier hand-maintained JS objects each forwarded only a subset of "
        "<font face='Courier'>realsense_vision</font> to the subprocess. Keys like "
        "<font face='Courier'>edge_hough_detector</font>, <font face='Courier'>edge_roi_*</font>, "
        "<font face='Courier'>edge_line_*</font>, <font face='Courier'>edge_mask_threshold</font>, and "
        "<font face='Courier'>camera_mount_pitch_deg</font> were silently dropped — tuning them in "
        "setup.json did nothing because Python never received them. "
        "<font face='Courier'>connect_to_realsense.js</font> now forwards <font face='Courier'>vision_full</font> "
        "wholesale, so any key added to setup.json's <font face='Courier'>realsense_vision</font> section takes "
        "effect the next time the vision process restarts. Do not reintroduce a subset.", "warn"))
    story.append(para("The return path", "H3"))
    story.append(para(
        "Results flow back the other way: Python emits one <font face='Courier'>path_detection</font> JSON "
        "message per processed frame &rarr; Node's stdout handler splits it on newlines &rarr; "
        "<font face='Courier'>realsense_message_handler.js</font> parses it and writes the fields onto "
        "<font face='Courier'>white_rabbit.realsense.path_detection</font> &rarr; "
        "<font face='Courier'>follow_the_yellow_brick_road.js</font> reads that struct every 250&nbsp;ms mission "
        "tick to compute a steering angle. Rover pitch and roll are streamed the opposite direction at 10&nbsp;Hz "
        "(<font face='Courier'>start_pitch_stream</font>) so the depth math in Python can correct for the rover "
        "rocking over bumps and off-camber pavement."))

    # ---------------- 3. PIPELINE OVERVIEW ----------------
    story.append(PageBreak())
    story.append(section_banner("3", "Per-Frame Pipeline Overview"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>process_frames()</font> runs once per accepted frame and does two independent "
        "jobs: <b>detect_path</b> (the sidewalk edges — this document's focus) and <b>detect_objects</b> "
        "(obstacles, §9). Both work from the same aligned depth + color pair and the same intrinsics."))
    story.append(bullet("<b>Align:</b> <font face='Courier'>rs.align(rs.stream.color)</font> maps every depth pixel onto the color pixel grid so a single (x, y) index reads both a color and a real-world distance."))
    story.append(bullet("<b>Crop the ROI:</b> only the lower part of the frame is used for path detection — rows from <font face='Courier'>edge_roi_top_frac</font> (0.40) to <font face='Courier'>edge_roi_bottom_frac</font> (0.95) of the image height. This excludes sky, distant buildings, and anything above the ground plane before any classification runs."))
    story.append(bullet("<b>Classify walkable ground</b> from color + depth (§4)."))
    story.append(bullet("<b>Filter to real ground</b> using 3-D geometry, not just appearance (§5)."))
    story.append(bullet("<b>Fit independent left/right edges</b> using one of two detectors, selected by <font face='Courier'>edge_hough_detector</font> (§6, §7)."))
    story.append(bullet("<b>Assemble the result:</b> smooth, cache, choose a side, compute the steering angle (§8)."))
    story.append(para(
        "Everything downstream of the ROI crop operates in <b>meters</b>, not pixels, using the color stream's "
        "intrinsics (<font face='Courier'>fx, fy, ppx, ppy</font>) to deproject any pixel + depth reading into a "
        "camera-frame 3-D point: <font face='Courier'>cam_X = (x_px - ppx) * depth_m / fx</font>, "
        "<font face='Courier'>cam_Y = (y_px - ppy) * depth_m / fy</font>. That 3-D point is then rotated by the "
        "rover's current roll and pitch (streamed live from Node) to recover a true horizontal forward distance "
        "and lateral offset — the same un-roll/un-pitch transform is reused in the ground mask filter, the "
        "centerline, the edge-clearance check, and object detection, so a pothole or a banked driveway can't "
        "silently corrupt one calculation while leaving another correct."))

    # ---------------- 4. GROUND MASK ----------------
    story.append(PageBreak())
    story.append(section_banner("4", "Building the Walkable Ground Mask"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>_build_simple_ground_mask()</font> turns the cropped color ROI into a binary "
        "“walkable / not-walkable” mask using color alone — depth-based ground validation happens "
        "afterward, in §5."))
    story.append(para("Step by step", "H3"))
    story.append(bullet("<b>CLAHE illumination normalization</b> (<font face='Courier'>simple_edge_clahe_enabled</font>, default on): the ROI is converted to LAB color space and contrast-limited adaptive histogram equalization is applied to the lightness channel. This flattens dappled tree-shadow patterns on concrete so a shadow edge doesn't get misread as a sidewalk boundary."))
    story.append(bullet("<b>Adaptive concrete threshold:</b> the value floor for “concrete-bright” pixels is not a fixed number — it's <font face='Courier'>max(light_min, val_min, mean_brightness × val_mean_frac)</font>, so the same detector works in both bright sun and overcast light."))
    story.append(bullet("<b>Exclusion masks</b> in HSV subtract anything that looks like grass (green hue band), mulch/bark/soil (brown-orange hue band), or near-black shadow/asphalt-crack pixels from the concrete mask."))
    story.append(bullet("<b>Cleanup:</b> median blur removes salt-and-pepper noise; morphological open then close fills small holes and removes small false-positive specks; a connected-components pass drops any surviving blob smaller than <font face='Courier'>simple_edge_component_min_area</font> pixels."))
    story.append(bullet("<b>Keep the centered blob:</b> <font face='Courier'>_select_center_component()</font> keeps only the walkable blob whose centroid is horizontally closest to the image center — the sidewalk Noah is standing on, not a driveway or patch of concrete off to one side."))
    story.append(para(
        "The output is a single 0/255 mask, plus the raw green mask (reused later to bias edge classification "
        "away from grass boundaries)."))

    # ---------------- 5. GROUND PLANE + PERSPECTIVE ----------------
    story.append(PageBreak())
    story.append(section_banner("5", "The Ground-Plane Filter & Perspective Check"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Color alone is fooled easily: a gray wall, a parked car's shadow, or a raised concrete planter can "
        "read as “walkable” by hue and brightness. Two independent geometric checks guard against this "
        "before any edge is trusted."))
    story.append(para("TRON-grid ground-plane filter", "H3"))
    story.append(para(
        "<font face='Courier'>_apply_ground_grid_filter()</font> deprojects every masked pixel into a rover-"
        "horizontal world frame (<font face='Courier'>world_X</font> = lateral, <font face='Courier'>world_Z</font> "
        "= forward, <font face='Courier'>world_Y</font> = height above the expected ground plane, using "
        "<font face='Courier'>camera_height_m</font> as the zero reference). It then lays a grid of "
        "<font face='Courier'>ground_grid_cell_m</font> (0.25 m) cells over the X/Z ground plane. Any cell with "
        "enough samples (<font face='Courier'>ground_grid_min_samples</font>) where most points sit off the "
        "ground plane by more than <font face='Courier'>ground_height_tol_m</font> (0.10 m) is flagged “not "
        "ground” and every mask pixel in it is removed — walls, raised beds, bushes, fences, parked cars, "
        "and grass berms all fail this test even if they were misclassified as walkable by color. Cells with too "
        "few depth samples to judge are left alone (benefit of the doubt), so a real sidewalk with imperfect "
        "depth coverage still survives."))
    story.append(para("Perspective-narrowing validation", "H3"))
    story.append(para(
        "A real sidewalk of roughly constant width projects to a pixel width that shrinks with distance "
        "(perspective: pixel width ∝ fx / depth). <font face='Courier'>_validate_perspective_narrowing()</font> "
        "measures the walkable band's pixel width in several horizontal bands, converts each to a real depth, and "
        "checks that the nearest band is measurably wider than the farthest "
        "(<font face='Courier'>perspective_min_narrowing_ratio</font>, default 1.05×). A flat wall dead ahead, "
        "or a misclassified blob that doesn't taper with distance, fails this check and the whole frame is "
        "rejected as <font face='Courier'>perspective_invalid</font>."))
    story.append(callout("Failing gracefully, not silently",
        "When perspective validation fails, the detector does NOT zero out both edges. It still serves each "
        "side's last-known cached position independently (subject to the TTL in §8) so a momentary bad frame "
        "on one side doesn't blank a perfectly good detection on the other.", "tip"))

    # ---------------- 6. HOUGH DETECTOR ----------------
    story.append(PageBreak())
    story.append(section_banner("6", "Edge Detector #1 — Hough Line-Fit (current default)"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>_detect_edges_hough()</font> is the live detector "
        "(<font face='Courier'>edge_hough_detector</font> defaults <b>true</b>). It is lane-departure-style: "
        "instead of finding one walkable blob and reading both of its sides (which couples the two edges "
        "together — losing sight of one side used to blank the other), it fits ONE line per side, "
        "independently, from candidate edge pixels."))
    story.append(para("1. Candidate edge pixels", "H3"))
    story.append(para(
        "Two sources are OR'd together into a single edge image — deliberately <b>not</b> raw Canny across "
        "the whole frame, because Canny alone fires on walls, furniture, and shadows that have nothing to do "
        "with the ground:"))
    story.append(bullet("<b>Color-class boundary:</b> a morphological gradient of the walkable mask from §4 — the boundary between walkable and not-walkable pixels."))
    story.append(bullet("<b>Depth drop-off:</b> a horizontal derivative of the depth image; any adjacent-pixel jump greater than <font face='Courier'>dropoff_min_depth_jump_m</font> (0.15 m) is marked as an edge pixel — this is how a curb or a grass step gets caught even when color alone doesn't clearly separate it."))
    story.append(para("2. Hough line segments", "H3"))
    story.append(para(
        "<font face='Courier'>cv2.HoughLinesP</font> extracts straight line segments from the combined edge "
        "image (<font face='Courier'>edge_line_hough_threshold</font>, <font face='Courier'>edge_line_min_len_px</font>, "
        "<font face='Courier'>edge_line_max_gap_px</font> control sensitivity)."))
    story.append(para("3. One independent fit per side", "H3"))
    story.append(bullet("Each segment's steepness is checked against <font face='Courier'>edge_line_min_abs_slope</font> — near-horizontal segments (the horizon, pavement cracks) are dropped as clutter."))
    story.append(bullet("Each surviving segment is assigned to <b>left</b> or <b>right</b> purely by which side of image-center its lowest (nearest) endpoint falls on."))
    story.append(bullet("Per side, <font face='Courier'>np.polyfit</font> fits a single line <font face='Courier'>x = a·y + b</font>, weighted by each segment's pixel length, giving one stable line per side even when made of several short segments."))
    story.append(para("4. Nearest valid ground point per side", "H3"))
    story.append(para(
        "The fitted line is walked from the bottom of the ROI upward (nearest ground first); the first row "
        "where the line is in-frame AND has valid depth becomes that side's reported edge point. The line is "
        "fit over the whole ROI for stability, but only the closest point is reported — that's the point "
        "the steering formula cares about."))
    story.append(para("Confidence", "H3"))
    story.append(para(
        "Confidence blends three independent signals: <b>support</b> (how much total segment length backed the "
        "fit), <b>fit quality</b> (how tightly the segments agree — low residual standard deviation), and "
        "<b>distance weighting</b> (a close edge is geometrically more reliable than a far one, fading from full "
        "weight at <font face='Courier'>edge_distance_full_conf_m</font> to zero weight at "
        "<font face='Courier'>edge_distance_zero_conf_m</font>). When both edges are seen at a plausible sidewalk "
        "width (0.4–2.5 m apart), both confidences get a corroboration boost "
        "(<font face='Courier'>edge_both_seen_conf_boost</font>) — driving straight down the middle of a "
        "narrow sidewalk shouldn't read as low-confidence just because each individual edge line is short."))
    story.append(callout("Losing one edge never blanks the other",
        "Because the left and right lines are fit from completely separate segment pools, a curb leaving the "
        "camera's field of view on one side has zero effect on the fit for the other side. This was the specific "
        "bug the Hough detector was built to fix — the older blob-based approach (§7) found ONE walkable "
        "region and read both of its edges from it, so losing sight of either physical edge could null both "
        "reported edges at once.", "tip"))

    # ---------------- 7. LINE-SCAN DETECTOR ----------------
    story.append(PageBreak())
    story.append(section_banner("7", "Edge Detector #2 — Line-Scan (independent bands)"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>_detect_path_from_lines()</font> is the earlier detector, still selectable by "
        "setting <font face='Courier'>edge_hough_detector: false</font> and <font face='Courier'>edge_lines_only: "
        "true</font> — useful as an A/B fallback."))
    story.append(bullet("The ROI is split into <font face='Courier'>edge_line_bands</font> (6) horizontal bands, near to far."))
    story.append(bullet("In each band, <font face='Courier'>find_independent_edges()</font> scans the walkable-mask column scores outward from the walkable column nearest image-center, independently in each direction, until it exits the walkable region or hits the image border. A side that runs off the image border is treated as out-of-frame (returns None) rather than a false edge."))
    story.append(bullet("Each band's left/right pixel hit is deprojected to a 3-D point exactly as in §6; across all bands, the <b>nearest</b> valid detection per side (smallest forward distance) is kept."))
    story.append(bullet("Confidence here scales with how much of the local mask run backs the detected pixel (longer run → more confident), rather than the Hough detector's support/fit-quality/distance blend."))
    story.append(para(
        "This detector still anchors each side's scan to the walkable column nearest the image center before "
        "scanning outward independently in each direction — the same anti-coupling technique "
        "<font face='Courier'>find_independent_edges()</font> uses in the Hough path's supporting code, so "
        "losing one edge does not blank the other here either. Both detectors funnel into the same "
        "<font face='Courier'>_assemble_edge_result()</font> (§8), so the LCD, message handler, and steering "
        "code are completely unaware of which detector is active."))

    # ---------------- 8. ASSEMBLY ----------------
    story.append(PageBreak())
    story.append(section_banner("8", "Shared Edge Assembly: Smoothing, Caching, Selection"))
    story.append(Spacer(1, 8))
    story.append(para(
        "Both detectors hand their raw left/right observations to <font face='Courier'>_assemble_edge_result()</font>, "
        "the single place that turns “what did this frame see” into “what should the rover do.”"))
    story.append(para("EMA smoothing", "H3"))
    story.append(para(
        "Each side's lateral position is smoothed with an exponential moving average "
        "(<font face='Courier'>edge_ema_alpha</font>, default 0.3 — 30% new value / 70% history, roughly a "
        "4-frame time constant at 15 fps). Only the lateral (X) component is smoothed; forward distance (Y) is "
        "left raw, because smoothing Y would introduce lag that inflates the apparent forward distance and can "
        "silently block corrections that check against a maximum forward distance."))
    story.append(para("Per-side last-known cache (TTL)", "H3"))
    story.append(para(
        "If a side isn't detected this frame, its previous observation is reused for up to "
        "<font face='Courier'>edge_known_ttl_ms</font> (5000 ms), tagged as <font face='Courier'>known=true</font> "
        "with an age. Past the TTL it reports as not-seen. This is what lets the rover ride through a brief "
        "occlusion (a pedestrian, a shadow flicker, a momentary bad frame) without the correction snapping to "
        "zero and back."))
    story.append(para("Validity filters", "H3"))
    story.append(bullet("A detected edge closer than <font face='Courier'>edge_min_lateral_m</font> (0.4 m) to the camera's centerline is discarded — too close to be a real sidewalk boundary, more likely noise."))
    story.append(bullet("A “left” edge reported on the positive (right) side of center, or a “right” edge reported on the negative (left) side, is discarded — a basic sanity check against a detector bug swapping sides."))
    story.append(para("Choosing what to steer on", "H3"))
    story.append(bullet("<b>Both edges known</b> → steer to the midpoint (<font face='Courier'>use = \"center\"</font>); target offset is the mean of both sides' signed lateral position."))
    story.append(bullet("<b>One edge known</b> → hold <font face='Courier'>edge_side_offset_m</font> (0.4572 m / 1.5 ft) off it: to the right of a left edge, or to the left of a right edge."))
    story.append(bullet("<b>Neither known</b> → <font face='Courier'>edge_guidance_valid = false</font>; the JS side latches the last correction briefly, then fades to GPS-only (§10)."))
    story.append(para(
        "The final steering signal is one number: <font face='Courier'>x_angle_deg = "
        "atan2(-target_offset, forward_distance)</font> — the angle from the camera's boresight to the point "
        "the rover should be driving toward. Positive means the target is to the right."))

    # ---------------- 9. OBJECT DETECTION ----------------
    story.append(PageBreak())
    story.append(section_banner("9", "Object Detection & Threat Zones"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>detect_objects()</font> runs on every frame alongside path detection, using the "
        "same pitch/roll-corrected deprojection math but over the <b>full</b> depth frame (downsampled 4× for "
        "CPU headroom, with intrinsics scaled to match)."))
    story.append(bullet("Every pixel is deprojected into the rover-horizontal world frame; a pixel counts as a candidate obstacle if its height above ground is between <font face='Courier'>object_min_height_m</font> (0.127 m / 5 in) and 2.5 m — tall enough to matter, short enough to still be an obstacle rather than a tree canopy."))
    story.append(bullet("Morphological close/open cleans the obstacle mask, then <font face='Courier'>cv2.connectedComponentsWithStats</font> clusters it into discrete objects, discarding clusters below <font face='Courier'>object_min_area_px</font>."))
    story.append(bullet("Each object reports a <b>clock-face bearing</b> (12 = straight ahead) computed from <font face='Courier'>atan2(lateral, near_distance)</font>, a distance (20th-percentile depth, so the near edge of the object is reported rather than its center), height, width, and a <b>threat level</b>: <font face='Courier'>high</font> if it's within the rover's track width and closer than 1.5 rover-lengths, <font face='Courier'>medium</font> if either condition alone holds, otherwise <font face='Courier'>low</font>."))
    story.append(para(
        "On the Node side, <font face='Courier'>realsense_message_handler.js</font> maps each object's clock "
        "bearing onto camera zones 10–11–12–1–2 and applies a <b>1-second confirmation filter</b> per zone "
        "before lighting it red or yellow — a single-frame flicker cannot trigger avoidance or an emergency "
        "stop; the same threat level has to persist for a full second first. A zone clears back to green "
        "immediately once the threat is gone, so the rover is never stuck waiting out a hold-time on the "
        "all-clear side."))

    # ---------------- 10. STEERING CONSUMER ----------------
    story.append(PageBreak())
    story.append(section_banner("10", "From Camera to Wheels: the Steering Consumer"))
    story.append(Spacer(1, 8))
    story.append(para(
        "<font face='Courier'>lib/yellow_brick_road/follow_the_yellow_brick_road.js</font> is the only place "
        "the vision output actually turns into motor commands, once per 250 ms mission tick."))
    story.append(bullet("<b>Confidence gate:</b> a raw edge reading below <font face='Courier'>confidence_threshold</font> (0.45) is discarded before it ever reaches the steering formula — this is what stops a far-away, low-confidence corner read from producing a large, spurious steering spike."))
    story.append(bullet("<b>Steering angle:</b> with both edges accepted, the code steers toward their midpoint via <font face='Courier'>atan2(centerline_x, centerline_y)</font>; with only one accepted, the null side contributes zero to the average, which (since scaling both terms by the same factor doesn't change an atan2 ratio) still steers along that single edge's bearing."))
    story.append(bullet("<b>Non-linear steering tune:</b> the raw angle is scaled by a tune factor that ramps from 0.50 at small angles up to 1.00 above 18° — gentle corrections are damped so the rover doesn't hunt on straight sidewalk, while sharp corrections get full authority."))
    story.append(bullet("<b>Motor speed</b> is driven by the average of the two edge confidences — lower confidence means more caution, giving the vision pipeline more time (and more frames) to reacquire the edge."))
    story.append(bullet("The final angle is clamped to ±20° and handed to <font face='Courier'>calc_steering_and_rpm()</font>, which produces the four individual servo angles and wheel RPMs sent to the servos and motor drivers."))
    story.append(callout("Edge guidance is gated, not always-on",
        "This whole pipeline only steers the rover when <font face='Courier'>mission.sidewalk_follow_active</font> "
        "is on — toggled by passing a GATE waypoint (a route turn ≥ 90°, or two waypoints placed within "
        "1 m of each other). Outside the gated sidewalk section — driveways, roads, the area near the dock — "
        "GPS waypoint following runs alone and camera steering is suppressed entirely.", "info"))

    # ---------------- 11. PARAMETERS ----------------
    story.append(PageBreak())
    story.append(section_banner("11", "Tunable Parameters Reference"))
    story.append(Spacer(1, 8))
    story.append(para(
        "All of the following live under <font face='Courier'>realsense_vision</font> in "
        "<font face='Courier'>setup.json</font> and reach the Python subprocess wholesale (§2). Per "
        "project rule, any change here must also be mirrored into "
        "<font face='Courier'>setup_example.json</font>."))
    ref_rows = [
        ["Setting", "Default", "What it controls"],
        ["edge_hough_detector", "true", "Selects the Hough line-fit detector (§6) over the line-scan detector (§7)"],
        ["edge_lookahead_m", "0.6096 m", "How far ahead (2 ft) guidance aims to read the sidewalk edge"],
        ["edge_side_offset_m", "0.4572 m", "Lateral gap (1.5 ft) held off a single visible edge"],
        ["confidence_threshold", "0.45", "Raw edge confidence floor before a reading reaches steering (Node side)"],
        ["edge_ema_alpha", "0.3", "EMA smoothing weight on edge lateral position (higher = less smoothing)"],
        ["edge_known_ttl_ms", "5000 ms", "How long a lost edge's last-known position stays valid"],
        ["edge_roi_top_frac / bottom_frac", "0.40 / 0.95", "Vertical crop of the frame used for ground/edge detection"],
        ["edge_line_canny_low / high", "45 / 130", "Canny thresholds feeding the color-boundary edge image (Hough path)"],
        ["edge_line_hough_threshold", "30", "HoughLinesP vote threshold — lower finds more, noisier lines"],
        ["edge_line_min_len_px / max_gap_px", "30 / 20", "Minimum segment length / max gap HoughLinesP will bridge"],
        ["edge_line_min_abs_slope", "0.25", "Rejects near-horizontal Hough segments (horizon, cracks) as clutter"],
        ["dropoff_min_depth_jump_m", "0.15 m", "Depth discontinuity that counts as a curb/grass drop-off edge"],
        ["camera_height_m", "0.406 m", "RealSense mount height above ground — zero reference for ground-plane math"],
        ["camera_mount_pitch_deg", "0", "Static forward mount tilt; subtracted from live rover body pitch"],
        ["ground_height_tol_m", "0.10 m", "Height tolerance for the TRON-grid ground-plane filter (§5)"],
        ["ground_grid_cell_m", "0.25 m", "Cell size of the ground-plane classification grid"],
        ["perspective_min_narrowing_ratio", "1.05", "Required near/far pixel-width ratio for perspective validation"],
        ["object_emergency_stop_m", "1.0 m", "In-path high-threat distance that triggers an immediate stop"],
        ["object_min_height_m", "0.127 m", "Minimum height above ground counted as an obstacle (5 in)"],
        ["fps_normal / fps_high_cpu / fps_critical_cpu", "15 / 10 / 7", "Adaptive frame-rate ladder keyed to Pi CPU load"],
    ]
    story.append(make_table(ref_rows, [1.95 * inch, 0.95 * inch, 3.75 * inch]))

    story.append(Spacer(1, 16))
    story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=8))
    story.append(para(
        "For the operator-facing summary of edge guidance, avoidance, and LCD readouts, see "
        "<font face='Courier'>noah_system_manual.pdf</font> §10. For deeper architecture notes and the "
        "project's living memory, see CLAUDE.md and .claude/memory/ in the repository.", "Small"))

    doc.build(story)


if __name__ == "__main__":
    build()
    print(f"Wrote {OUT_PATH}")
