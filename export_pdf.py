"""Build Chinese vocabulary export PDFs with reportlab."""

from __future__ import annotations

import io
import os
import random
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)

CJK_FONT_CANDIDATES = [
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
]
CN_FONT_NAME = "CnFont"


def _find_cjk_font() -> str | None:
    for path in CJK_FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def _register_font() -> None:
    global CN_FONT_NAME
    try:
        pdfmetrics.getFont(CN_FONT_NAME)
    except Exception:
        path = _find_cjk_font()
        if path:
            pdfmetrics.registerFont(TTFont(CN_FONT_NAME, path))
        else:
            try:
                pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
                CN_FONT_NAME = "STSong-Light"
            except Exception:
                raise ValueError(
                    "未找到可用中文字体，PDF 导出需要系统中文字体。"
                ) from None


def _fallback_text(value: object) -> str:
    text = " ".join(str(value or "").split())
    return text


def build_pdf(
    *,
    book_name: str,
    unit_names: list[str],
    records: list[dict],
    count_label: str = "",
    blank_mode: bool = False,
) -> bytes:
    _register_font()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=6 * mm if blank_mode else 16 * mm,
        bottomMargin=6 * mm if blank_mode else 15 * mm,
        leftMargin=10 * mm if blank_mode else 15 * mm,
        rightMargin=10 * mm if blank_mode else 15 * mm,
        title=f"{book_name} - 单词抽查",
    )
    base_style = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleCN",
        parent=base_style["Title"],
        fontName=CN_FONT_NAME,
        fontSize=17,
        leading=22,
        spaceAfter=3,
    )
    meta_style = ParagraphStyle(
        "MetaCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=9,
        leading=13,
        textColor=colors.HexColor("#4b5563"),
        spaceAfter=8,
    )
    header_style = ParagraphStyle(
        "HeaderCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=8.5,
        leading=11,
        textColor=colors.white,
    )
    cell_style = ParagraphStyle(
        "CellCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=9,
        leading=12,
    )
    blank_cell_style = ParagraphStyle(
        "BlankCellCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=10,
        leading=12,
    )
    small_style = ParagraphStyle(
        "SmallCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=8,
        leading=11,
        textColor=colors.HexColor("#374151"),
    )
    footer_style = ParagraphStyle(
        "FooterCN",
        parent=base_style["Normal"],
        fontName=CN_FONT_NAME,
        fontSize=8,
        leading=11,
        textColor=colors.HexColor("#6b7280"),
        alignment=1,
    )

    unit_text = "、".join(unit_names[:8])
    if len(unit_names) > 8:
        unit_text += f" 等 {len(unit_names)} 个单元"
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    extra = f"（{count_label}）" if count_label else ""

    story = [
        Paragraph(_fallback_text(book_name), title_style),
        Paragraph(f"{unit_text}{extra}　|　生成时间：{now}", meta_style),
        Spacer(1, 3 * mm),
    ]

    if blank_mode:
        page_tables = []
        for page_start in range(0, len(records), 50):
            page_records = records[page_start:page_start + 50]
            rows = []
            for offset in range(0, len(page_records), 2):
                left = page_records[offset]
                left_index = page_start + offset + 1
                right = page_records[offset + 1] if offset + 1 < len(page_records) else None
                right_index = left_index + 1
                left_cell = (
                    f"{left_index}. {_fallback_text(left.get('word'))}"
                    if left else ""
                )
                right_cell = (
                    f"{right_index}. {_fallback_text(right.get('word'))}"
                    if right else ""
                )
                rows.append([
                    Paragraph(left_cell, blank_cell_style),
                    Paragraph(right_cell, blank_cell_style),
                ])
            table = LongTable(
                rows,
                colWidths=[90 * mm, 90 * mm],
                rowHeights=[10 * mm] * max(1, len(rows)),
            )
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cbd5e1")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            page_tables.append(table)
        for index, table in enumerate(page_tables):
            story.append(table)
            if index < len(page_tables) - 1:
                story.append(PageBreak())
    else:
        table_data: list[list[object]] = []
        table_data.append([
            Paragraph("单元", header_style),
            Paragraph("单词", header_style),
            Paragraph("音标", header_style),
            Paragraph("词性", header_style),
            Paragraph("中文释义", header_style),
            Paragraph("英文释义", header_style),
        ])
        max_en_len = 0
        for rec in records:
            word = _fallback_text(rec.get("word"))
            phonetic = _fallback_text(rec.get("phonetic"))
            pos = _fallback_text(rec.get("pos"))
            meaning = _fallback_text(rec.get("meaning"))
            meaning_en = _fallback_text(rec.get("meaning_en"))
            max_en_len = max(max_en_len, len(meaning_en))
            table_data.append([
                Paragraph(_fallback_text(rec.get("unit_name")), small_style),
                Paragraph(word, cell_style),
                Paragraph(phonetic, small_style),
                Paragraph(pos, small_style),
                Paragraph(meaning, cell_style),
                Paragraph(meaning_en, small_style),
            ])
        table_style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, colors.HexColor("#f7f8fa")]),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d1d5db")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        widths = [
            24 * mm,
            42 * mm,
            30 * mm,
            17 * mm,
            52 * mm,
            max(35 * mm, min(58 * mm, 20 * mm + max_en_len * 0.22 * mm)),
        ]
        total = sum(widths)
        if total > 180 * mm:
            widths = [w * (180 * mm / total) for w in widths]
        table = LongTable(table_data, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle(table_style))
        story.append(table)

    def footer(canvas, doc_):
        canvas.saveState()
        canvas.setFont(CN_FONT_NAME, 8)
        canvas.setFillColor(colors.HexColor("#6b7280"))
        canvas.drawCentredString(A4[0] / 2, 10 * mm, f"- {doc_.page} -")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
