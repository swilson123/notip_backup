#!/usr/bin/env python3
"""
generate_book_pdf.py — plain, clean manuscript-style PDF from a markdown file.

Usage:
    python3.9 generate_book_pdf.py <input.md> <output.pdf>

Deliberately simple/standard formatting (not the ornate Serene Journey
cover style) since this is meant to read like an actual manuscript.
"""

import sys, re, os
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import black, HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, HRFlowable,
)
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY

GREY = HexColor('#555555')


def make_styles():
    return {
        'title':    ParagraphStyle('title', fontName='Times-Bold', fontSize=28,
                                    leading=34, alignment=TA_CENTER, spaceAfter=6),
        'subtitle': ParagraphStyle('subtitle', fontName='Times-Italic', fontSize=15,
                                    leading=20, alignment=TA_CENTER, textColor=GREY,
                                    spaceAfter=28),
        'heading':  ParagraphStyle('heading', fontName='Times-Bold', fontSize=18,
                                    leading=24, spaceBefore=18, spaceAfter=14),
        'body':     ParagraphStyle('body', fontName='Times-Roman', fontSize=12,
                                    leading=19, alignment=TA_JUSTIFY, spaceAfter=12,
                                    firstLineIndent=18),
    }


def inline(text):
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'(?<!\*)\*([^*]+?)\*(?!\*)', r'<i>\1</i>', text)
    return text


def parse_md(path, S):
    story = []
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    i, n = 0, len(lines)
    first_block = True
    while i < n:
        line = lines[i].rstrip()

        if not line:
            i += 1
            continue

        if line.startswith('# '):
            story.append(Paragraph(inline(line[2:].strip()), S['title']))
        elif line.startswith('### '):
            story.append(Paragraph(inline(line[4:].strip()), S['subtitle']))
        elif line.startswith('## '):
            if not first_block:
                story.append(PageBreak())
            story.append(Paragraph(inline(line[3:].strip()), S['heading']))
        elif line.strip() == '---':
            story.append(Spacer(1, 0.15 * inch))
            story.append(HRFlowable(width='30%', thickness=0.75, color=GREY,
                                     hAlign='CENTER'))
            story.append(Spacer(1, 0.15 * inch))
        else:
            story.append(Paragraph(inline(line.strip()), S['body']))

        first_block = False
        i += 1

    return story


def build(md_path, pdf_path):
    S = make_styles()
    doc = SimpleDocTemplate(
        pdf_path, pagesize=letter,
        leftMargin=1.15 * inch, rightMargin=1.15 * inch,
        topMargin=1 * inch, bottomMargin=1 * inch,
    )
    story = parse_md(md_path, S)
    doc.build(story)
    kb = os.path.getsize(pdf_path) // 1024
    print(f'{os.path.basename(pdf_path)}  ({kb} KB)  ->  {pdf_path}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('usage: python3.9 generate_book_pdf.py <input.md> <output.pdf>')
        sys.exit(1)
    build(sys.argv[1], sys.argv[2])
