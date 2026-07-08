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
    story += section(2, 'ONE VANTAGE POINT', 'Many Witnesses, One Frame', S)
    story.append(body(
        'Every tick, Noah scans several bands of the image at different forward '
        'distances — near, medium, far — looking for the edge in each one. Every '
        'single one of those bands is measured from the exact same place: Noah\'s own '
        'position and heading, right now, this instant. That shared origin is what '
        'makes verification possible at all. A real, physical curb has no choice but '
        'to trace a smoothly consistent line across those bands, because they are all '
        'measurements of the same object from the same eye. A false detection — a '
        'shadow, a seam in the asphalt, a patch of mulch that happens to match — has '
        'no such constraint. It is usually a one-off, agreeing with nothing around it.', S))
    story.append(sp(8))
    story.append(h3('The rule', S))
    story.append(body(
        'Before a candidate point is trusted, Noah checks whether at least one other '
        'band, within a small window of forward distance and lateral position, agrees '
        'with it. If something corroborates it, it is <b>verified</b>. If nothing does, '
        'it is not thrown away — sparse real detections happen too, especially at the '
        'edge of the camera\'s range — but it is trusted less: its confidence is cut in '
        'half rather than treated as certain.', S))
    story.append(sp(6))
    story.append(ruled_table([
        ['Config key', 'Value', 'What it governs'],
        ['edge_corroboration_y_window_m', '0.3 m', 'How close in forward distance a second witness must be'],
        ['edge_corroboration_x_tol_m', '0.15 m', 'How close in lateral position that witness must agree'],
        ['edge_uncorroborated_conf_mult', '0.5', 'Confidence penalty when nothing corroborates a lone reading'],
    ], [2.3*inch, 0.8*inch, 3.4*inch], mono_col=0))
    story.append(sp(8))
    story.append(body(
        'This was proven before it was shipped, not assumed. A test frame was built '
        'where the true edge briefly failed to register at the exact distance Noah '
        'looks first, and a plausible-looking outlier was placed there instead. Picking '
        'whichever point was simply nearest to that distance was fooled immediately. '
        'Requiring a witness rejected the outlier and fell through to the next real, '
        'agreeing point — automatically, with no new sensor and no new assumption '
        'beyond the one Scott named: everything comes from a single point of view, '
        'so a true edge should look like it.', S))

    # -- Section 3 -----------------------------------------------------
    story.append(PageBreak())
    story += section(3, 'RECOGNIZING CHANGE', 'A Real Jump Is Not the Same as Noise', S)
    story.append(body(
        'Noah smooths the edge position tick to tick, so that ordinary camera jitter '
        'does not make him twitch the wheel. That smoothing has a cost: it cannot '
        'natively tell the difference between noise and a real event. When the '
        'sidewalk itself curves — a wave bend, a corner, a reversal — the true edge '
        'position genuinely jumps by a real amount in a single tick. A normal average '
        'cannot tell that apart from jitter, so for several ticks afterward it keeps '
        'blending in the <i>old</i>, now-wrong position, and the steering angle it '
        'produces swings and briefly reverses sign for no reason connected to where '
        'Noah actually is. That misfire was traced exactly, tick by tick, in simulation: '
        'a commanded turn that went from thirty-four degrees to fifteen to negative '
        'fifteen to negative forty-nine across four ticks, purely because the smoothed '
        'value had not caught up to a curve that had already happened.', S))
    story.append(sp(8))
    story.append(h3('The rule', S))
    story.append(body(
        'If a fresh reading differs from the current smoothed value by more than a '
        'threshold — a jump too large to be jitter — Noah stops blending and snaps '
        'straight to the new reading. Ordinary noise still gets smoothed normally. '
        'Only a change large enough to represent something real is allowed to bypass '
        'the average.', S))
    story.append(sp(6))
    story.append(code(
        'if abs(new_reading - smoothed_value) >= edge_ema_reset_jump_m:\n'
        '    smoothed_value = new_reading        # trust it -- this is signal\n'
        'else:\n'
        '    smoothed_value = blend(new_reading, smoothed_value)  # this is noise', S))
    story.append(sp(4))
    story.append(Paragraph('edge_ema_reset_jump_m = 0.3 m', S['caption']))

    # -- Section 4 -----------------------------------------------------
    story.append(PageBreak())
    story += section(4, 'LOOKING IN THE RIGHT PLACE', 'Continuity of Judgment', S)
    story.append(body(
        'Noah does not simply trust whichever band happens to have any detection at '
        'all, nearest to him. That sounds safe but is not: it is a decision that can '
        'flip between two genuinely different real edge points from one tick to the '
        'next, for no reason except which band happened to register something. A '
        'steering signal built on that foundation is unstable even with a perfectly '
        'noiseless camera, before any false edge ever enters the picture.', S))
    story.append(sp(8))
    story.append(h3('The rule', S))
    story.append(body(
        'Noah looks for the band nearest to a fixed, chosen lookahead distance — the '
        'same distance every tick — rather than whichever one is simply closest and '
        'available. This makes the reading a continuous function of where Noah actually '
        'is, instead of a discrete pick that can jump around by chance.', S))

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
        'None of the four rules above ever produce a flat yes or no. Every one of them '
        'produces a number between doubt and certainty, and that number is what steers '
        '— not a verdict. A verified edge, seen by two agreeing witnesses, steers with '
        'full confidence. A lone, uncorroborated reading still steers, just at half '
        'weight. A reading that just survived a real jump is trusted immediately, at '
        'full strength, because the jump itself was the evidence. Nothing is thrown '
        'away merely for being uncertain — Noah cannot afford to go blind every time a '
        'single band is sparse or a single frame is ambiguous — but nothing is trusted '
        'more than the evidence actually earns, either.', S))
    story.append(sp(10))
    story.append(quote(
        '"Since all edges are calculated from a single point of view — the bottom '
        'center of the screen — we should be able to detect outliers, right?"<br/><br/>'
        '— Scott Christopher Wilson', S))
    story.append(sp(6))
    story.append(body(
        'That single sentence is the whole epistemology. One vantage point, one '
        'instant, many witnesses drawn from it. Agreement is how truth is recognized. '
        'A real change is how the world announces itself. And when nothing agrees and '
        'nothing has changed enough to be sure, Noah does not pretend to know — he '
        'steers anyway, carefully, at less than full confidence, exactly as much as '
        'the evidence supports.', S))

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

    # -- Section 8: reference table --------------------------------------
    story.append(PageBreak())
    story += section(8, 'REFERENCE', 'The Four Changes, in One Place', S)
    story.append(ruled_table([
        ['Decision', 'Where', 'What changed'],
        ['Anchor to self, not the frame',
         '_detect_edges_hough',
         'Missing-edge mirror now anchors at bottom-center instead of the frame corner.'],
        ['Look in the right place',
         '_compute_edge_guidance',
         'Band picked nearest to a fixed lookahead distance, not nearest-available.'],
        ['Recognize when the world changed',
         '_smooth_guidance_obs',
         'A jump past edge_ema_reset_jump_m snaps the smoothed value instead of blending.'],
        ['Require a witness',
         '_corroborated_pick (new)',
         'A pick must be corroborated by a neighboring band, or its confidence is halved.'],
    ], [1.5*inch, 1.5*inch, 3.5*inch], mono_col=1))
    story.append(sp(14))
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
