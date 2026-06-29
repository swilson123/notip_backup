#!/usr/bin/env python3
"""
ARROW_ON_THE_DOTTED_LINE.pdf
Mission simulation: GPS nav, sidewalk gate, delivery, IRLock dock return.
Run: python3.9 generate_arrow_pdf.py
"""

import os, io
from reportlab.lib.pagesizes  import letter
from reportlab.lib.units       import inch
from reportlab.lib.colors      import HexColor, white, black
from reportlab.lib.styles      import ParagraphStyle
from reportlab.lib.enums       import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus        import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    HRFlowable, Table, TableStyle, Image, KeepTogether,
)
from reportlab.pdfgen          import canvas as rl_canvas
import fitz

DIR         = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(DIR, 'ARROW_ON_THE_DOTTED_LINE.pdf')
PW, PH      = letter   # 612 × 792 pt

# ── Palette ──────────────────────────────────────────────────────
BG        = HexColor('#0B1018')
SUR       = HexColor('#111923')
BDR       = HexColor('#1D2B3A')
GPS       = HexColor('#5AADFF')
GPS_BG    = HexColor('#0D2540')
SW        = HexColor('#3DD68C')
SW_BG     = HexColor('#0D3323')
YAW       = HexColor('#F5A623')
YAW_BG    = HexColor('#362108')
BUG       = HexColor('#FF5C5C')
BUG_BG    = HexColor('#3A0C0C')
IRLOCK    = HexColor('#C084FC')
IRLOCK_BG = HexColor('#2A1040')
GOLD      = HexColor('#FFD700')
T1        = HexColor('#DCE6F2')
T2        = HexColor('#6B82A0')
T3        = HexColor('#2E4157')
MONO_BG   = HexColor('#080D13')
GREEN_LT  = HexColor('#9FEDD3')

# ── Styles ───────────────────────────────────────────────────────
def S(name, **kw):
    return ParagraphStyle(name, **kw)

EYEBROW = S('eyebrow',  fontName='Courier', fontSize=8,  textColor=GOLD,
            spaceAfter=6,  letterSpacing=2, leading=10)
H1      = S('h1',       fontName='Helvetica-Bold', fontSize=22, textColor=T1,
            spaceAfter=10, leading=28)
SUBH    = S('subh',     fontName='Helvetica-Bold', fontSize=13, textColor=T1,
            spaceAfter=8,  leading=17)
BODY    = S('body',     fontName='Helvetica', fontSize=11, textColor=T2,
            spaceAfter=6,  leading=16)
SMALL   = S('small',    fontName='Courier',   fontSize=9,  textColor=T2,
            spaceAfter=4,  leading=13)
MONO    = S('mono',     fontName='Courier',   fontSize=9,  textColor=T2,
            spaceAfter=3,  leading=14)
MONO_OK = S('mono_ok',  fontName='Courier',   fontSize=9,  textColor=SW,
            spaceAfter=2,  leading=14)
MONO_WA = S('mono_wa',  fontName='Courier',   fontSize=9,  textColor=YAW,
            spaceAfter=2,  leading=14)
MONO_LK = S('mono_lk',  fontName='Courier',   fontSize=9,  textColor=IRLOCK,
            spaceAfter=2,  leading=14)
MONO_GP = S('mono_gp',  fontName='Courier',   fontSize=9,  textColor=GPS,
            spaceAfter=2,  leading=14)
MONO_CM = S('mono_cm',  fontName='Courier',   fontSize=9,  textColor=T3,
            spaceAfter=2,  leading=14)
MONO_HI = S('mono_hi',  fontName='Courier',   fontSize=9,  textColor=GOLD,
            spaceAfter=2,  leading=14)
MONO_GR = S('mono_gr',  fontName='Courier',   fontSize=9,  textColor=GREEN_LT,
            spaceAfter=2,  leading=14)
SECT    = S('sect',     fontName='Courier',   fontSize=8,  textColor=T3,
            spaceAfter=4,  letterSpacing=1)
LABEL   = S('label',    fontName='Courier',   fontSize=8,  textColor=T3,
            spaceAfter=4,  leading=11)
PHASE_T = S('phaset',   fontName='Helvetica-Bold', fontSize=12, textColor=T1,
            spaceAfter=4,  leading=16)
VERDICT = S('verdict',  fontName='Courier',   fontSize=10, textColor=SW,
            spaceAfter=4,  leading=14)
FIX_T   = S('fix_t',    fontName='Helvetica-Bold', fontSize=12, textColor=SW,
            spaceAfter=6,  leading=16)
FIX_B   = S('fix_b',    fontName='Helvetica',  fontSize=10, textColor=GREEN_LT,
            spaceAfter=4,  leading=15)


# ════════════════════════════════════════════════════════════════
#  COVER — pure canvas
# ════════════════════════════════════════════════════════════════
def build_cover(path):
    cv = rl_canvas.Canvas(path, pagesize=letter)
    W, H = PW, PH

    # background
    cv.setFillColor(BG)
    cv.rect(0, 0, W, H, fill=1, stroke=0)

    # grid lines (subtle)
    cv.setStrokeColor(HexColor('#0E1520'))
    cv.setLineWidth(0.4)
    step = 50
    for x in range(0, int(W)+step, step):
        cv.line(x, 0, x, H)
    for y in range(0, int(H)+step, step):
        cv.line(0, y, W, y)

    # IRLock beacon glow at top-right
    for r, a in [(80, 0.04), (55, 0.07), (35, 0.12), (20, 0.2)]:
        cv.setFillColor(HexColor('#C084FC'))
        cv.setFillAlpha(a)
        cv.circle(W - 1.1*inch, H - 1.0*inch, r, fill=1, stroke=0)
    cv.setFillAlpha(1)

    # gold rule top
    cv.setStrokeColor(GOLD)
    cv.setLineWidth(1.5)
    cv.line(0.7*inch, H - 0.9*inch, W - 0.7*inch, H - 0.9*inch)

    # eyebrow
    cv.setFont('Courier', 8)
    cv.setFillColor(GOLD)
    cv.drawString(0.75*inch, H - 1.25*inch,
                  'MISSION SIMULATION  ·  NOAH ROVER  ·  FULL ROUND TRIP')

    # main title
    cv.setFont('Helvetica-Bold', 38)
    cv.setFillColor(T1)
    cv.drawString(0.75*inch, H - 2.0*inch, 'Arrow on the')
    cv.drawString(0.75*inch, H - 2.6*inch, 'Dotted Line')

    # gold rule
    cv.setStrokeColor(GOLD)
    cv.setLineWidth(1.0)
    cv.line(0.75*inch, H - 2.9*inch, W - 0.75*inch, H - 2.9*inch)

    # description
    cv.setFont('Helvetica', 12)
    cv.setFillColor(T2)
    cv.drawString(0.75*inch, H - 3.35*inch,
                  'Seven waypoints. Dock → driveway → sidewalk gate →')
    cv.drawString(0.75*inch, H - 3.6*inch,
                  'delivery → return → IRLock precision dock.')
    cv.drawString(0.75*inch, H - 3.85*inch,
                  'Every code path traced tick by tick.')

    # stats row
    stats = [
        ('7',       'WAYPOINTS'),
        ('~104 m',  'OUTBOUND'),
        ('96°',     'GATE TURN'),
        ('9',       'CODE PHASES'),
        ('250 ms',  'LOOP TICK'),
    ]
    sx = 0.75*inch
    sy = H - 4.8*inch
    for val, lbl in stats:
        # box
        cv.setFillColor(SUR)
        cv.setStrokeColor(BDR)
        cv.setLineWidth(0.5)
        cv.roundRect(sx, sy - 0.15*inch, 1.05*inch, 0.65*inch, 4, fill=1, stroke=1)
        # value
        cv.setFont('Courier-Bold', 18)
        cv.setFillColor(T1)
        cv.drawString(sx + 0.1*inch, sy + 0.3*inch, val)
        # label
        cv.setFont('Courier', 7)
        cv.setFillColor(T2)
        cv.drawString(sx + 0.1*inch, sy - 0.08*inch, lbl)
        sx += 1.15*inch

    # gold rule bottom
    cv.setStrokeColor(HexColor('#2E4157'))
    cv.setLineWidth(0.5)
    cv.line(0.75*inch, 1.2*inch, W - 0.75*inch, 1.2*inch)

    # footer
    cv.setFont('Courier', 8)
    cv.setFillColor(T3)
    cv.drawString(0.75*inch, 0.9*inch, 'Noah Rover  ·  2026')
    cv.drawRightString(W - 0.75*inch, 0.9*inch, 'run_mission.js simulation')

    cv.save()


# ════════════════════════════════════════════════════════════════
#  SVG MAP → PNG bytes (via PyMuPDF)
# ════════════════════════════════════════════════════════════════
SVG_SRC = b"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 230" width="900" height="460"
     style="background:#0B1018">
  <defs>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="beacon" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- background -->
  <rect width="450" height="230" fill="#0B1018"/>

  <!-- Grid 50px = 10m -->
  <g stroke="#1D2B3A" stroke-width="0.5">
    <line x1="30"  y1="0" x2="30"  y2="230"/>
    <line x1="80"  y1="0" x2="80"  y2="230"/>
    <line x1="130" y1="0" x2="130" y2="230"/>
    <line x1="180" y1="0" x2="180" y2="230"/>
    <line x1="230" y1="0" x2="230" y2="230"/>
    <line x1="280" y1="0" x2="280" y2="230"/>
    <line x1="330" y1="0" x2="330" y2="230"/>
    <line x1="380" y1="0" x2="380" y2="230"/>
    <line x1="430" y1="0" x2="430" y2="230"/>
    <line x1="0" y1="30"  x2="450" y2="30"/>
    <line x1="0" y1="80"  x2="450" y2="80"/>
    <line x1="0" y1="130" x2="450" y2="130"/>
    <line x1="0" y1="180" x2="450" y2="180"/>
  </g>

  <!-- Road surfaces -->
  <polyline points="80,15 80,40 70,140" fill="none" stroke="#19293C"
            stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="70,140 130,140 205,140 280,120 355,120" fill="none"
            stroke="#152338" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Zone labels -->
  <text font-family="Courier New,monospace" font-size="7.5" fill="#253C55" letter-spacing="1"
        x="74" y="80" transform="rotate(-80, 74, 80)">DRIVEWAY</text>
  <text x="200" y="135" text-anchor="middle" font-family="Courier New,monospace"
        font-size="7" fill="#1E3C58" letter-spacing="1.5">SIDEWALK</text>

  <!-- OUTBOUND PATH (gold dashed) -->
  <polyline points="80,15 80,40 70,140 130,140 205,140 280,120 355,120"
    fill="none" stroke="#FFD700" stroke-width="1.8" stroke-dasharray="5 4"
    filter="url(#glow)" opacity="0.9"/>

  <!-- RETURN PATH (green offset) -->
  <polyline points="355,125 280,125 205,145 130,145 75,145 75,40 80,15"
    fill="none" stroke="#3DD68C" stroke-width="1.3" stroke-dasharray="3 4" opacity="0.55"/>

  <!-- Return arrowheads -->
  <polygon points="248,142 257,145 248,148" fill="#3DD68C" opacity="0.6"/>
  <polygon points="150,142 159,145 150,148" fill="#3DD68C" opacity="0.6"/>
  <polygon points="72,82 75,74 78,82"       fill="#3DD68C" opacity="0.6"/>

  <!-- WP0 dock -->
  <circle cx="80" cy="15" r="14" fill="none" stroke="#C084FC" stroke-width="0.8"
          opacity="0.25" filter="url(#beacon)"/>
  <circle cx="80" cy="15" r="8"  fill="#0B1018" stroke="#5AADFF" stroke-width="2"/>
  <text x="80" y="19.5" text-anchor="middle" font-size="9" fill="#5AADFF"
        font-family="Courier New,monospace">H</text>
  <text x="91" y="13" font-size="7.5" fill="#5AADFF" font-family="Courier New,monospace">DOCK</text>

  <!-- WP1 -->
  <circle cx="80" cy="40" r="4"  fill="#0B1018" stroke="#2E4560" stroke-width="1.5"/>
  <text x="86" y="43" font-size="7" fill="#2E4560" font-family="Courier New,monospace">wp1</text>

  <!-- WP2 gate -->
  <circle cx="70" cy="140" r="7.5" fill="#0B1018" stroke="#F5A623" stroke-width="2"/>
  <text x="70" y="144" text-anchor="middle" font-size="8" fill="#F5A623"
        font-family="Courier New,monospace" font-weight="bold">2</text>
  <text x="38" y="152" text-anchor="end" font-size="7.5" fill="#F5A623"
        font-family="Courier New,monospace">GATE</text>

  <!-- WP3-5 -->
  <circle cx="130" cy="140" r="5" fill="#0B1018" stroke="#3A5A72" stroke-width="1.5"/>
  <text x="130" y="144" text-anchor="middle" font-size="7" fill="#3A5A72"
        font-family="Courier New,monospace">3</text>
  <circle cx="205" cy="140" r="5" fill="#0B1018" stroke="#3A5A72" stroke-width="1.5"/>
  <text x="205" y="144" text-anchor="middle" font-size="7" fill="#3A5A72"
        font-family="Courier New,monospace">4</text>
  <circle cx="280" cy="120" r="5" fill="#0B1018" stroke="#3A5A72" stroke-width="1.5"/>
  <text x="280" y="124" text-anchor="middle" font-size="7" fill="#3A5A72"
        font-family="Courier New,monospace">5</text>

  <!-- WP6 delivery -->
  <circle cx="355" cy="120" r="7.5" fill="#0B1018" stroke="#F5A623" stroke-width="2"/>
  <text x="355" y="124" text-anchor="middle" font-size="8" fill="#F5A623"
        font-family="Courier New,monospace" font-weight="bold">6</text>
  <text x="355" y="137" text-anchor="middle" font-size="7" fill="#F5A623"
        font-family="Courier New,monospace">DELIVERY</text>

  <!-- Arrow A: GPS nav outbound (south) -->
  <g transform="translate(75,88) rotate(186)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#5AADFF"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#5AADFF" stroke-width="1.5"/>
  </g>
  <line x1="58" y1="88" x2="68" y2="88" stroke="#5AADFF" stroke-width="0.8"
        stroke-dasharray="2 2" opacity="0.6"/>
  <text x="57" y="83" text-anchor="end" font-size="8" fill="#5AADFF"
        font-family="Courier New,monospace">A GPS nav</text>
  <text x="57" y="93" text-anchor="end" font-size="7.5" fill="#5AADFF"
        font-family="Courier New,monospace" opacity="0.75">hdg 186 S</text>

  <!-- Spin ring WP2 -->
  <circle cx="70" cy="140" r="17" fill="none" stroke="#F5A623" stroke-width="1"
          stroke-dasharray="3 2.5" opacity="0.5"/>

  <!-- Arrow B: post-yaw gate open (east) -->
  <g transform="translate(70,140) rotate(90)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#F5A623"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#F5A623" stroke-width="1.5"/>
  </g>
  <line x1="38" y1="130" x2="51" y2="133" stroke="#F5A623" stroke-width="0.8"
        stroke-dasharray="2 2" opacity="0.6"/>
  <text x="37" y="127" text-anchor="end" font-size="8" fill="#F5A623"
        font-family="Courier New,monospace">B 96deg yaw</text>
  <text x="37" y="137" text-anchor="end" font-size="7.5" fill="#F5A623"
        font-family="Courier New,monospace" opacity="0.75">gate opens</text>

  <!-- Arrow C: sidewalk outbound (east) -->
  <g transform="translate(167,140) rotate(90)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#3DD68C"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#3DD68C" stroke-width="1.5"/>
  </g>
  <text x="167" y="158" text-anchor="middle" font-size="8" fill="#3DD68C"
        font-family="Courier New,monospace">C camera</text>
  <text x="167" y="168" text-anchor="middle" font-size="7.5" fill="#3DD68C"
        font-family="Courier New,monospace" opacity="0.75">sidewalk -&gt;</text>

  <!-- Spin ring WP6 -->
  <circle cx="355" cy="120" r="17" fill="none" stroke="#F5A623" stroke-width="1"
          stroke-dasharray="3 2.5" opacity="0.5"/>

  <!-- Arrow D: delivery yaw (west) -->
  <g transform="translate(355,120) rotate(270)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#F5A623"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#F5A623" stroke-width="1.5"/>
  </g>
  <text x="376" y="113" font-size="7.5" fill="#F5A623"
        font-family="Courier New,monospace">D delivery</text>
  <text x="376" y="123" font-size="7.5" fill="#F5A623"
        font-family="Courier New,monospace">yaw + drop</text>

  <!-- Arrow E: return sidewalk (west) -->
  <g transform="translate(242,145) rotate(270)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#3DD68C"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#3DD68C" stroke-width="1.5"/>
  </g>
  <text x="242" y="163" text-anchor="middle" font-size="8" fill="#3DD68C"
        font-family="Courier New,monospace">E return</text>
  <text x="242" y="173" text-anchor="middle" font-size="7.5" fill="#3DD68C"
        font-family="Courier New,monospace" opacity="0.75">&lt;- sidewalk</text>

  <!-- Arrow F: IRLock (north) -->
  <g transform="translate(80,40) rotate(0)">
    <polygon points="0,-10 -5.5,7 5.5,7" fill="#C084FC"/>
    <line x1="0" y1="-10" x2="0" y2="-15" stroke="#C084FC" stroke-width="1.5"/>
  </g>
  <text x="91" y="37" font-size="7.5" fill="#C084FC"
        font-family="Courier New,monospace">F IRLock</text>
  <text x="91" y="47" font-size="7.5" fill="#C084FC"
        font-family="Courier New,monospace">align+dock</text>

  <!-- Compass -->
  <line x1="425" y1="40" x2="425" y2="14" stroke="#273C53" stroke-width="1.5"/>
  <polygon points="425,11 422,20 428,20" fill="#273C53"/>
  <text x="425" y="50" text-anchor="middle" font-size="9" fill="#273C53"
        font-family="Courier New,monospace">N</text>

  <!-- Scale bar -->
  <line x1="365" y1="215" x2="390" y2="215" stroke="#273C53" stroke-width="1.5"/>
  <line x1="365" y1="211" x2="365" y2="219" stroke="#273C53" stroke-width="1.5"/>
  <line x1="390" y1="211" x2="390" y2="219" stroke="#273C53" stroke-width="1.5"/>
  <text x="377" y="210" text-anchor="middle" font-size="7.5" fill="#273C53"
        font-family="Courier New,monospace">5 m</text>
</svg>
"""


def svg_to_img(svg_bytes, width_pts, height_pts):
    """Render SVG to a ReportLab Image flowable."""
    doc  = fitz.open('svg', svg_bytes)
    page = doc[0]
    mat  = fitz.Matrix(2.0, 2.0)      # 2× for sharpness
    pix  = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
    png  = pix.tobytes('png')
    doc.close()
    buf = io.BytesIO(png)
    return Image(buf, width=width_pts, height=height_pts)


# ════════════════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════════════════
def dark_bg_canvas(c, doc):
    """Page background callback for SimpleDocTemplate."""
    c.saveState()
    c.setFillColor(BG)
    c.rect(0, 0, PW, PH, fill=1, stroke=0)
    # subtle grid
    c.setStrokeColor(HexColor('#0E1520'))
    c.setLineWidth(0.3)
    for x in range(0, int(PW)+50, 50):
        c.line(x, 0, x, PH)
    for y in range(0, int(PH)+50, 50):
        c.line(0, y, PW, y)
    # footer
    c.setFont('Courier', 7)
    c.setFillColor(T3)
    c.drawString(0.6*inch, 0.45*inch, 'Noah Rover  ·  Arrow on the Dotted Line')
    c.drawRightString(PW - 0.6*inch, 0.45*inch, f'run_mission.js simulation')
    c.restoreState()


def divider(color=BDR):
    return HRFlowable(width='100%', thickness=0.5, color=color, spaceAfter=10, spaceBefore=10)


def section_label(txt):
    return Paragraph(txt.upper(), SECT)


def phase_block(num, title, wp_range, verdict_txt, verdict_color, phase_color,
                code_lines, kv_pairs, accent):
    """Build a phase block as a Table-based card."""
    items = []

    # header row
    header_style = ParagraphStyle('phh', fontName='Helvetica-Bold', fontSize=12,
                                  textColor=T1, leading=16)
    wp_style     = ParagraphStyle('wpw', fontName='Courier',         fontSize=9,
                                  textColor=T2, leading=12,
                                  backColor=BDR, borderPadding=2)
    v_style      = ParagraphStyle('vrd', fontName='Courier',         fontSize=10,
                                  textColor=verdict_color, leading=14)

    hdr_table = Table([
        [Paragraph(f'{num}  {title}', header_style),
         Paragraph(wp_range, wp_style),
         Paragraph(verdict_txt, v_style)]
    ], colWidths=[None, 1.4*inch, 1.4*inch])
    hdr_table.setStyle(TableStyle([
        ('ALIGN',  (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',    (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))

    # code column
    code_paras = []
    for kind, line in code_lines:
        st = {'k': MONO_HI, 'ok': MONO_OK, 'wa': MONO_WA,
              'er': MONO_WA, 'gp': MONO_GP, 'lk': MONO_LK,
              'cm': MONO_CM, '': MONO}.get(kind, MONO)
        code_paras.append(Paragraph(line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), st))

    # kv column
    kv_paras = []
    for kk, vv, vc in kv_pairs:
        vs = ParagraphStyle('kvc', fontName='Courier', fontSize=9,
                            textColor=vc, leading=14)
        ks = ParagraphStyle('kvk', fontName='Courier', fontSize=9,
                            textColor=T2, leading=14)
        kv_paras.append(Paragraph(f'<b>{kk}</b>', ks))
        kv_paras.append(Paragraph(vv, vs))
        kv_paras.append(Spacer(1, 2))

    body_table = Table(
        [[code_paras, kv_paras]],
        colWidths=[3.5*inch, 2.9*inch]
    )
    body_table.setStyle(TableStyle([
        ('ALIGN',       (0,0), (-1,-1), 'LEFT'),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
        ('BACKGROUND',  (0,0), (0,0), MONO_BG),
        ('BACKGROUND',  (1,0), (1,0), SUR),
        ('BOX',         (0,0), (0,0), 0.5, BDR),
        ('BOX',         (1,0), (1,0), 0.5, BDR),
        ('TOPPADDING',    (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING',   (0,0), (-1,-1), 8),
        ('RIGHTPADDING',  (0,0), (-1,-1), 8),
    ]))

    outer = Table([[hdr_table], [body_table]], colWidths=[6.6*inch])
    outer.setStyle(TableStyle([
        ('ALIGN',       (0,0), (-1,-1), 'LEFT'),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
        ('BACKGROUND',  (0,0), (-1,-1), SUR),
        ('BOX',         (0,0), (-1,-1), 0.5, BDR),
        ('LINEBEFORE',  (0,0), (0,-1), 3.0, accent),
        ('TOPPADDING',    (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('LEFTPADDING',   (0,0), (-1,-1), 0),
        ('RIGHTPADDING',  (0,0), (-1,-1), 0),
    ]))
    return KeepTogether([outer, Spacer(1, 10)])


# ════════════════════════════════════════════════════════════════
#  CONTENT
# ════════════════════════════════════════════════════════════════
def build_content(path):
    doc = SimpleDocTemplate(
        path,
        pagesize=letter,
        leftMargin=0.65*inch, rightMargin=0.65*inch,
        topMargin=0.75*inch,  bottomMargin=0.75*inch,
        onFirstPage=dark_bg_canvas, onLaterPages=dark_bg_canvas,
    )

    story = []

    # ── PAGE HEADER ─────────────────────────────────────────────
    story.append(Paragraph('MISSION SIMULATION · NOAH ROVER · FULL ROUND TRIP', EYEBROW))
    story.append(Paragraph('Arrow on the Dotted Line', H1))
    story.append(Paragraph(
        'Seven waypoints. Dock → driveway → sidewalk gate → delivery → return → '
        'IRLock precision dock. Every code path traced tick by tick.', BODY))
    story.append(divider(GOLD))
    story.append(Spacer(1, 8))

    # ── WAYPOINTS TABLE ─────────────────────────────────────────
    story.append(section_label('Route Waypoints'))
    story.append(Spacer(1, 4))

    wp_hdr_st = ParagraphStyle('wph', fontName='Courier', fontSize=8.5,
                               textColor=T2, leading=12)
    wp_cel_st = ParagraphStyle('wpc', fontName='Courier', fontSize=9,
                               textColor=T1, leading=13)

    def badge(txt, fg, bg):
        return Paragraph(
            f'<font color="#{fg[1:]}">{txt}</font>',
            ParagraphStyle('badge', fontName='Courier-Bold', fontSize=8,
                           textColor=HexColor(fg), backColor=HexColor(bg),
                           leading=12, borderPadding=2))

    wp_data = [
        [Paragraph(h, wp_hdr_st) for h in ['SEQ','LATITUDE','LONGITUDE','DIST TO NEXT','ROLE']],
        ['0', '33.74900', '-84.38800', '2 m',            badge('Dock (skip)', '#5AADFF', '#0D2540')],
        ['1', '33.74898', '-84.38800', '20 m S + 2 m W', badge('Undock pos',  '#5AADFF', '#0D2540')],
        ['2', '33.74880', '-84.38802', '12 m E',          badge('GATE · 96° turn', '#F5A623', '#362108')],
        ['3', '33.74880', '-84.38789', '15 m E',          badge('Sidewalk', '#3DD68C', '#0D3323')],
        ['4', '33.74880', '-84.38773', '15 m E + 4 m N',  badge('Sidewalk', '#3DD68C', '#0D3323')],
        ['5', '33.74884', '-84.38757', '15 m E',          badge('Sidewalk', '#3DD68C', '#0D3323')],
        ['6', '33.74884', '-84.38741', '—',                badge('Delivery', '#FF5C5C', '#3A0C0C')],
    ]
    for i, row in enumerate(wp_data[1:], 1):
        wp_data[i] = [Paragraph(str(v), wp_cel_st) if isinstance(v, str) else v for v in row]

    wp_table = Table(wp_data, colWidths=[0.4*inch, 1.1*inch, 1.1*inch, 1.55*inch, 1.95*inch])
    wp_style = TableStyle([
        ('BACKGROUND',    (0,0), (-1,0), SUR),
        ('TEXTCOLOR',     (0,0), (-1,0), T2),
        ('ALIGN',         (0,0), (-1,-1), 'LEFT'),
        ('VALIGN',        (0,0), (-1,-1), 'MIDDLE'),
        ('BOX',           (0,0), (-1,-1), 0.5, BDR),
        ('INNERGRID',     (0,0), (-1,-1), 0.3, BDR),
        ('ROWBACKGROUNDS',(0,1), (-1,-1), [SUR, HexColor('#0D1520')]),
        ('TOPPADDING',    (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING',   (0,0), (-1,-1), 7),
        ('RIGHTPADDING',  (0,0), (-1,-1), 7),
    ])
    wp_table.setStyle(wp_style)
    story.append(wp_table)
    story.append(Spacer(1, 18))

    # ── SVG MAP ─────────────────────────────────────────────────
    story.append(section_label("Bird's-Eye Route Map"))
    story.append(Spacer(1, 4))
    story.append(Paragraph('5 px / m  ·  North ↑  ·  East →  ·  gold = outbound  ·  green = return', SMALL))
    story.append(Spacer(1, 6))

    map_img = svg_to_img(SVG_SRC, 6.5*inch, 3.33*inch)
    story.append(map_img)
    story.append(Spacer(1, 8))

    # legend row
    legend_items = [
        ('A — GPS nav (outbound)',  GPS),
        ('B — 96° yaw · gate opens', YAW),
        ('C — sidewalk outbound',   SW),
        ('D — delivery yaw · drop', YAW),
        ('E — sidewalk return',     SW),
        ('F — IRLock align · dock', IRLOCK),
    ]
    leg_data = [[Paragraph(f'● {txt}',
                           ParagraphStyle('leg', fontName='Courier', fontSize=8,
                                          textColor=clr, leading=12))
                 for txt, clr in legend_items[:3]],
                [Paragraph(f'● {txt}',
                           ParagraphStyle('leg', fontName='Courier', fontSize=8,
                                          textColor=clr, leading=12))
                 for txt, clr in legend_items[3:]]]
    leg_table = Table(leg_data, colWidths=[2.2*inch]*3)
    leg_table.setStyle(TableStyle([
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('TOPPADDING',    (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING',   (0,0), (-1,-1), 5),
    ]))
    story.append(leg_table)
    story.append(Spacer(1, 20))
    story.append(divider())

    # ── PHASE TRACE ─────────────────────────────────────────────
    story.append(Spacer(1, 8))
    story.append(Paragraph('Code Trace — Phase by Phase', SUBH))
    story.append(Spacer(1, 10))

    # Phase ①
    story.append(phase_block(
        '①', 'Driveway — GPS Navigation', 'WP0 → WP2', '✓  on track', SW, GPS,
        [
            ('k',  'follow_sidewalk_enabled = false'),
            ('cm', '// gate not open — skip FTYBR'),
            ('',   ''),
            ('k',  'nav_yaw = bearing_to_WP2 - heading'),
            ('k',  'crosstrack = get_gps_crosstrack_bias_deg()'),
            ('k',  'steering = nav_yaw x 0.4 + crosstrack'),
            ('',   'two_wheel Ackermann -> forward'),
        ],
        [
            ('sidewalk_follow_active', 'false',    T3),
            ('current_mission_seq',   '1 -> 2',   GPS),
            ('yaw_to_waypoint',       '~= 0 deg', GPS),
            ('max_steer',             '6° (clamped)', GPS),
        ],
        GPS
    ))

    # Phase ②
    story.append(phase_block(
        '②', 'Gate Arrival', 'WP2 arrival', '↻  yaw pending', YAW, YAW,
        [
            ('k',  'is_sidewalk_gate_waypoint(seq=2)'),
            ('cm', '// 96° turn >= 90° -> true'),
            ('k',  'sidewalk_gate_pending = true'),
            ('',   ''),
            ('',   'look_ahead WP3: bearing = 90° E'),
            ('',   'current heading = 186° S'),
            ('wa', 'yaw_error = -96°'),
            ('k',  'needs_stop = |96°| > 90 -> true'),
            ('wa', 'advance seq -> 3, stop motors'),
        ],
        [
            ('sidewalk_gate_pending',  'true',  YAW),
            ('sidewalk_follow_active', 'false', T3),
            ('current_mission_seq',    '3',     YAW),
            ('yaw_to_waypoint',        '-96°',  YAW),
        ],
        YAW
    ))

    # Phase ③
    story.append(phase_block(
        '③', 'Four-Wheel Yaw → Gate Opens', 'WP2, spinning', '✓  gate opens', SW, YAW,
        [
            ('k',  'mission_yaw_abs = 96° > start(90°)'),
            ('k',  'mission_yaw_should_run = true'),
            ('wa', 'steering_type -> four_wheels'),
            ('wa', 'yaw_white_rabbit(wr, -96°)'),
            ('cm', '// spins CCW toward east'),
            ('',   ''),
            ('cm', '// yaw_abs <= 6° x 3 stable ticks:'),
            ('ok', 'four_wheels -> two_wheels'),
            ('k',  'sidewalk_gate_pending -> false'),
            ('ok', 'sidewalk_follow_active = true'),
        ],
        [
            ('sidewalk_gate_pending',  'false',     SW),
            ('sidewalk_follow_active', 'true',      SW),
            ('heading',                '~= 90° E',  SW),
            ('steering_type',          'two_wheels', SW),
            ('edge_trail',             'started',   SW),
        ],
        YAW
    ))

    # Phase ④
    story.append(phase_block(
        '④', 'Sidewalk — Camera Steering', 'WP3 → WP5', '✓  camera guides', SW, SW,
        [
            ('ok', 'follow_sidewalk_enabled() = true'),
            ('k',  '_yield_delivery = false  // seq <= max'),
            ('ok', '-> follow_the_yellow_brick_road(wr)'),
            ('ok', '-> return'),
            ('',   ''),
            ('',   'camera: edge 0.61 m ahead'),
            ('',   'steer 1.5 ft off left edge'),
            ('',   'FTYBR: seq++ when dist < 1m to WP'),
            ('cm', '// advances WP3->4->5 internally'),
        ],
        [
            ('sidewalk_follow_active', 'true',         SW),
            ('seq advances via',       'FTYBR internal', SW),
            ('camera edge',            'guiding',       SW),
            ('GPS / LiDAR',            'still active',  SW),
        ],
        SW
    ))

    # Phase ⑤
    story.append(phase_block(
        '⑤', 'Delivery — Option B Yield', 'WP6 → seq 7', '✓  delivers', SW, BUG,
        [
            ('cm', '// FTYBR: within 1m of WP6'),
            ('k',  'current_mission_seq++ -> 7'),
            ('',   ''),
            ('cm', '// next tick:'),
            ('k',  '_yield_delivery: 7 > max(6) -> true'),
            ('cm', '// FTYBR skipped, no return'),
            ('',   'GPS nav: seq=7 -> no waypoint'),
            ('k',  'waypoint.latitude = null'),
            ('ok', '-> yaw_for_package_delivery()'),
            ('ok', 'spin to WP5 bearing -> drop [check]'),
        ],
        [
            ('current_mission_seq',     '7 (past max)',  YAW),
            ('_yield_delivery',         'true',          SW),
            ('finished_package_yaw',    '-> true',       SW),
            ('package_delivered',       '-> true',       SW),
            ('_post_delivery_yaw_carry','true',          SW),
        ],
        BUG
    ))

    # divider
    story.append(Spacer(1, 6))
    div_style = ParagraphStyle('div', fontName='Courier', fontSize=9,
                               textColor=T3, alignment=TA_CENTER, leading=14)
    story.append(Paragraph('─ ─ ─  RETURN TRIP  ─ ─ ─', div_style))
    story.append(Spacer(1, 6))

    # Phase ⑥
    story.append(phase_block(
        '⑥', 'Return — Sidewalk West', 'WP5 → WP2', '✓  camera guides', SW, SW,
        [
            ('k',  'arduino_msg: current_mission_seq -= 2 -> 5'),
            ('ok', 'package_delivered = true'),
            ('',   ''),
            ('ok', 'follow_sidewalk_enabled() = true'),
            ('k',  '_yield_delivery = false  // delivered'),
            ('ok', '-> follow_the_yellow_brick_road(wr)'),
            ('ok', '-> return'),
            ('',   ''),
            ('',   'FTYBR: seq-- when dist < 1m to WP'),
            ('cm', '// reverse: WP5->4->3->gate(WP2)'),
        ],
        [
            ('package_delivered',    'true',             SW),
            ('sidewalk_follow_active','true',            SW),
            ('return_trail_reset',   '-> true (1st tick)', SW),
            ('edge_trail',           'restarted',        SW),
        ],
        SW
    ))

    # Phase ⑦
    story.append(phase_block(
        '⑦', 'Gate Closes — GPS Home', 'WP2 → WP1', '✓  on track', SW, GPS,
        [
            ('',   'arrive WP2 (return): seq=2'),
            ('k',  'is_sidewalk_gate_waypoint(2) = true'),
            ('ok', 'package_delivered = true'),
            ('ok', '-> sidewalk_follow_active = false'),
            ('cm', '// gate closes'),
            ('',   ''),
            ('ok', 'follow_sidewalk_enabled() = false'),
            ('',   'GPS nav takes over'),
            ('gp', '-> navigate to undock position (WP1)'),
            ('',   'nav_yaw + crosstrack -> two_wheel'),
        ],
        [
            ('sidewalk_follow_active', 'false',         SW),
            ('current_mission_seq',    '2 -> 1',        GPS),
            ('nav mode',               'GPS two-wheel', GPS),
            ('target',                 'undock lat/lng', GPS),
        ],
        GPS
    ))

    # Phase ⑧
    story.append(phase_block(
        '⑧', 'Dock Approach — Heading Align', 'WP1 arrival', '↻  seeking beacon', IRLOCK, IRLOCK,
        [
            ('',   'arrive undock pos: seq <= 1'),
            ('lk', "-> dock_return_phase = 'align_heading'"),
            ('',   ''),
            ('cm', '// each tick:'),
            ('k',  '_light_found = irlock.detected + is_fresh'),
            ('',   ''),
            ('',   'if light found + |angle_x| <= 5°:'),
            ('lk', '  -> _begin_dock_handoff()'),
            ('lk', "  -> stop spin, phase = 'docking'"),
            ('',   'else:'),
            ('k',  '  yaw toward undock_heading'),
            ('',   '  timeout 30s -> proceed blind'),
        ],
        [
            ('dock_return_phase', "'align_heading'",    IRLOCK),
            ('undock_heading',    'recorded on depart', IRLOCK),
            ('irlock.detected',   'polling',            IRLOCK),
            ('yaw_speed',         'proportional 10-18', IRLOCK),
        ],
        IRLOCK
    ))

    # Phase ⑨
    story.append(phase_block(
        '⑨', 'IRLock — Precision Dock', "dock_state -> docked", '[H]  home', IRLOCK, IRLOCK,
        [
            ('lk', "dock_return_phase = 'docking'"),
            ('lk', 'setInterval(follow_the_light, 250)'),
            ('cm', '// separate 250ms loop — IRLock steers'),
            ('',   ''),
            ('',   'irlock.target.angle_x -> steer'),
            ('',   'irlock.target.size -> throttle'),
            ('',   ''),
            ('',   'size >= size_stop_threshold:'),
            ('ok', "  stop motors, dock_state = 'docked'"),
            ('',   ''),
            ('',   "run_mission sees dock_state = 'docked'"),
            ('ok', '-> clearInterval(mission_interval)'),
            ('ok', '-> mission complete'),
        ],
        [
            ('dock_return_phase',  "'docking'",       IRLOCK),
            ('follow_the_light',   'running at 250ms', IRLOCK),
            ('steer src',          'irlock.target.angle_x', IRLOCK),
            ('stop src',           'irlock.target.size', IRLOCK),
            ('dock_state',         "-> 'docked'",     SW),
            ('mission_interval',   'cleared',         SW),
        ],
        IRLOCK
    ))

    story.append(Spacer(1, 16))
    story.append(divider(SW))
    story.append(Spacer(1, 10))

    # ── FIX BOX ─────────────────────────────────────────────────
    story.append(Paragraph('✓  Option B — Applied to run_mission.js', FIX_T))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        'Inside the <font name="Courier" color="#FFD700">follow_sidewalk_enabled</font> guard, '
        'a yield check detects when FTYBR has advanced '
        '<font name="Courier" color="#FFD700">current_mission_seq</font> past the last waypoint '
        '(within 1 m of WP6). When true it skips FTYBR so the GPS nav else-branch reaches '
        '<font name="Courier" color="#FFD700">yaw_for_package_delivery</font>. '
        'No changes to FTYBR, no changes to the delivery sequence itself.', FIX_B))
    story.append(Spacer(1, 8))

    patch_lines = [
        ('cm', '// Yield delivery to GPS nav: FTYBR advances seq past max when Noah'),
        ('cm', '// arrives within 1m of the delivery WP. Drop through so the GPS nav'),
        ('cm', '// else-branch fires yaw_for_package_delivery.'),
        ('hi', 'let _yield_delivery = false;'),
        ('hi', 'if (!white_rabbit.mission.package_delivered) {'),
        ('hi', '    let _max_seq = 0;'),
        ('hi', '    for (let _i = 0; _i < white_rabbit.mission.waypoints.length; _i++) {'),
        ('hi', '        if (white_rabbit.mission.waypoints[_i].seq > _max_seq)'),
        ('hi', '            _max_seq = white_rabbit.mission.waypoints[_i].seq;'),
        ('hi', '    }'),
        ('hi', '    _yield_delivery = _max_seq > 0 &&'),
        ('hi', '        white_rabbit.mission.current_mission_seq > _max_seq;'),
        ('hi', '}'),
        ('ok', 'if (!_yield_delivery) {'),
        ('ok', '    white_rabbit.follow_the_yellow_brick_road(white_rabbit);'),
        ('ok', '    return;'),
        ('ok', '}'),
    ]

    p_styles = {
        'cm': ParagraphStyle('pcm', fontName='Courier', fontSize=9, textColor=HexColor('#2A5C40'), leading=14),
        'hi': ParagraphStyle('phi', fontName='Courier', fontSize=9, textColor=GOLD,     leading=14),
        'ok': ParagraphStyle('pok', fontName='Courier', fontSize=9, textColor=SW,       leading=14),
    }
    patch_paras = [Paragraph(
        line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'),
        p_styles[kind]) for kind, line in patch_lines]

    patch_table = Table([[patch_paras]], colWidths=[6.5*inch])
    patch_table.setStyle(TableStyle([
        ('BACKGROUND',    (0,0), (-1,-1), MONO_BG),
        ('BOX',           (0,0), (-1,-1), 0.5, SW),
        ('TOPPADDING',    (0,0), (-1,-1), 10),
        ('BOTTOMPADDING', (0,0), (-1,-1), 10),
        ('LEFTPADDING',   (0,0), (-1,-1), 13),
        ('RIGHTPADDING',  (0,0), (-1,-1), 13),
    ]))
    story.append(patch_table)
    story.append(Spacer(1, 20))

    doc.build(story)


# ════════════════════════════════════════════════════════════════
#  MERGE cover + content
# ════════════════════════════════════════════════════════════════
def main():
    import tempfile
    tmp_cover   = tempfile.mktemp(suffix='_cover.pdf')
    tmp_content = tempfile.mktemp(suffix='_content.pdf')

    print('Building cover …')
    build_cover(tmp_cover)

    print('Building content …')
    build_content(tmp_content)

    print('Merging …')
    cover_doc   = fitz.open(tmp_cover)
    content_doc = fitz.open(tmp_content)
    cover_doc.insert_pdf(content_doc)
    cover_doc.save(OUTPUT_PATH)
    cover_doc.close()
    content_doc.close()

    os.unlink(tmp_cover)
    os.unlink(tmp_content)

    print(f'Done → {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
