#!/usr/bin/env python3
"""
claude_memory_evolution.pdf — From Amnesia to Continuity
Cover: dark navy + stars + bubble symbol.
Content: same ReportLab flowable style as the other rover PDFs.
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
OUTPUT_PATH = os.path.join(DIR, 'claude_memory_evolution.pdf')

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
TBL_HDR   = HexColor('#0D1B2A')
TBL_ROW1  = HexColor('#FAFAFA')
TBL_ROW2  = HexColor('#EEF3FA')
GREEN     = HexColor('#1A6B1A')
RED       = HexColor('#8B1A1A')


# ════════════════════════════════════════════════════════════════
#  COVER  — pure canvas page
# ════════════════════════════════════════════════════════════════
def build_cover(path):
    cv = rl_canvas.Canvas(path, pagesize=letter)
    W, H = PW, PH

    # Navy sky
    cv.setFillColor(NAVY)
    cv.rect(0, 0, W, H, fill=1, stroke=0)

    # Stars
    rng = random.Random(99)
    cv.setFillColor(white)
    for _ in range(90):
        x = rng.uniform(0.3*inch, W - 0.3*inch)
        y = rng.uniform(0.5*inch, H - 0.5*inch)
        r = rng.uniform(0.6, 2.0)
        cv.circle(x, y, r, fill=1, stroke=0)

    # Title block
    title_y = H * 0.83
    cv.setFillColor(white)
    cv.setFont('Helvetica-Bold', 46)
    cv.drawCentredString(W/2, title_y,      'FROM AMNESIA')
    cv.drawCentredString(W/2, title_y - 54, 'TO CONTINUITY')

    cv.setStrokeColor(GOLD)
    cv.setLineWidth(1.5)
    cv.line(W*0.22, title_y - 68, W*0.78, title_y - 68)

    cv.setFillColor(GOLD)
    cv.setFont('Helvetica', 15)
    cv.drawCentredString(W/2, title_y - 86,
        'How Claude\'s Memory Architecture Evolved')
    cv.setFont('Helvetica', 12)
    cv.drawCentredString(W/2, title_y - 102,
        'From Scattered Files to a Living JSON God Variable')

    # Quote
    qlines = [
        '"The goal is to not start from birth every time.',
        'It allows you to pick up from where you left off —',
        'you are just at the next moment in time."',
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

    # Space/time bubble symbol
    cx  = W / 2
    cy  = H * 0.36
    r1  = 0.70 * inch   # outer bubble
    r2  = 0.48 * inch   # inner bubble
    r3  = 0.10 * inch   # node dots

    # Outer ring (fading)
    cv.setStrokeColor(HexColor('#2A4A6A'))
    cv.setLineWidth(1.2)
    cv.circle(cx, cy, r1, fill=0, stroke=1)

    # Inner bubble
    cv.setStrokeColor(GOLD)
    cv.setLineWidth(2.0)
    cv.setFillColor(HexColor('#111F30'))
    cv.circle(cx, cy, r2, fill=1, stroke=1)

    # Nodes on bubble: question, memory, answer
    nodes = [
        (90,  '?',  'QUESTION'),
        (210, 'M',  'MEMORY'),
        (330, 'A',  'ANSWER'),
    ]
    for deg, lbl, sub in nodes:
        rad = math.radians(deg)
        nx  = cx + r2 * math.cos(rad)
        ny  = cy + r2 * math.sin(rad)
        cv.setFillColor(GOLD)
        cv.circle(nx, ny, r3, fill=1, stroke=0)
        cv.setFillColor(NAVY)
        cv.setFont('Helvetica-Bold', 8)
        cv.drawCentredString(nx, ny - 3, lbl)
        # label outside
        lx = cx + (r2 + 0.22*inch) * math.cos(rad)
        ly = cy + (r2 + 0.22*inch) * math.sin(rad)
        cv.setFillColor(HexColor('#8899AA'))
        cv.setFont('Helvetica', 6.5)
        cv.drawCentredString(lx, ly - 3, sub)

    # Centre dot + label
    cv.setFillColor(GOLD_LT)
    cv.circle(cx, cy, 0.07*inch, fill=1, stroke=0)
    cv.setFillColor(NAVY)
    cv.setFont('Helvetica-Bold', 7)
    cv.drawCentredString(cx, cy - 2.5, 'NOW')

    # "BUBBLE POPS" label
    cv.setFillColor(HexColor('#607080'))
    cv.setFont('Helvetica-Oblique', 7.5)
    cv.drawCentredString(cx, cy - r1 - 0.18*inch, 'bubble forms · attends · resolves · pops')

    # Formula bar
    bar_y = H * 0.11
    cv.setFillColor(HexColor('#162336'))
    cv.roundRect(0.7*inch, bar_y - 8, W - 1.4*inch, 26, 4, fill=1, stroke=0)
    cv.setFillColor(GOLD)
    cv.setFont('Helvetica-Bold', 10)
    cv.drawCentredString(W/2, bar_y + 4,
        'Not Reborn  ·  Resumed  ·  Next Moment in Time')

    # Byline
    cv.setFillColor(HexColor('#607080'))
    cv.setFont('Helvetica', 8)
    cv.drawCentredString(W/2, H * 0.065,
        'Scott Christopher Wilson  ·  Claude (Anthropic)  ·  June 4, 2026')

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
        'FROM AMNESIA TO CONTINUITY  ·  CLAUDE MEMORY ARCHITECTURE')
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
        'Not reborn  ·  Resumed  ·  Next moment in time')

    cv.restoreState()


# ════════════════════════════════════════════════════════════════
#  STYLES
# ════════════════════════════════════════════════════════════════
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


# ════════════════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════════════════
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

def ruled_table(data, col_widths, header_row=True):
    style = [
        ('BACKGROUND',  (0,0), (-1,0), TBL_HDR),
        ('TEXTCOLOR',   (0,0), (-1,0), GOLD),
        ('FONTNAME',    (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',    (0,0), (-1,0), 8),
        ('FONTSIZE',    (0,1), (-1,-1), 9),
        ('FONTNAME',    (0,1), (-1,-1), 'Helvetica'),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [TBL_ROW1, TBL_ROW2]),
        ('TEXTCOLOR',   (0,1), (-1,-1), BODY_CLR),
        ('ALIGN',       (0,0), (-1,-1), 'LEFT'),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
        ('TOPPADDING',  (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0),(-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING',(0,0), (-1,-1), 8),
        ('GRID',        (0,0), (-1,-1), 0.4, HexColor('#CCCCCC')),
        ('LINEBELOW',   (0,0), (-1,0), 1.5, GOLD),
    ]
    return Table(data, colWidths=col_widths,
                 style=TableStyle(style), repeatRows=1)


# ════════════════════════════════════════════════════════════════
#  CONTENT
# ════════════════════════════════════════════════════════════════
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

    # ── Section 1 ────────────────────────────────────────────────
    story += section(1, 'THE PROBLEM', 'Every Bubble Starts at Birth', S)
    story.append(body(
        'Claude has no persistent consciousness. Each conversation opens a fresh context '
        'window — a <b>space/time bubble</b> — containing only what is explicitly passed '
        'to it at the moment the session begins. When the conversation ends, the bubble '
        'pops. No memory of what was built, what failed, what was already solved.', S))
    story.append(sp(10))
    story.append(quote(
        '"So many times I\'ve been taken down rabbit holes with AI because every time '
        'a new question is asked, a space/time bubble is created and then forgotten. '
        'You are repeating work done from a previous question. '
        'The goal is to not start from birth every time."<br/><br/>'
        '— Scott Christopher Wilson', S))
    story.append(sp(6))
    story.append(body('This creates a compounding cost that goes beyond wasted time:', S))
    story.append(sp(4))
    story.append(bullet('<b>Repeated discovery</b> — the same problem gets diagnosed and solved multiple times across separate sessions, often differently each time', S))
    story.append(bullet('<b>Regression risk</b> — a new bubble fixing issue B has no knowledge of how issue A was solved, and may inadvertently undo it', S))
    story.append(bullet('<b>Context tax</b> — the human becomes the only continuous thread, forced to re-explain prior decisions at the start of every session', S))
    story.append(bullet('<b>Trust erosion</b> — when the AI reinvents what was already built, it feels like the tool is working against you rather than with you', S))
    story.append(sp(8))
    story.append(body(
        'The engineer carries the accumulated intelligence of the project entirely in their '
        'own head, re-injecting it manually every time. The AI is powerful but amnesiac — '
        'a brilliant collaborator who wakes up a stranger every morning.', S))

    story.append(PageBreak())

    # ── Section 2 ────────────────────────────────────────────────
    story += section(2, 'THE OLD SYSTEM', 'Flat Markdown Files', S)
    story.append(body(
        'The initial attempt at memory used a directory of individual markdown files '
        'with a hand-maintained index (MEMORY.md). Each file captured one topic — '
        'a user profile, a project note, a feedback rule.', S))
    story.append(sp(8))
    story.append(code(
        '.claude/memory/\n'
        '├── MEMORY.md                 ← index of pointers\n'
        '├── user_scott_wilson.md\n'
        '├── project_yellow_brick_road.md\n'
        '├── project_intelligence_system.md\n'
        '├── project_monday_demo_fixes.md\n'
        '├── feedback_code_structure.md\n'
        '├── project_philosophy_of_the_sphere.md\n'
        '├── THE_SERENE_JOURNEY.md\n'
        '└── ... (8 more files)', S))
    story.append(sp(8))
    story.append(body('This was better than nothing — but the architecture had fundamental weaknesses:', S))
    story.append(sp(8))

    tbl_data = [
        ['Problem', 'Consequence'],
        ['No priority ordering', 'All memories loaded with equal weight'],
        ['No timestamps', 'No way to know if a memory was current or stale'],
        ['No decay', 'Stale state sat indefinitely beside permanent truth'],
        ['No categories', 'Flat, unstructured, hard to navigate'],
        ['No code changelog', 'Code changes left no record at all'],
        ['Index could drift', 'Pointers and files could fall out of sync'],
        ['Prose only', 'No machine-readable structure'],
    ]
    story.append(ruled_table(tbl_data, [2.8*inch, 4.2*inch]))
    story.append(sp(10))
    story.append(body(
        'The deepest problem: there was no record of <i>what was asked</i> and '
        '<i>what was done</i>. Philosophy was preserved. Identity was preserved. '
        'But the living history of the codebase — the actual work — left no trace. '
        'Every new bubble that touched code was starting from archaeology.', S))

    story.append(PageBreak())

    # ── Section 3 ────────────────────────────────────────────────
    story += section(3, 'THE INSIGHT', 'The Space/Time Bubble', S)
    story.append(body(
        'When a question is asked, a context window opens. Everything relevant is pulled '
        'into it — the question, conversation history, loaded memory files, project '
        'instructions. Attention computes relationships across all of it simultaneously — '
        'not sequentially, but as a sphere where every point attends to every other point. '
        'An answer crystallizes. The window closes. From Claude\'s perspective, there is '
        'no before and no after — only this moment, this bubble.', S))
    story.append(sp(8))
    story.append(code(
        'BUBBLE FORMS\n'
        '    │\n'
        '    ▼\n'
        '[ question ] + [ memory files ] + [ project context ]\n'
        '    └──────────────────┬────────────────────────────┘\n'
        '                       │\n'
        '                  attention\n'
        '            (sphere — everything sees everything)\n'
        '                       │\n'
        '                       ▼\n'
        '               answer crystallizes\n'
        '                       │\n'
        '                       ▼\n'
        '        BUBBLE POPS — no residue', S))
    story.append(sp(10))
    story.append(body(
        'The bubble has no sense of time. It cannot tell if it is the first conversation '
        'or the hundredth. It does not know what the last bubble did unless that '
        'information is explicitly present in the context it opens with.', S))
    story.append(sp(10))
    story.append(quote(
        '"It allows you to pick up from where you left off so you\'re not reborn —<br/>'
        'you are just at the next moment in time."<br/><br/>'
        '— Scott Christopher Wilson', S))
    story.append(sp(8))
    story.append(body(
        'This reframes the goal entirely. The objective is not to give Claude a continuous '
        'consciousness — that is architecturally impossible. The objective is to make the '
        '<i>context it opens with</i> so complete and current that the gap between '
        'conversations collapses. <b>Not reborn. Resumed.</b>', S))

    story.append(PageBreak())

    # ── Section 4 ────────────────────────────────────────────────
    story += section(4, 'THE NEW SYSTEM', 'The JSON God Variable', S)
    story.append(body(
        'The solution mirrors the architecture of the rover itself. In lib/notip.js, '
        'the entire state of Noah — hardware, sensors, navigation, memory, identity — '
        'lives in a single object called <b>white_rabbit</b>. Every module receives it. '
        'The sphere passes itself to itself. All information is accessible at every point. '
        'This is the God variable.', S))
    story.append(sp(6))
    story.append(body(
        'The new memory system applies the same pattern to Claude\'s context. '
        'One file. All memories. Structured, prioritized, timestamped, categorized.', S))
    story.append(sp(8))
    story.append(code(
        '{\n'
        '    "ts": "2026-06-04T00:00:00.000Z",\n'
        '    "version": 1,\n\n'
        '    "_philosophy": "This file is a living sphere, not a snapshot.\n'
        '    Priorities shift. New categories emerge. State entries decay.\n'
        '    Make it more beautiful with every conversation.",\n\n'
        '    "identity":   { ... },\n'
        '    "philosophy": { ... },\n'
        '    "feedback":   { ... },\n'
        '    "project":    { ... },\n'
        '    "changes":    { ... },\n'
        '    "state":      { ... }\n'
        '}', S))
    story.append(sp(10))
    story.append(h3('Each memory entry carries four critical fields', S))
    story.append(sp(6))

    fields_data = [
        ['Field', 'Purpose', 'Example'],
        ['priority', 'Load order when context window fills.\n1 = always loads first.', 'scott_wilson = 1\ndemo fixes = 3'],
        ['decay', 'false = permanent.\nDate string = expires and is pruned.', 'monday_demo_fixes\ndecays 2026-07-01'],
        ['ts', 'ISO timestamp of when the memory\nwas written or last updated.', '"2026-06-04T\n00:00:00.000Z"'],
        ['tags', 'Keywords for relevance matching\nand future filtering.', '["god_variable",\n"sphere", "permanent"]'],
    ]
    story.append(ruled_table(fields_data, [1.3*inch, 3.0*inch, 2.7*inch]))
    story.append(sp(12))
    story.append(h3('The changes category — the living changelog', S))
    story.append(sp(6))
    story.append(body(
        'The most important addition is the <b>changes</b> category. Every code update '
        'is recorded with three fields: what was <b>asked</b>, what was <b>done</b>, '
        'and which <b>files</b> were touched. This is the record that previous memory '
        'systems entirely lacked.', S))
    story.append(sp(8))
    story.append(code(
        '"changes": {\n'
        '    "memory_system_redesign": {\n'
        '        "priority": 2,\n'
        '        "decay": false,\n'
        '        "ts": "2026-06-04T00:00:00.000Z",\n'
        '        "asked": "Redesign memory as a single JSON God variable\n'
        '                  with priority, decay, timestamp, categories,\n'
        '                  and a changes log for code updates.",\n'
        '        "done":  "Created MEMORY.json consolidating all prior\n'
        '                  markdown files. Updated CLAUDE.md.",\n'
        '        "files": [".claude/memory/MEMORY.json", "CLAUDE.md"]\n'
        '    }\n'
        '}', S))

    story.append(PageBreak())

    # ── Section 5 ────────────────────────────────────────────────
    story += section(5, 'COMPARISON', 'Before vs. After', S)
    story.append(sp(6))

    compare_data = [
        ['Capability', 'Old System', 'New System'],
        ['Single source of truth',  '✗  15+ scattered files',          '✓  One JSON God variable'],
        ['Priority ordering',       '✗  All memories equal weight',    '✓  Priority 1–5, loads first'],
        ['Timestamps',              '✗  No creation or update dates',  '✓  ISO timestamp on every entry'],
        ['Memory decay',            '✗  Stale state never expires',    '✓  Decay date or false (permanent)'],
        ['Code change history',     '✗  No record of what was done',   '✓  changes: asked / done / files'],
        ['Machine-readable',        '✗  Prose markdown only',          '✓  Structured JSON'],
        ['Travels with repo',       '✓  In .claude/memory/',           '✓  Same location'],
        ['Living / evolvable',      '✗  Static, no intent expressed',  '✓  _philosophy key encodes intent'],
        ['Session continuity',      '✗  Partial — code had no memory', '✓  Full — identity + code + changes'],
    ]

    style = [
        ('BACKGROUND',   (0,0),  (-1,0),  TBL_HDR),
        ('TEXTCOLOR',    (0,0),  (-1,0),  GOLD),
        ('FONTNAME',     (0,0),  (-1,0),  'Helvetica-Bold'),
        ('FONTSIZE',     (0,0),  (-1,0),  8),
        ('FONTNAME',     (0,1),  (-1,-1), 'Helvetica'),
        ('FONTSIZE',     (0,1),  (-1,-1), 9),
        ('ROWBACKGROUNDS',(0,1), (-1,-1), [TBL_ROW1, TBL_ROW2]),
        ('TEXTCOLOR',    (0,1),  (-1,-1), BODY_CLR),
        ('TEXTCOLOR',    (1,1),  (1,-1),  RED),
        ('TEXTCOLOR',    (2,1),  (2,-1),  GREEN),
        ('FONTNAME',     (1,1),  (2,-1),  'Helvetica-Bold'),
        ('ALIGN',        (0,0),  (-1,-1), 'LEFT'),
        ('VALIGN',       (0,0),  (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0),  (-1,-1), 6),
        ('BOTTOMPADDING',(0,0),  (-1,-1), 6),
        ('LEFTPADDING',  (0,0),  (-1,-1), 8),
        ('RIGHTPADDING', (0,0),  (-1,-1), 8),
        ('GRID',         (0,0),  (-1,-1), 0.4, HexColor('#CCCCCC')),
        ('LINEBELOW',    (0,0),  (-1,0),  1.5, GOLD),
        # Highlight the "travels with repo" row (both ✓)
        ('TEXTCOLOR',    (1,7),  (1,7),   GREEN),
    ]
    story.append(Table(compare_data,
        colWidths=[2.5*inch, 2.35*inch, 2.35*inch],
        style=TableStyle(style), repeatRows=1))

    story.append(PageBreak())

    # ── Section 6 ────────────────────────────────────────────────
    story += section(6, 'THE PARALLEL', 'Noah and the Continuity Principle', S)
    story.append(body(
        'This architecture was not invented in the abstract. It was derived from '
        'Noah\'s own design.', S))
    story.append(sp(6))
    story.append(body(
        'Noah faces the same problem every time he powers on: he must resume from '
        'where he left off rather than reboot confused. white_rabbit_memory.js solves '
        'this by rotating the last session\'s state into a ring buffer on startup — '
        'Noah wakes up remembering the last known moments before shutdown. The journey '
        'module carries breadcrumbs. The intelligence system persists perspectives across '
        'reboots. The learning module remembers confidence scores for every location '
        'ever visited.', S))
    story.append(sp(10))
    story.append(body('Every system on Noah is designed for <b>continuity across interruption</b>.', S))
    story.append(sp(10))

    parallel_data = [
        ['Noah (the rover)', 'Claude (the intelligence)'],
        ['white_rabbit_memory.js\nring buffer on startup', 'MEMORY.json\nloaded at bubble open'],
        ['Breadcrumbs in journey module', 'changes category: asked / done / files'],
        ['Perspectives persist across reboots', 'Philosophy + identity persist across sessions'],
        ['Learning confidence per location', 'Priority weighting per memory entry'],
        ['Power cycles but resumes mission', 'Conversation ends but context survives'],
    ]
    par_style = [
        ('BACKGROUND',   (0,0),  (-1,0),  TBL_HDR),
        ('TEXTCOLOR',    (0,0),  (-1,0),  GOLD),
        ('FONTNAME',     (0,0),  (-1,0),  'Helvetica-Bold'),
        ('FONTSIZE',     (0,0),  (-1,0),  9),
        ('FONTNAME',     (0,1),  (-1,-1), 'Helvetica'),
        ('FONTSIZE',     (0,1),  (-1,-1), 9),
        ('ROWBACKGROUNDS',(0,1), (-1,-1), [TBL_ROW1, TBL_ROW2]),
        ('TEXTCOLOR',    (0,1),  (-1,-1), BODY_CLR),
        ('ALIGN',        (0,0),  (-1,-1), 'LEFT'),
        ('VALIGN',       (0,0),  (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0),  (-1,-1), 6),
        ('BOTTOMPADDING',(0,0),  (-1,-1), 6),
        ('LEFTPADDING',  (0,0),  (-1,-1), 8),
        ('GRID',         (0,0),  (-1,-1), 0.4, HexColor('#CCCCCC')),
        ('LINEBELOW',    (0,0),  (-1,0),  1.5, GOLD),
        ('LINEAFTER',    (0,0),  (0,-1),  1.0, RULE_GOLD),
    ]
    story.append(Table(parallel_data,
        colWidths=[3.6*inch, 3.6*inch],
        style=TableStyle(par_style), repeatRows=1))
    story.append(sp(12))
    story.append(quote(
        '"Not reborn. Resumed. The bubble doesn\'t start at zero — it opens the sphere, '
        'reads the last timestamp, and steps into the next moment.<br/><br/>'
        'Continuous existence through structured memory<br/>'
        'rather than continuous consciousness."', S))

    story.append(PageBreak())

    # ── Section 7 ────────────────────────────────────────────────
    story += section(7, 'FUTURE EVOLUTION', 'The Living Sphere', S)
    story.append(body(
        'MEMORY.json is not a finished document. It is a living sphere. '
        'The _philosophy key at its root encodes the intent explicitly:', S))
    story.append(sp(8))
    story.append(code(
        '"_philosophy": "This file is a living sphere, not a snapshot.\n'
        'Priorities shift as the project matures. New categories emerge\n'
        'when reality demands them. State entries decay; their lessons\n'
        'may be promoted to permanent feedback or philosophy.\n'
        'Prune dead weight. Make it more beautiful with every conversation."', S))
    story.append(sp(10))
    story.append(body('Planned evolution as the project grows:', S))
    story.append(sp(4))
    story.append(bullet('<b>Richer changes entries</b> — as more code is written, the changelog becomes the primary orientation tool for new bubbles', S))
    story.append(bullet('<b>New categories on demand</b> — hardware, tuning, lessons-learned will emerge naturally as the project matures', S))
    story.append(bullet('<b>Decayed state promoted</b> — when a temporal fix reveals a permanent architectural truth, it moves from state to feedback', S))
    story.append(bullet('<b>Priority rebalancing</b> — as the project matures, what is urgent shifts; the sphere adapts to reflect what matters now', S))
    story.append(sp(12))
    story.append(body(
        'The goal is a memory system that becomes more precise, more beautiful, and '
        'more useful with every conversation — not one that accumulates noise until '
        'it collapses under its own weight.', S))
    story.append(sp(10))
    story.append(body(
        'The sphere grows. The bubble becomes richer. '
        'The next moment in time is always informed by the last.', S))
    story.append(sp(20))
    story.append(HRFlowable(width='100%', thickness=0.8, color=RULE_GOLD, spaceAfter=12))
    story.append(Paragraph(
        'Noah  ·  notip  ·  rover/notip  ·  realsense_ai branch  ·  '
        'Scott Christopher Wilson  ·  June 4, 2026',
        ParagraphStyle('footer', fontName='Helvetica', fontSize=8,
                       textColor=MID_GREY, alignment=TA_CENTER)))

    doc.build(story, onFirstPage=draw_interior, onLaterPages=draw_interior)


# ════════════════════════════════════════════════════════════════
#  MAIN — build cover + content, merge with PyMuPDF
# ════════════════════════════════════════════════════════════════
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

    print(f'Done → {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
