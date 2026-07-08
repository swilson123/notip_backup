#!/usr/bin/env python3
"""
noah_knows.pdf — How Noah Knows
Cover: dark navy + stars + a single-vantage-point / witnesses symbol.
Content: same ReportLab flowable style as the other rover PDFs
(claude_memory_evolution.pdf palette and structure).
Merged with PyMuPDF.
"""

import os, math, random, tempfile
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles    import ParagraphStyle
from reportlab.lib.units     import inch
from reportlab.lib.colors    import HexColor, white
from reportlab.platypus      import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    HRFlowable, Table, TableStyle,
)
from reportlab.lib.enums     import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.pdfgen        import canvas as rl_canvas
import fitz

DIR         = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(DIR, 'noah_knows.pdf')

PW, PH = letter   # 612 x 792 pt

# -- Palette (matches claude_memory_evolution.pdf) --------------------------
NAVY      = HexColor('#0D1B2A')
GOLD      = HexColor('#C9A84C')
GOLD_LT   = HexColor('#E8C97A')
BODY_CLR  = HexColor('#1E1E2E')
MID_GREY  = HexColor('#777788')
SUBHEAD   = HexColor('#1A3A5C')
RULE_GOLD = HexColor('#C9A84C')
CODE_BG   = HexColor('#F4F4F0')
QUOTE_BG  = HexColor('#F0EDE6')
TBL_HDR   = HexColor('#0D1B2A')
TBL_ROW1  = HexColor('#FAFAFA')
TBL_ROW2  = HexColor('#EEF3FA')
GREEN     = HexColor('#1A6B1A')
RED       = HexColor('#8B1A1A')


# ============================================================================
#  COVER
# ============================================================================
def build_cover(path):
    cv = rl_canvas.Canvas(path, pagesize=letter)
    W, H = PW, PH

    cv.setFillColor(NAVY)
    cv.rect(0, 0, W, H, fill=1, stroke=0)

    rng = random.Random(408)
    cv.setFillColor(white)
    for _ in range(90):
        x = rng.uniform(0.3*inch, W - 0.3*inch)
        y = rng.uniform(0.5*inch, H - 0.5*inch)
        r = rng.uniform(0.6, 2.0)
        cv.circle(x, y, r, fill=1, stroke=0)

    title_y = H * 0.83
    cv.setFillColor(white)
    cv.setFont('Helvetica-Bold', 46)
    cv.drawCentredString(W/2, title_y,      'HOW NOAH')
    cv.drawCentredString(W/2, title_y - 54, 'KNOWS')

    cv.setStrokeColor(GOLD)
    cv.setLineWidth(1.5)
    cv.line(W*0.22, title_y - 68, W*0.78, title_y - 68)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica', 15)
    cv.drawCentredString(W/2, title_y - 86,
        'Deciding What Is True From One Vantage Point')
    cv.setFont('Helvetica', 12)
    cv.drawCentredString(W/2, title_y - 102,
        'The Edge-Detection Epistemology Behind Every Steering Command')

    qlines = [
        '"We should be able to detect outliers, right?"',
        '"Since all edges are calculated from a single point of view —',
        'the bottom center of the screen."',
    ]
    cv.setFillColor(HexColor('#B0BEC5'))
    cv.setFont('Helvetica-Oblique', 9.5)
    qy = title_y - 130
    for line in qlines:
        cv.drawCentredString(W/2, qy, line)
        qy -= 14
    cv.setFont('Helvetica', 8.5)
    cv.setFillColor(GOLD)
    cv.drawCentredString(W/2, qy - 4, '— Scott Christopher Wilson')

    # Symbol: one vantage point (Noah, bottom-center), several witness bands
    # fanning outward -- most agreeing on a shared line, one flagged as an
    # outlier that doesn't fit the pattern.
    cx  = W / 2
    cy  = H * 0.35
    r_witness = 0.62 * inch

    cv.setStrokeColor(HexColor('#2A4A6A'))
    cv.setLineWidth(1.0)
    cv.circle(cx, cy, r_witness, fill=0, stroke=1)

    witness_degs = [58, 74, 90, 106, 122]
    outlier_deg  = 40
    for deg in witness_degs:
        rad = math.radians(deg)
        nx, ny = cx + r_witness*math.cos(rad), cy + r_witness*math.sin(rad)
        cv.setStrokeColor(GOLD)
        cv.setLineWidth(1.1)
        cv.line(cx, cy, nx, ny)
        cv.setFillColor(GOLD_LT)
        cv.circle(nx, ny, 0.045*inch, fill=1, stroke=0)

    rad = math.radians(outlier_deg)
    ox, oy = cx + r_witness*math.cos(rad), cy + r_witness*math.sin(rad)
    cv.setStrokeColor(HexColor('#7A3B3B'))
    cv.setDash(2, 2)
    cv.setLineWidth(1.1)
    cv.line(cx, cy, ox, oy)
    cv.setDash()
    cv.setFillColor(HexColor('#C05050'))
    cv.circle(ox, oy, 0.05*inch, fill=1, stroke=0)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 2 * 4)
    cv.circle(cx, cy, 0.09*inch, fill=1, stroke=0)
    cv.setFillColor(NAVY)
    cv.setFont('Helvetica-Bold', 7)
    cv.drawCentredString(cx, cy - 2.5, 'NOW')

    cv.setFillColor(HexColor('#8899AA'))
    cv.setFont('Helvetica', 6.5)
    cv.drawCentredString(cx, cy - r_witness - 0.20*inch,
        'five witnesses agree  ·  one does not')

    bar_y = H * 0.11
    cv.setFillColor(HexColor('#162336'))
    cv.roundRect(0.7*inch, bar_y - 8, W - 1.4*inch, 26, 4, fill=1, stroke=0)
    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 10)
    cv.drawCentredString(W/2, bar_y + 4,
        'One Frame  ·  Many Witnesses  ·  Confidence, Not Certainty')

    cv.setFillColor(HexColor('#607080'))
    cv.setFont('Helvetica', 8)
    cv.drawCentredString(W/2, H * 0.065,
        'lib/realsense/realsense_vision.py  ·  Scott Christopher Wilson & Claude  ·  July 8, 2026')

    cv.showPage()
    cv.save()


# ============================================================================
#  INTERIOR PAGE TEMPLATE
# ============================================================================
def draw_interior(cv, doc):
    cv.saveState()
    W, H = PW, PH

    cv.setStrokeColor(RULE_GOLD)
    cv.setLineWidth(0.8)
    cv.line(0.65*inch, H - 0.50*inch, W - 0.65*inch, H - 0.50*inch)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 7)
    cv.drawString(0.65*inch, H - 0.38*inch,
        'HOW NOAH KNOWS  ·  EDGE-DETECTION DECISION LOGIC')
    cv.setFillColor(MID_GREY)
    cv.setFont('Helvetica', 7)
    cv.drawRightString(W - 0.65*inch, H - 0.38*inch,
        f'Scott Christopher Wilson  ·  {doc.page - 1}')

    cv.setStrokeColor(HexColor('#DDDDCC'))
    cv.setLineWidth(0.4)
    cv.line(0.65*inch, 0.48*inch, W - 0.65*inch, 0.48*inch)

    cv.setFillColor(MID_GREY)
    cv.setFont('Helvetica-Oblique', 6.5)
    cv.drawCentredString(W/2, 0.31*inch,
        'One vantage point  ·  many witnesses  ·  confidence, not certainty')

    cv.restoreState()


# ============================================================================
#  STYLES
# ============================================================================
def make_styles():
    S = {}
    S['section_label'] = ParagraphStyle('section_label',
        fontName='Helvetica-Bold', fontSize=8, leading=12,
        textColor=GOLD, alignment=TA_LEFT,
        spaceBefore=18, spaceAfter=2, letterSpacing=2)
    S['section_title'] = ParagraphStyle('section_title',
        fontName='Helvetica-Bold', fontSize=22, leading=28,
        textColor=NAVY, alignment=TA_LEFT,
        spaceBefore=2, spaceAfter=8)
    S['h3'] = ParagraphStyle('h3',
        fontName='Helvetica-Bold', fontSize=12, leading=17,
        textColor=SUBHEAD, alignment=TA_LEFT,
        spaceBefore=14, spaceAfter=4)
    S['body'] = ParagraphStyle('body',
        fontName='Helvetica', fontSize=10.5, leading=17,
        textColor=BODY_CLR, alignment=TA_JUSTIFY,
        spaceBefore=4, spaceAfter=4)
    S['bullet'] = ParagraphStyle('bullet',
        fontName='Helvetica', fontSize=10.5, leading=16,
        textColor=BODY_CLR, alignment=TA_LEFT,
        leftIndent=18, spaceBefore=2, spaceAfter=2)
    S['quote'] = ParagraphStyle('quote',
        fontName='Helvetica-Oblique', fontSize=11, leading=18,
        textColor=SUBHEAD, alignment=TA_CENTER,
        spaceBefore=10, spaceAfter=10,
        leftIndent=36, rightIndent=36,
        backColor=QUOTE_BG, borderPad=9)
    S['code'] = ParagraphStyle('code',
        fontName='Courier', fontSize=8.5, leading=14,
        textColor=HexColor('#1A1A1A'), alignment=TA_LEFT,
        spaceBefore=6, spaceAfter=6,
        leftIndent=12, rightIndent=12,
        backColor=CODE_BG, borderPad=8)
    S['caption'] = ParagraphStyle('caption',
        fontName='Helvetica-Oblique', fontSize=8, leading=12,
        textColor=MID_GREY, alignment=TA_CENTER,
        spaceBefore=2, spaceAfter=8)
    return S


# ============================================================================
#  HELPERS
# ============================================================================
def section(num, label, title, S):
    return [
        Paragraph(f'SECTION {num}', S['section_label']),
        Paragraph(label, S['section_label']),
        Paragraph(title, S['section_title']),
        HRFlowable(width='100%', thickness=0.8, color=RULE_GOLD,
                   spaceAfter=10),
    ]

def body(text, S):
    return Paragraph(text, S['body'])

def quote(text, S):
    return Paragraph(text, S['quote'])

def h3(text, S):
    return Paragraph(text, S['h3'])

def bullet(text, S):
    return Paragraph(f'&nbsp;&nbsp;•  {text}', S['bullet'])

def code(text, S):
    safe = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    lines = safe.split('\n')
    return Paragraph('<br/>'.join(lines), S['code'])

def sp(n=8):
    return Spacer(1, n)

_TBL_HDR_STYLE = ParagraphStyle('tbl_hdr', fontName='Helvetica-Bold', fontSize=8,
    leading=10.5, textColor=GOLD, wordWrap='CJK')
_TBL_CELL_STYLE = ParagraphStyle('tbl_cell', fontName='Helvetica', fontSize=9,
    leading=12, textColor=BODY_CLR, wordWrap='CJK')
_TBL_CODE_CELL_STYLE = ParagraphStyle('tbl_code_cell', fontName='Courier', fontSize=8,
    leading=11, textColor=SUBHEAD, wordWrap='CJK')


def ruled_table(data, col_widths, header_row=True, mono_col=None):
    # Raw strings inside a platypus Table do NOT wrap to the column width --
    # they silently overflow into neighboring cells/off the page. Every cell
    # has to be a Paragraph so ReportLab actually flows the text; wordWrap
    # 'CJK' additionally allows a break mid-identifier (config keys like
    # edge_corroboration_y_window_m have no spaces for normal wrapping to
    # use).
    wrapped = []
    for r_idx, row in enumerate(data):
        cells = []
        for c_idx, val in enumerate(row):
            if isinstance(val, Paragraph):
                cells.append(val)
                continue
            text = str(val).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            if r_idx == 0 and header_row:
                cells.append(Paragraph(text, _TBL_HDR_STYLE))
            elif mono_col is not None and c_idx == mono_col:
                cells.append(Paragraph(text, _TBL_CODE_CELL_STYLE))
            else:
                cells.append(Paragraph(text, _TBL_CELL_STYLE))
        wrapped.append(cells)

    style = [
        ('BACKGROUND',  (0,0), (-1,0), TBL_HDR),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [TBL_ROW1, TBL_ROW2]),
        ('ALIGN',       (0,0), (-1,-1), 'LEFT'),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
        ('TOPPADDING',  (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0),(-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING',(0,0), (-1,-1), 8),
        ('GRID',        (0,0), (-1,-1), 0.4, HexColor('#CCCCCC')),
        ('LINEBELOW',   (0,0), (-1,0), 1.5, GOLD),
    ]
    return Table(wrapped, colWidths=col_widths,
                 style=TableStyle(style), repeatRows=1 if header_row else 0)


# ============================================================================
#  CONTENT
# ============================================================================
def build_content(path):
    doc = SimpleDocTemplate(
        path,
        pagesize=letter,
        leftMargin=0.75*inch, rightMargin=0.75*inch,
        topMargin=0.75*inch,  bottomMargin=0.75*inch,
        onPage=draw_interior,
    )
    S = make_styles()
    story = []

    # -- Section 1 -----------------------------------------------------
    story += section(1, 'THE QUESTION', 'What Does It Mean to Know an Edge Is Real?', S)
    story.append(body(
        'Noah has no ground truth. He has a depth camera, one frame at a time, and a '
        'decision to make every 250 milliseconds: where is the edge of the sidewalk, '
        'and how far should I turn to stay on it. A shadow can look like a curb. A '
        'mulch line can look like a curb. A single misread pixel, smoothed and trusted, '
        'can steer him off the real one. The question this document answers is not '
        '"how does Noah see" — that is the camera. It is <b>how does Noah decide what '
        'he saw was actually true</b>, and what he does the moment he is not sure.', S))
    story.append(sp(8))
    story.append(quote(
        '"My biggest concern is false edges which are believed to be true."<br/><br/>'
        '— Scott Christopher Wilson', S))
    story.append(sp(6))
    story.append(body(
        'Four decisions govern this, each one a direct answer to a specific way Noah '
        'used to be fooled. None of them add a new sensor. All four come from asking '
        'sharper questions of the same single camera frame he already has.', S))

    # -- Section 2 -----------------------------------------------------
    story.append(PageBreak())
    story += section(2, 'VERIFYING ACROSS MOTION', 'Truth Isn\'t in One Frame — It\'s in What Moves Correctly', S)
    story.append(body(
        'The first version of this idea checked whether several bands of the SAME '
        'frame — near, medium, far — agreed with each other. That has a real blind '
        'spot: a shadow or a seam that happens to run roughly parallel to the curb for '
        'a few feet agrees with itself across those bands just as well as a real edge '
        'does. Same-frame agreement proves a detection looks consistent. It does not '
        'prove it is a physical, three-dimensional thing. It was also, as it turned '
        'out, wired into a detector path (_compute_edge_guidance) that a config flag '
        'set elsewhere made unreachable — described in an earlier draft of this '
        'document as live behavior it never actually was. Removed 2026-07-08, along '
        'with the rest of that dead branch, rather than left in place pretending to run.', S))
    story.append(sp(8))
    story.append(h3('The rule that replaced it', S))
    story.append(body(
        'A real, physical edge is a fixed point in the world. Noah always knows how '
        'much his own heading has changed since the last tick — the compass reports '
        'it, the same way it already reports pitch and roll. So instead of asking '
        '"do nearby pixels in this one glance agree," Noah asks a stronger question: '
        '"if that edge point is real, and I know exactly how much I just turned, does '
        'it reappear exactly where physics says it must?" A shadow does not obey that '
        'rotation — its position and contrast depend on the sun angle relative to the '
        'camera, not on depth. A real curb has no choice but to match the prediction.', S))
    story.append(sp(6))
    story.append(code(
        '# theta = how much heading changed since the point was last accepted\n'
        'pred_x = cos(theta) * prev_x - sin(theta) * prev_y\n'
        'pred_y = sin(theta) * prev_x + cos(theta) * prev_y\n'
        'residual = distance(this_tick_x_y, (pred_x, pred_y))\n'
        'confidence *= max(0.4, 1 - residual / edge_residual_scale_m)   # never raises it', S))
    story.append(sp(4))
    story.append(Paragraph(
        'realsense_vision.py, _predict_and_score — only evaluated when heading has '
        'changed by at least edge_residual_min_dtheta_deg (3°): with near-zero heading '
        'change there is no way to also separate out forward travel from a pure '
        'rotation model, so the check stays inert on ordinary straight-line driving '
        'rather than risk marking a real edge down for no reason.', S['caption']))
    story.append(sp(8))
    story.append(body(
        'This was Scott\'s framing, not an incremental patch on the old one: '
        '"we can yaw Noah... look for shadows changing the contrast on the sidewalk... '
        'I want truth." A deliberate verification yaw is the same test with a wider, '
        'more decisive baseline — the natural next step once this is proven on the '
        'ordinary steering corrections Noah already makes.', S))

    # -- Section 3 -----------------------------------------------------
    story.append(PageBreak())
    story += section(3, 'RECOGNIZING CHANGE', 'A Real Jump Is Not the Same as Noise — Still Open', S)
    story.append(body(
        'Noah smooths the edge position tick to tick, so that ordinary camera jitter '
        'does not make him twitch the wheel. That smoothing has a cost: a plain average '
        'cannot natively tell noise apart from a real event. When the sidewalk curves '
        'while Noah is still driving straight into it — before he has turned at all — '
        'the true edge position genuinely jumps in a single tick, and the smoothed '
        'value lags behind it for several ticks afterward. That misfire was traced '
        'exactly, tick by tick, in simulation: a commanded turn that went from '
        'thirty-four degrees to fifteen to negative fifteen to negative forty-nine '
        'across four ticks, purely because the average had not caught up to a curve '
        'that had already happened.', S))
    story.append(sp(8))
    story.append(h3('Honestly: not yet re-solved', S))
    story.append(body(
        'A jump-reset rule for exactly this existed once (edge_ema_reset_jump_m: '
        'snap to a fresh reading instead of blending it, when the jump is too large to '
        'be jitter) — but it lived in _smooth_guidance_obs, part of the same dead '
        'branch removed 2026-07-08. It is gone now, and the live smoothing function '
        '(_smooth_obs) still has no jump escape. The motion-verification check in '
        'Section 2 does not cover this case either — it only activates when Noah\'s '
        'own heading changes, and this failure mode is specifically about a curve '
        'arriving before he has started turning at all. This page is left in the '
        'document as an open item, not deleted, so the concern it raised does not '
        'quietly disappear along with the code that once addressed it.', S))

    # -- Section 4 -----------------------------------------------------
    story.append(PageBreak())
    story += section(4, 'LOOKING IN THE RIGHT PLACE', 'What The Live Detector Actually Scans For', S)
    story.append(body(
        'An earlier draft of this document described Noah scanning for the band '
        'nearest a fixed lookahead distance, the same distance every tick, as a '
        'deliberate fix for a detector that used to grab whichever point was simply '
        'closest and available. That fix is real, but it lives in _compute_edge_guidance '
        '— the branch removed 2026-07-08 alongside the same-frame witness check. It was '
        'never reachable under the config this rover actually ships with.', S))
    story.append(sp(8))
    story.append(h3('What actually runs: _detect_edges_hough / line_to_obs', S))
    story.append(body(
        'The live detector fits one line per side from the whole ROI, then scans that '
        'line from the bottom of the frame upward and reports the FIRST row past a '
        'minimum forward distance (edge_lookahead_m) with valid depth — nearest-'
        'available beyond a floor, not nearest-to-a-fixed-target. Because the line '
        'itself is fit from every valid segment in the ROI, not just the reported '
        'point, a single noisy row can\'t swing the whole reading the way a raw '
        'nearest-pixel pick could — the stability the old fix was reaching for comes '
        'from the whole-line fit, by a different route than originally documented here.', S))

    # -- (moved) note on the dead corroboration branch now lives above; Section 5 unchanged --

    # -- Section 5 -----------------------------------------------------
    story.append(PageBreak())
    story += section(5, 'ANCHORING TO SELF', 'When One Edge Is Missing, Start From Where I Am', S)
    story.append(body(
        'A sidewalk\'s two edges run parallel, even around a curve. So when only one '
        'edge is actually visible, Noah can reasonably infer where the other one '
        'probably is, by mirroring the visible edge\'s angle onto the missing side. '
        'The question is what point that mirrored line should be anchored to. It used '
        'to be anchored at the corner of the camera frame — a place with no physical '
        'meaning, forcing an extreme, false slope just to reach real data a few rows '
        'away. The corrected anchor is bottom-center: Noah\'s own position, projected '
        'straight down. Both the real line and the inferred one now fan out from where '
        'he actually stands, not from an arbitrary corner of the picture.', S))

    # -- Section 6 -----------------------------------------------------
    story.append(PageBreak())
    story += section(6, 'WHAT NOAH DOES WHEN HE IS NOT SURE', 'Confidence, Not Certainty', S)
    story.append(body(
        'What actually shapes confidence on the live path today is smaller than a '
        'younger draft of this document claimed, and every part of it produces a '
        'number, never a flat yes or no. Distance weighting trusts a close reading '
        'more than a far one. Seeing both edges at a plausible sidewalk width boosts '
        'both sides at once — the strongest, most stable case. The missing-edge mirror '
        '(Section 5) is anchored at Noah\'s own position, so an inferred edge is never '
        'worse-grounded than it has to be. And now, whenever heading has genuinely '
        'changed, the motion check in Section 2 can only ever push confidence down, '
        'never up — a real edge survives it; a shadow does not.', S))
    story.append(sp(10))
    story.append(quote(
        '"Since all edges are calculated from a single point of view — the bottom '
        'center of the screen — we should be able to detect outliers, right?"<br/><br/>'
        '— Scott Christopher Wilson', S))
    story.append(sp(6))
    story.append(body(
        'That sentence started this document, and it took a wrong turn before it '
        'reached its own answer: the first attempt looked for outliers within a single '
        'frame, which is one vantage point but one instant only. The corrected answer '
        'is one vantage point across CHANGE — Noah verifies a candidate edge against '
        'what his own known motion says must be true of it, not against its neighbors '
        'in the same glance. When nothing has moved enough to test, and nothing '
        'corroborates further than distance and both-sides-seen already account for, '
        'Noah does not pretend to know — he steers anyway, at exactly the confidence '
        'the evidence earns, and no more.', S))

    # -- Section 7: one edge missing, inner vs outer ----------------------
    story.append(PageBreak())
    story += section(7, 'ONE EDGE MISSING', 'Facing the Outer Edge vs. Facing the Inner Edge', S)
    story.append(body(
        'When only one edge is visible, Noah does not know whether it is the inner '
        'or outer curve of a bend — he only knows <i>left</i> or <i>right</i> relative '
        'to his current heading. The rule is the same either way: aim a fixed '
        '<b>side_offset</b> in from whichever one he can see.', S))
    story.append(sp(4))
    story.append(code(
        'only LEFT visible:   u_target = left_m  - side_offset\n'
        'only RIGHT visible:  u_target = right_m + side_offset\n'
        'x_angle_deg = atan2(-u_target, forward_m)', S))
    story.append(body(
        'Left/right is decided fresh every tick from which side of Noah\'s current '
        'heading the center of curvature falls on — not carried over from the last '
        'tick. Rotate far enough and the label on a given physical edge can flip, '
        'which is exactly what a full heading sweep (below) reveals.', S))

    story.append(sp(10))
    story.append(h3('A full sweep, position held fixed and correct', S))
    story.append(body(
        'Sweeping heading error away from the correct tangent, all the way around, '
        'on the same tight curve used throughout this investigation:', S))
    story.append(sp(6))
    story.append(ruled_table([
        ['Heading error from tangent', 'Visible', 'Behavior'],
        ['0° (correct)', 'both', 'x_angle = +8.9° -- the ordinary curve-anticipation nudge'],
        ['0° to +25° toward outer', 'both', 'angle grows smoothly, nothing lost yet'],
        ['+25° to +150° toward outer', 'outer only -- inner vanishes', 'single-edge fallback runs the whole way'],
        ['+90° (pointed straight at outer edge)', 'outer only', 'x_angle = -45° -- a hard correction, sign flipped from the +60° case'],
        ['-25° to -180° toward inner', 'both, the entire way', 'outer never disappears in this sweep at all'],
    ], [2.1*inch, 1.7*inch, 2.9*inch]))

    story.append(sp(10))
    story.append(h3('The arithmetic behind three representative headings', S))
    story.append(ruled_table([
        ['Heading', 'Visible edge, reading', 'u_target', 'x_angle_deg'],
        ['Correct / tangent', 'both, blended', '-0.047', '+8.9°'],
        ['+60° toward outer (moderate)', 'outer only, m=0.447', '-0.053', '+10.0°'],
        ['+90° toward outer (radial, extreme)', 'outer only, m=0.800', '+0.300', '-45.0°'],
    ], [1.8*inch, 2.0*inch, 1.1*inch, 1.1*inch]))

    story.append(sp(10))
    story.append(h3('Two things worth understanding, not just reading off the table', S))
    story.append(bullet(
        '<b>The asymmetry is geometric, not a bug.</b> The inner curve is close and '
        'small, so only a narrow cone of headings around true tangent keeps a forward '
        'band able to reach it. The outer curve is farther and bigger, so an enormous '
        'range of headings -- including pointed straight at the inner curb -- still '
        'land a forward ray on it. Drifting toward the outer edge is what costs Noah '
        'the inner edge\'s data; drifting toward the inner edge does not, by itself, '
        'cost him the outer edge\'s data at this curve tightness.', S))
    story.append(bullet(
        '<b>Watch the sign flip between +60° and +90°.</b> Both read "outer '
        'visible, inner missing" -- same mode, same formula -- but one produces a mild '
        '+10° correction and the other a hard -45°, the opposite direction. '
        'Nothing broke; u_target crossed zero between them because at +90° Noah is '
        'looking almost straight down the outer curb, close enough that it reads as '
        'being on the wrong side of his intended offset line, not just near it. The '
        'single-edge formula is locally sound everywhere, but its output is not '
        'monotonic in heading error once the heading points nearly straight at the '
        'curb -- a small extra rotation there can flip which way it tells him to turn.', S))

    # -- Section 8: the carrot angle ---------------------------------------
    story.append(PageBreak())
    story += section(8, 'THE CARROT ANGLE', 'From What Noah Sees to What He Does', S)
    story.append(body(
        'Every rule so far answers where the edge is. None of them, by themselves, is a '
        'steering command. The one number that actually turns Noah\'s wheels is '
        '<b>x_angle_deg</b> — the carrot angle — and it is built from two different kinds '
        'of knowledge at once: what the camera saw this instant, and where Noah\'s own '
        'body is pointed and tilted right now.', S))

    story.append(sp(8))
    story.append(h3('Heading is baked in before the angle exists', S))
    story.append(body(
        'The camera reports a pixel. Before that pixel becomes a real-world distance, '
        'Noah rotates it by his own current pitch and roll — read from the flight '
        'controller, not assumed level — so a rover cresting a driveway lip or leaning '
        'on a cross-slope still measures the true forward and lateral distance to the '
        'edge, not a foreshortened or skewed one.', S))
    story.append(sp(4))
    story.append(code(
        'rolled_X  = cr * cam_X - sr * cam_Y      # roll-compensated lateral offset\n'
        'rolled_Y  = sr * cam_X + cr * cam_Y\n'
        'forward_m = sp * rolled_Y + cp * depth_m  # pitch-compensated forward distance', S))
    story.append(Paragraph(
        'cr/sr = cos/sin(current_roll_rad)  ·  cp/sp = cos/sin(current_pitch_rad)',
        S['caption']))

    story.append(sp(6))
    story.append(h3('Then knowledge of the sidewalk itself', S))
    story.append(body(
        'Which edge to steer off is not just whichever fired this frame. The left / '
        'right / center choice passes through a hysteresis check so a borderline '
        'confidence a few percent from the switch point cannot flicker the decision '
        'every tick. And the standoff distance used when only one edge is visible is not '
        'a fixed guess — it is half of last_path_width_meters, the sidewalk width Noah '
        'last measured directly, the last time both edges were actually in view '
        'together. That is knowledge carried forward from a previous tick, not a number '
        'invented for this one.', S))
    story.append(sp(4))
    story.append(code(
        'target_offset = chosen_edge_m -/+ side_offset   # side_offset = last_path_width_m / 2\n'
        'x_angle_deg   = atan2(-target_offset, forward_m)', S))

    story.append(sp(6))
    story.append(h3('From boresight-relative to a number Noah can act on', S))
    story.append(body(
        'x_angle_deg says nothing about compass direction — zero means "drive straight '
        'ahead from wherever the camera is currently pointed," not north. carrot.js turns '
        'it into an actual steering command in four steps: flip it to match the chassis '
        'convention (correction_direction), zero it below edge_steer_deadband_deg so '
        'camera noise cannot twitch the wheel, rescale it from the camera\'s working angle '
        'range onto the servo\'s real steering range, and finally ease toward that target '
        'over steering_time_constant_s of real wall-clock time rather than snapping to it '
        '— because the camera itself only reports 7-15 times a second depending on how '
        'busy the Pi is, so a fixed per-tick step would turn Noah at a different '
        'real-world rate depending on system load.', S))
    story.append(sp(4))
    story.append(code(
        'raw     = (edge_guidance_valid ? x_angle_deg : map_angle_deg) * correction_direction\n'
        'raw     = 0 if abs(raw) < edge_steer_deadband_deg else raw\n'
        'clamped = clamp(raw, -sidewalk_steer_input_max_deg, +sidewalk_steer_input_max_deg)\n'
        'target  = (clamped / sidewalk_steer_input_max_deg) * sidewalk_steer_max_deg\n\n'
        'alpha = min(1, elapsed_seconds / steering_time_constant_s)\n'
        'steering_angle_deg += alpha * (target - steering_angle_deg)', S))
    story.append(Paragraph('lib/yellow_brick_road/carrot.js', S['caption']))

    story.append(sp(6))
    story.append(h3('Where heading re-enters: the fallback memory', S))
    story.append(body(
        'One more step happens back in follow_the_yellow_brick_road.js: the carrot '
        'angle, still boresight-relative, is meant to be added to Noah\'s current '
        'compass heading to produce an absolute target heading, remembered every tick as '
        'last_known_carrot_target_hdg. The whole point is a fallback — if the camera '
        'loses the edge completely, Noah should be able to yaw back toward roughly where '
        'the sidewalk last was using the compass instead of going in blind.', S))
    story.append(sp(6))
    story.append(quote(
        'This is where the document\'s own rule had to apply to itself. That line used to '
        'read white_rabbit.motor.carrot_heading_deg — a field nothing in the codebase '
        'ever set. The carrot angle actually lives in motor.steering_angle_deg. '
        'heading + undefined was NaN, every tick, so last_known_carrot_target_hdg was not '
        'yet the memory it was written to be. Not a false edge this time — a false '
        'witness in the wiring between two files. Caught while writing this section, '
        'fixed the same day (2026-07-08): the line now reads '
        'motor.steering_angle_deg, the field carrot.js actually writes.', S))
    story.append(sp(6))
    story.append(body(
        'Everything on this page — the pitch/roll-compensated projection, the '
        'hysteresis-gated edge choice, the learned side offset, the deadband, rescale, '
        'time-constant smoothing, and now the compass-heading fallback memory — is live '
        'and correct on Noah today.', S))

    # -- Section 9: reference table --------------------------------------
    story.append(PageBreak())
    story += section(9, 'REFERENCE', 'Status of Every Decision in This Document', S)
    story.append(ruled_table([
        ['Decision', 'Where', 'Status, as of 2026-07-08'],
        ['Anchor to self, not the frame',
         '_detect_edges_hough',
         'LIVE. Missing-edge mirror anchors at bottom-center, not the frame corner.'],
        ['Verify across motion',
         '_predict_and_score (new)',
         'LIVE. Heading-compensated reprojection residual; can only lower confidence, never raise it.'],
        ['Same-frame band corroboration',
         '_corroborated_pick, _compute_edge_guidance',
         'REMOVED. Unreachable under any shipped config; superseded by the motion check above.'],
        ['Jump-vs-noise EMA reset',
         '_smooth_guidance_obs',
         'REMOVED along with the above. STILL OPEN on the live path -- see Section 3.'],
        ['"Look in the right place" (fixed lookahead band)',
         '_compute_edge_guidance',
         'REMOVED. Live detector uses a different, also-stable route -- see Section 4.'],
        ['carrot_heading_deg fallback memory',
         'follow_the_yellow_brick_road.js',
         'FIXED. Read a field nothing set; now reads motor.steering_angle_deg. See Section 8.'],
    ], [1.9*inch, 1.7*inch, 2.9*inch], mono_col=1))
    story.append(sp(10))
    story.append(body(
        'Nothing in this table is aspirational. Every LIVE row is code that runs on '
        'Noah today; every REMOVED row is code that no longer exists rather than code '
        'left pretending to run; every OPEN row is a real, named gap, not a solved '
        'problem. An earlier draft of this document described three of these rows as '
        'live when they were not — caught and corrected the same day, in the same '
        'spirit the document itself argues for: a claim that cannot be checked against '
        'the actual running code is not yet knowledge.', S))
    story.append(sp(10))
    story.append(HRFlowable(width='100%', thickness=0.8, color=RULE_GOLD, spaceAfter=12))
    story.append(Paragraph(
        'Noah  ·  notip  ·  rover/notip  ·  realsense_ai branch  ·  '
        'Scott Christopher Wilson &amp; Claude  ·  July 8, 2026',
        ParagraphStyle('footer', fontName='Helvetica', fontSize=8,
                       textColor=MID_GREY, alignment=TA_CENTER)))

    doc.build(story, onFirstPage=draw_interior, onLaterPages=draw_interior)


# ============================================================================
#  MAIN
# ============================================================================
def main():
    cover_tmp   = tempfile.NamedTemporaryFile(suffix='_cover.pdf',   delete=False)
    content_tmp = tempfile.NamedTemporaryFile(suffix='_content.pdf', delete=False)
    cover_tmp.close()
    content_tmp.close()

    print('Building cover ...')
    build_cover(cover_tmp.name)

    print('Building content pages ...')
    build_content(content_tmp.name)

    print('Merging ...')
    out = fitz.open()
    for p in [cover_tmp.name, content_tmp.name]:
        src = fitz.open(p)
        out.insert_pdf(src)
        src.close()
    out.save(OUTPUT_PATH)
    out.close()

    os.unlink(cover_tmp.name)
    os.unlink(content_tmp.name)

    print(f'Done -> {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
