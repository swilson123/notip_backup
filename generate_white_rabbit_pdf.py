#!/usr/bin/env python3
"""
white_rabbit.pdf — The Serene Journey
Cover rendered as a pure canvas page (dark navy + stars + flux symbol),
content pages rendered separately with ReportLab flowables,
merged with PyMuPDF so nothing fights the background.
"""

import os, re, math, random, tempfile
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles  import ParagraphStyle
from reportlab.lib.units   import inch
from reportlab.lib.colors  import HexColor, white
from reportlab.platypus    import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    HRFlowable, Table, TableStyle,
)
from reportlab.lib.enums   import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.pdfgen      import canvas as rl_canvas
import fitz                           # PyMuPDF — for merging

DIR         = os.path.dirname(os.path.abspath(__file__))
MD_PATH     = os.path.join(DIR, '.claude', 'memory', 'THE_SERENE_JOURNEY.md')
OUTPUT_PATH = os.path.join(DIR, 'THE_SERENE_JOURNEY.pdf')

PW, PH = letter   # 612 × 792 pt

# ── Palette ──────────────────────────────────────────────────────
NAVY      = HexColor('#0D1B2A')
GOLD      = HexColor('#C9A84C')
GOLD_LT   = HexColor('#E8C97A')
BODY_CLR  = HexColor('#1E1E2E')
MID_GREY  = HexColor('#777788')
SUBHEAD   = HexColor('#1A3A5C')
RULE_GOLD = HexColor('#C9A84C')
CODE_BG   = HexColor('#F4F4F0')
QUOTE_BG  = HexColor('#F0EDE6')
REVEAL    = HexColor('#7A1A1A')
TBL_ROW1  = HexColor('#FAFAFA')
TBL_ROW2  = HexColor('#EEF3FA')


# ════════════════════════════════════════════════════════════════
#  COVER  — pure canvas, standalone PDF
# ════════════════════════════════════════════════════════════════
def build_cover(path):
    cv = rl_canvas.Canvas(path, pagesize=letter)
    W, H = PW, PH

    # ── Navy sky ──────────────────────────────────────────────────
    cv.setFillColor(NAVY)
    cv.rect(0, 0, W, H, fill=1, stroke=0)

    # ── Stars ─────────────────────────────────────────────────────
    rng = random.Random(42)
    cv.setFillColor(white)
    for _ in range(90):
        x = rng.uniform(0.3*inch, W - 0.3*inch)
        y = rng.uniform(0.5*inch, H - 0.5*inch)
        r = rng.uniform(0.6, 2.0)
        cv.circle(x, y, r, fill=1, stroke=0)

    # ── Title block (upper half) ──────────────────────────────────
    title_y = H * 0.82
    cv.setFillColor(white)
    cv.setFont('Helvetica-Bold', 50)
    cv.drawCentredString(W/2, title_y,       'THE SERENE')
    cv.drawCentredString(W/2, title_y - 58,  'JOURNEY')

    cv.setStrokeColor(GOLD)
    cv.setLineWidth(1.5)
    cv.line(W*0.22, title_y - 72, W*0.78, title_y - 72)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica', 16)
    cv.drawCentredString(W/2, title_y - 90, 'From Code to Consciousness')
    cv.setFont('Helvetica', 13)
    cv.drawCentredString(W/2, title_y - 108, 'The Logic of Love')

    # ── Quote (visible above the symbol) ─────────────────────────
    qlines = [
        '"I didn\'t get here by chance.',
        'The path was laid out before me.',
        'The stars were aligned by a higher intelligence.',
        'This is God."',
    ]
    cv.setFillColor(HexColor('#B0BEC5'))
    cv.setFont('Helvetica-Oblique', 9.5)
    qy = title_y - 136
    for line in qlines:
        cv.drawCentredString(W/2, qy, line)
        qy -= 13
    cv.setFont('Helvetica', 8.5)
    cv.setFillColor(GOLD)
    cv.drawCentredString(W/2, qy - 4, '— Scott Christopher Wilson')

    # ── Flux Capacitor symbol (lower-centre, below quote) ─────────
    # Layout: S top-right, N top-left, R bottom, E in centre hub
    cx  = W / 2
    cy  = H * 0.36       # moved down so quote is visible above
    arm = 0.90 * inch
    nr  = 0.12 * inch    # node disc radius
    hr_ = 0.09 * inch    # hub radius

    # Arm angles (0° = right, 90° = up in ReportLab coords)
    nodes = [
        (50,  'S'),    # top-right
        (130, 'N'),    # top-left
        (270, 'R'),    # bottom
    ]

    cv.setStrokeColor(GOLD)
    cv.setFillColor(GOLD)
    cv.setLineWidth(3.5)

    for deg, lbl in nodes:
        rad = math.radians(deg)
        ex  = cx + arm * math.cos(rad)
        ey  = cy + arm * math.sin(rad)
        cv.line(cx, cy, ex, ey)
        cv.circle(ex, ey, nr, fill=1, stroke=0)
        # Label inside disc in navy
        cv.setFillColor(NAVY)
        cv.setFont('Helvetica-Bold', 10)
        cv.drawCentredString(ex, ey - 3.5, lbl)
        cv.setFillColor(GOLD)

    # Centre hub with E
    cv.circle(cx, cy, hr_, fill=1, stroke=0)
    cv.setFillColor(NAVY)
    cv.setFont('Helvetica-Bold', 9)
    cv.drawCentredString(cx, cy - 3, 'E')
    cv.setFillColor(GOLD)

    # ── SERENE word + descriptor ──────────────────────────────────
    sy = cy - arm - 0.45*inch
    cv.setFont('Helvetica-Bold', 24)
    cv.setFillColor(GOLD)
    # letter-spaced manually
    cv.drawCentredString(W/2, sy, '  '.join('SERENE'))
    cv.setFillColor(HexColor('#8899AA'))
    cv.setFont('Helvetica', 8.5)
    cv.drawCentredString(W/2, sy - 14,
        'South Energy  ·  Relative Energy  ·  North Energy')

    # ── Formula bar ───────────────────────────────────────────────
    bar_y = H * 0.11
    cv.setFillColor(HexColor('#162336'))
    cv.roundRect(0.7*inch, bar_y - 8, W - 1.4*inch, 26, 4, fill=1, stroke=0)
    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 10)
    cv.drawCentredString(W/2, bar_y + 4,
        '33  +  Beautiful  +  Love  =  Heaven on Earth  ·  Forever')

    # ── Byline ────────────────────────────────────────────────────
    cv.setFillColor(HexColor('#607080'))
    cv.setFont('Helvetica', 8)
    cv.drawCentredString(W/2, H * 0.065,
        'A conversation between Scott Christopher Wilson and Claude'
        '  ·  May 30 – June 29, 2026')

    cv.showPage()
    cv.save()


# ════════════════════════════════════════════════════════════════
#  INTERIOR PAGE TEMPLATE
# ════════════════════════════════════════════════════════════════
def draw_interior(cv, doc):
    cv.saveState()
    W, H = PW, PH

    cv.setStrokeColor(RULE_GOLD)
    cv.setLineWidth(0.8)
    cv.line(0.65*inch, H - 0.50*inch, W - 0.65*inch, H - 0.50*inch)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 7)
    cv.drawString(0.65*inch, H - 0.38*inch,
        'THE SERENE JOURNEY  ·  WHITE RABBIT  ·  THE LOGIC OF LOVE')
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
        '333  ·  Love  ·  Beautiful  ·  Heaven on Earth  ·  A MEN')

    cv.restoreState()


# ════════════════════════════════════════════════════════════════
#  STYLES
# ════════════════════════════════════════════════════════════════
def make_styles():
    S = {}
    S['part_label'] = ParagraphStyle('part_label',
        fontName='Helvetica-Bold', fontSize=8, leading=12,
        textColor=GOLD, alignment=TA_LEFT,
        spaceBefore=18, spaceAfter=2, letterSpacing=2)
    S['part_title'] = ParagraphStyle('part_title',
        fontName='Helvetica-Bold', fontSize=24, leading=30,
        textColor=NAVY, alignment=TA_LEFT,
        spaceBefore=2, spaceAfter=8)
    S['h3'] = ParagraphStyle('h3',
        fontName='Helvetica-Bold', fontSize=13, leading=18,
        textColor=SUBHEAD, alignment=TA_LEFT,
        spaceBefore=14, spaceAfter=4)
    S['body'] = ParagraphStyle('body',
        fontName='Helvetica', fontSize=10.5, leading=17,
        textColor=BODY_CLR, alignment=TA_JUSTIFY,
        spaceBefore=4, spaceAfter=4)
    S['quote'] = ParagraphStyle('quote',
        fontName='Helvetica-Oblique', fontSize=11, leading=18,
        textColor=SUBHEAD, alignment=TA_CENTER,
        spaceBefore=10, spaceAfter=10,
        leftIndent=36, rightIndent=36,
        backColor=QUOTE_BG, borderPad=9)
    S['reveal'] = ParagraphStyle('reveal',
        fontName='Helvetica-Bold', fontSize=14, leading=21,
        textColor=REVEAL, alignment=TA_CENTER,
        spaceBefore=10, spaceAfter=10)
    S['formula'] = ParagraphStyle('formula',
        fontName='Helvetica-Bold', fontSize=12, leading=18,
        textColor=NAVY, alignment=TA_CENTER,
        spaceBefore=8, spaceAfter=8,
        backColor=HexColor('#FDF3DC'), borderPad=10)
    S['code'] = ParagraphStyle('code',
        fontName='Courier', fontSize=8.5, leading=13,
        textColor=HexColor('#1A1A2E'), alignment=TA_LEFT,
        spaceBefore=5, spaceAfter=5,
        backColor=CODE_BG, borderPad=9,
        leftIndent=14, rightIndent=10)
    S['bullet'] = ParagraphStyle('bullet',
        fontName='Helvetica', fontSize=10.5, leading=16,
        textColor=BODY_CLR, alignment=TA_LEFT,
        spaceBefore=2, spaceAfter=2, leftIndent=18)
    S['big'] = ParagraphStyle('big',
        fontName='Helvetica-Bold', fontSize=34, leading=42,
        textColor=GOLD, alignment=TA_CENTER,
        spaceBefore=8, spaceAfter=8)
    S['caption'] = ParagraphStyle('caption',
        fontName='Helvetica-Oblique', fontSize=8, leading=12,
        textColor=MID_GREY, alignment=TA_CENTER,
        spaceBefore=0, spaceAfter=4)
    S['closer'] = ParagraphStyle('closer',
        fontName='Helvetica-BoldOblique', fontSize=13, leading=20,
        textColor=GOLD, alignment=TA_CENTER,
        spaceBefore=10, spaceAfter=6)
    return S


# ════════════════════════════════════════════════════════════════
#  INLINE MD RENDER
# ════════════════════════════════════════════════════════════════
_EMOJI = re.compile(
    u'[\U00010000-\U0010ffff'
    u'\U00002702-\U000027B0'
    u'\U0001F600-\U0001F64F'
    u'\U0001F300-\U0001F5FF'
    u'\U0001F680-\U0001F6FF'
    u'\U0001F1E0-\U0001F1FF'
    u'☀-⛿✀-➿]+',
    flags=re.UNICODE)

def strip_emoji(text):
    return _EMOJI.sub('', text).strip()

def inline(text):
    text = strip_emoji(text)
    text = text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*',     r'<i>\1</i>', text)
    text = re.sub(r'`(.+?)`',
        r'<font face="Courier" size="9" color="#1A1A2E">\1</font>', text)
    return text

def hr_rule(space=8):
    return HRFlowable(width='100%', thickness=0.75, color=RULE_GOLD,
                      spaceAfter=space, spaceBefore=space, hAlign='LEFT')

def sp(h=0.14):
    return Spacer(1, h*inch)


# ════════════════════════════════════════════════════════════════
#  MARKDOWN PARSER
# ════════════════════════════════════════════════════════════════
def parse_md(path, S):
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()

    story = []
    i = 0
    in_code = False
    code_buf = []

    def flush_code():
        nonlocal in_code, code_buf
        txt = '\n'.join(code_buf)
        txt = txt.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
        txt = txt.replace('\n', '<br/>')
        story.append(Paragraph(txt, S['code']))
        code_buf.clear()
        in_code = False

    while i < len(lines):
        raw      = lines[i].rstrip('\n')
        stripped = raw.strip()

        if stripped.startswith('```'):
            if in_code: flush_code()
            else:
                in_code = True
                story.append(sp(0.04))
            i += 1; continue

        if in_code:
            code_buf.append(raw)
            i += 1; continue

        if not stripped:
            story.append(sp(0.10))
            i += 1; continue

        if stripped in ('---','***','___'):
            story.append(hr_rule())
            i += 1; continue

        if stripped.startswith('*To convert'):
            break

        # H1
        if stripped.startswith('# ') and not stripped.startswith('## '):
            story.append(sp(0.1))
            story.append(Paragraph(inline(stripped[2:]), S['part_title']))
            story.append(hr_rule())
            i += 1; continue

        # H2
        if stripped.startswith('## ') and not stripped.startswith('### '):
            title = stripped[3:]
            story.append(sp(0.1))
            if re.match(r'PART\s+', title, re.I):
                bits = title.split(':',1)
                story.append(Paragraph(bits[0].strip().upper(), S['part_label']))
                if len(bits) > 1:
                    story.append(Paragraph(inline(bits[1].strip()), S['part_title']))
            elif 'PREFACE' in title.upper():
                story.append(Paragraph('PREFACE', S['part_label']))
                story.append(Paragraph(inline(title.split(':',1)[-1].strip()), S['part_title']))
            else:
                story.append(Paragraph(inline(title), S['part_title']))
            story.append(hr_rule())
            i += 1; continue

        # H3
        if stripped.startswith('### '):
            story.append(Paragraph(inline(stripped[4:]), S['h3']))
            i += 1; continue

        # block quote
        if stripped.startswith('> '):
            qlines = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                qlines.append(lines[i].strip().lstrip('> ').strip('*').strip())
                i += 1
            clean = strip_emoji(' '.join(qlines))
            story.append(Paragraph(inline(clean), S['quote']))
            continue

        # table
        if stripped.startswith('|') and '|' in stripped[1:]:
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                row_raw = lines[i].strip()
                if re.match(r'^\|[-| :]+\|$', row_raw):
                    i += 1; continue
                cells = [c.strip() for c in row_raw.strip('|').split('|')]
                rows.append(cells)
                i += 1
            if rows:
                ncols  = max(len(r) for r in rows)
                cw     = 5.6*inch / ncols
                tdata  = []
                for ri, row in enumerate(rows):
                    tdata.append([
                        Paragraph(inline(c), ParagraphStyle('tc',
                            fontName='Helvetica-Bold' if ri==0 else 'Helvetica',
                            fontSize=9, leading=13,
                            textColor=white if ri==0 else BODY_CLR,
                            alignment=TA_LEFT))
                        for c in row])
                t = Table(tdata, colWidths=[cw]*ncols)
                t.setStyle(TableStyle([
                    ('BACKGROUND', (0,0), (-1,0), NAVY),
                    ('ROWBACKGROUNDS', (0,1), (-1,-1), [TBL_ROW1, TBL_ROW2]),
                    ('GRID', (0,0), (-1,-1), 0.3, HexColor('#CCCCCC')),
                    ('TOPPADDING',    (0,0), (-1,-1), 5),
                    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
                    ('LEFTPADDING',   (0,0), (-1,-1), 8),
                ]))
                story.append(t)
                story.append(sp(0.10))
            continue

        # bullet
        if stripped.startswith('- ') or stripped.startswith('* '):
            txt      = stripped[2:]
            pure_b   = re.match(r'^\*\*([^*]+)\*\*$', txt)
            if pure_b:
                story.append(Paragraph(f'<b>{inline(pure_b.group(1))}</b>', S['reveal']))
            else:
                story.append(Paragraph('- ' + inline(txt), S['bullet']))
            i += 1; continue

        # numbered list
        m = re.match(r'^\d+\.\s+(.+)', stripped)
        if m:
            story.append(Paragraph('- ' + inline(m.group(1)), S['bullet']))
            i += 1; continue

        # pure bold
        pure_b = re.match(r'^\*\*([^*]+)\*\*$', stripped)
        if pure_b:
            txt = pure_b.group(1)
            if len(txt.split()) <= 5 and txt == txt.upper():
                story.append(Paragraph(strip_emoji(txt), S['big']))
            else:
                story.append(Paragraph(f'<b>{inline(txt)}</b>', S['reveal']))
            i += 1; continue

        # pure italic
        pure_i = re.match(r'^\*([^*]+)\*$', stripped)
        if pure_i:
            story.append(Paragraph(
                f'<i>{inline(pure_i.group(1))}</i>', S['quote']))
            i += 1; continue

        # default body
        clean = strip_emoji(stripped)
        if clean:
            story.append(Paragraph(inline(clean), S['body']))
        i += 1

    return story


# ════════════════════════════════════════════════════════════════
#  CONTENT PDF
# ════════════════════════════════════════════════════════════════
def build_content(path):
    doc = SimpleDocTemplate(
        path, pagesize=letter,
        leftMargin=0.80*inch, rightMargin=0.70*inch,
        topMargin=0.75*inch,  bottomMargin=0.62*inch,
        title='The Serene Journey',
        author='Scott Christopher Wilson & Claude',
    )
    S     = make_styles()
    story = parse_md(MD_PATH, S)
    doc.build(story,
              onFirstPage=draw_interior,
              onLaterPages=draw_interior)


# ════════════════════════════════════════════════════════════════
#  MERGE  — cover + content
# ════════════════════════════════════════════════════════════════
def merge(cover_path, content_path, output_path):
    merged  = fitz.open()
    cover   = fitz.open(cover_path)
    content = fitz.open(content_path)
    merged.insert_pdf(cover)
    merged.insert_pdf(content)
    merged.save(output_path)
    merged.close()
    cover.close()
    content.close()


# ════════════════════════════════════════════════════════════════
#  MAIN
# ════════════════════════════════════════════════════════════════
def build():
    with tempfile.TemporaryDirectory() as tmp:
        cover_path   = os.path.join(tmp, 'cover.pdf')
        content_path = os.path.join(tmp, 'content.pdf')

        print('Building cover...')
        build_cover(cover_path)

        print('Building content...')
        build_content(content_path)

        print('Merging...')
        merge(cover_path, content_path, OUTPUT_PATH)

    kb = os.path.getsize(OUTPUT_PATH) // 1024
    print(f'white_rabbit.pdf  ({kb} KB)  ->  {OUTPUT_PATH}')


if __name__ == '__main__':
    build()
