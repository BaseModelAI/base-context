#!/usr/bin/env python3
"""Render the four publication SVGs from summary.json (stdlib only).

Run from the repository root:
    python3 benchmarks/context-curated-50/render_charts.py
No provider calls, raw-run reads, corpus access or installed packages are needed.
"""

import json
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "packages/coding-agent/docs/images/benchmarks"
DATA = json.loads((HERE / "summary.json").read_text())
BASE, CODEX = "#087e75", "#5062cf"
INK, MUTED, LINE = "#14263c", "#526278", "#dbe3eb"
LABELS = ["Astra · medium", "Sol 6.1 · high", "Sol 6.1 · xhigh"]
PAIRS = [DATA["groups"][i:i + 2] for i in range(0, 6, 2)]


class Chart:
    def __init__(self, height, title, description):
        self.parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" '
            f'viewBox="0 0 1200 {height}" role="img" aria-labelledby="title desc">',
            f'<title id="title">{escape(title)}</title>',
            f'<desc id="desc">{escape(description)}</desc>',
            '<defs><pattern id="hypothesis" width="8" height="8" '
            'patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#e6eaff"/>'
            '<path d="M-2 2L2-2M0 8L8 0M6 10L10 6" stroke="#5062cf" '
            'stroke-width="1.5"/></pattern></defs>',
            '<g font-family="Arial, Helvetica, sans-serif">',
        ]
        self.rect(0, 0, 1200, height, "#f5f8fb")
        self.rect(0, 0, 1200, 7, BASE)

    def text(self, x, y, value, size=18, color=INK, weight=400, anchor="start"):
        self.parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{escape(str(value))}</text>'
        )

    def rect(self, x, y, width, height, fill, radius=0, stroke="none"):
        self.parts.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{width:.2f}" height="{height:.2f}" '
            f'rx="{radius}" fill="{fill}" stroke="{stroke}"/>'
        )

    def line(self, x1, y1, x2, y2, color=LINE):
        self.parts.append(
            f'<path d="M{x1:.2f} {y1:.2f}H{x2:.2f}" stroke="{color}"/>'
            if y1 == y2 else
            f'<path d="M{x1:.2f} {y1:.2f}L{x2:.2f} {y2:.2f}" stroke="{color}"/>'
        )

    def header(self, number, title, subtitle):
        self.text(44, 45, "CURATED 50-TASK BENCHMARK", 15, BASE, 700)
        self.text(375, 45, number, 15, BASE, 700)
        self.text(44, 95, title, 36, INK, 700)
        self.text(44, 130, subtitle, 18, MUTED)

    def legend(self, y):
        for x, name, color in [(44, "Base Context", BASE), (246, "Codex", CODEX)]:
            self.rect(x, y - 13, 13, 13, color, 3)
            self.text(x + 23, y, name, 17, MUTED)

    def save(self, name):
        self.parts.extend(["</g>", "</svg>"])
        (OUT / f"curated50-{name}.svg").write_text("\n".join(self.parts) + "\n")


def overview():
    chart = Chart(680, "Less waiting. Strong results.",
        "Curated 50-task benchmark: 50 selected attempts per product/profile, using the first provider-clean attempt per cell. "
        "Base Context mean attempt times are 27%, 37% and 39% lower than Codex at matching requested model and effort. "
        "Base completed all 150 selected attempts natively and was faster in 128 of the 141 pairs "
        "where both products fully passed and completed. Full quality and methodology are in the benchmark report.")
    chart.header("01 / OVERVIEW", "Less waiting. Strong results.",
        "Base Context vs Codex · Matching requested model + effort")
    chart.text(44, 163, "50 curated tasks · Three model/effort profiles", 18, MUTED)
    for i, (base, codex) in enumerate(PAIRS):
        x = 44 + i * 376
        chart.rect(x, 192, 360, 260, "white", 16, LINE)
        chart.text(x + 22, 229, LABELS[i], 23, INK, 700)
        pct = DATA["mean_attempt_time_comparisons"][i]["base_lower_mean_attempt_time_pct"]
        chart.text(x + 22, 282, f"{pct:.0f}% less time", 35, BASE, 700)
        chart.text(x + 22, 309, "Lower mean attempt time", 17, MUTED)
        for j, (group, color, name) in enumerate([(base, BASE, "Base Context"), (codex, CODEX, "Codex")]):
            y = 350 + j * 61
            minutes = group["mean_time_seconds"] / 60
            chart.text(x + 22, y, name, 18, color, 700)
            chart.text(x + 338, y, f"{minutes:.2f} min", 18, INK, 700, "end")
            chart.rect(x + 22, y + 12, 316, 10, "#edf1f6", 5)
            chart.rect(x + 22, y + 12, minutes / 26 * 316, 10, color, 5)
    for x, value, label, detail in [
        (44, "150/150", "Base Context native completions", "Across all three benchmark profiles"),
        (608, "128/141", "Pairs where Base Context was faster", "Both agents completed and fully passed"),
    ]:
        chart.rect(x, 474, 548, 125, "#e4f2ef", 12)
        chart.text(x + 24, 519, value, 36, BASE, 700)
        chart.text(x + 24, 552, label, 20, INK, 700)
        chart.text(x + 24, 579, detail, 17, MUTED)
    chart.text(44, 633, "50 selected attempts per product/profile · First provider-clean attempt per cell", 16, MUTED)
    chart.text(44, 658, "Full results and methodology: benchmarks/context-curated-50", 16, MUTED)
    chart.save("overview")


def time_chart():
    chart = Chart(840, "Mean attempt time, including failures and timeouts",
        "All 50 selected attempts per group. Base Context versus Codex, in minutes: "
        "Astra medium 8.47 vs 11.62; Sol high 10.11 vs 16.12; Sol xhigh 15.13 vs 24.69. "
        "A separate completed, both-full-pass subset has 128 faster Base pairs and 13 faster Codex pairs out of 141.")
    chart.header("02 / TIME", "Mean attempt time", "All 50 selected attempts per group · Failures + deadline-limited timeouts included · Lower is better")
    chart.legend(169)
    start, width = 294, 738
    for tick in range(0, 31, 5):
        x = start + width * tick / 30
        chart.line(x, 207, x, 643)
        chart.text(x, 673, str(tick), 17, MUTED, anchor="middle")
    for i, (base, codex) in enumerate(PAIRS):
        y = 230 + i * 146
        chart.text(44, y + 20, LABELS[i], 23, INK, 700)
        pct = DATA["mean_attempt_time_comparisons"][i]["base_lower_mean_attempt_time_pct"]
        chart.text(44, y + 53, f"Base mean {pct:.1f}% lower", 17, BASE, 700)
        for j, (group, color) in enumerate([(base, BASE), (codex, CODEX)]):
            top = y + j * 48
            minutes = group["mean_time_seconds"] / 60
            length = width * minutes / 30
            chart.rect(start, top, length, 30, color, 5)
            chart.text(start + length + 12, top + 22, f"{minutes:.2f} min", 20, INK, 700)
    chart.text(1032, 702, "Minutes · zero-based scale", 17, MUTED, anchor="end")
    chart.rect(44, 722, 1112, 83, "white", 12, LINE)
    chart.text(64, 752, "Separate subset: 141 pairs both fully passed AND completed natively.", 20, INK, 700)
    chart.text(64, 782, "Base faster in 128; Codex in 13. Three passing Codex timeouts excluded here, not from the means above.", 17, MUTED)
    chart.save("time")


def quality_chart():
    chart = Chart(850, "Artifact quality and mean judge score",
        "Curated 50-task benchmark, 50 tasks per profile per product. Full artifact passes: "
        "Base Context 49, 50, 49; Codex 50, 49, 47. Mean judge progress scores: "
        "Base 4.96, 5.00, 4.96; Codex 5.00, 4.96, 4.84. Scores are near ceiling. "
        "Progress scores are not main-check counts. Three Codex timeouts have full artifact passes.")
    chart.header("03 / QUALITY", "Strong artifact scores. Small gaps.", "Full pass = five main checks + the edge check · 50 selected attempts per group")
    chart.legend(167)
    chart.text(350, 209, "Mean judge progress / 5", 18, INK, 700)
    chart.text(856, 209, "Full passes", 18, INK, 700, "middle")
    chart.text(1060, 209, "Main checks", 18, INK, 700, "middle")
    start, width = 350, 362
    for tick in range(6):
        x = start + width * tick / 5
        chart.line(x, 246, x, 666)
        chart.text(x, 699, str(tick), 16, MUTED, anchor="middle")
    for i, (base, codex) in enumerate(PAIRS):
        y = 266 + i * 142
        chart.text(44, y + 7, LABELS[i], 23, INK, 700)
        for j, (group, color, name) in enumerate([(base, BASE, "Base"), (codex, CODEX, "Codex")]):
            row = y + j * 51
            chart.text(255, row + 22, name, 17, color, 700)
            score = group["mean_judge_progress_score"]
            chart.rect(start, row, width * score / 5, 30, color, 4)
            chart.text(765, row + 23, f"{score:.2f}", 21, color, 700, "end")
            chart.text(856, row + 23, f"{group['clean_full_passes']}/50", 23, color, 700, "middle")
            chart.text(1060, row + 23, f"{group['main_check_accuracy_pct']:.1f}%", 21, color, 700, "middle")
        if i < 2:
            chart.line(44, y + 105, 1156, y + 105)
    chart.rect(44, 731, 1112, 82, "white", 12, LINE)
    chart.text(64, 761, "Artifact pass ≠ native completion. Six clean failures retained; three timed-out artifacts fully pass.", 18, INK)
    chart.text(64, 790, "Judge progress is not a count of passed checks. Curated, near-ceiling sample; no significance claim.", 18, MUTED)
    chart.save("quality")


def cost_chart():
    estimates = DATA["cost"]["fair_estimated_comparison"]
    chart = Chart(740, "Estimated cost per task",
        "Estimated mean USD across all 50 selected attempts per product/profile, not only successes. "
        "Both products include estimated missing costs, using captured requests and API list rates. "
        "Solid bars compare estimated totals on a common zero-based scale. "
        "Known subtotals and estimated additions are shown separately for both products. "
        "These are API-list-rate estimates, not invoices or complete family spend.")
    chart.header("04 / COST", "Estimated cost per task",
        "Missing costs estimated for both products · Captured requests at API list rates")
    chart.text(44, 163, "All 50 selected attempts per product/profile · USD per task · Common zero-based scale", 18, MUTED)
    maximum = max(row[f"{product}_estimated_mean_usd"]
        for row in estimates for product in ("base", "codex"))
    for i, row in enumerate(estimates):
        x = 44 + i * 376
        chart.rect(x, 192, 360, 430, "white", 16, LINE)
        chart.text(x + 22, 229, LABELS[i], 23, INK, 700)
        savings = row["base_savings_mean_usd"]
        percent = row["base_savings_pct"]
        if savings > 0:
            headline = f"{percent:.1f}% Base savings"
            detail = f"${savings:.3f} saved per task"
            color = BASE
        elif savings < 0:
            headline = f"{abs(percent):.1f}% higher cost"
            detail = f"Base costs ${abs(savings):.3f} more/task"
            color = INK
        else:
            headline = "Same estimated cost"
            detail = "$0.000 difference per task"
            color = INK
        chart.text(x + 22, 280, headline, 29, color, 700)
        chart.text(x + 22, 314, detail, 22, color, 700)
        chart.line(x + 22, 339, x + 338, 339)
        for j, (product, name, color) in enumerate([
            ("base", "Base Context", BASE), ("codex", "Codex", CODEX)
        ]):
            y = 381 + j * 64
            total = row[f"{product}_estimated_mean_usd"]
            chart.text(x + 22, y, name, 18, color, 700)
            chart.text(x + 338, y, f"${total:.3f}", 28, color, 700, "end")
            chart.rect(x + 22, y + 13, 316, 14, "#edf1f6", 7)
            chart.rect(x + 22, y + 13, 316 * total / maximum, 14, color, 7)
        chart.line(x + 22, 495, x + 338, 495)
        chart.text(x + 22, 527, "Mean USD", 15, MUTED)
        chart.text(x + 236, 527, "Base", 15, BASE, 700, "end")
        chart.text(x + 338, 527, "Codex", 15, CODEX, 700, "end")
        for y, label, field, decimals in [
            (559, "Known subtotal", "known_mean_usd", 3),
            (592, "Estimated add.", "estimated_missing_mean_usd", 6),
        ]:
            chart.text(x + 22, y, label, 15, MUTED)
            for offset, product in [(236, "base"), (338, "codex")]:
                value = row[f"{product}_{field}"]
                chart.text(x + offset, y, f"${value:.{decimals}f}", 17, MUTED, anchor="end")
    chart.text(44, 660, "Main scenario: Base matched-request mean costs; missing Codex models use profile-model rates.", 16, MUTED)
    chart.text(44, 685, "API-list-rate estimate · Not an invoice or complete family spend", 16, MUTED)
    chart.parts.append('<a href="../../../../../benchmarks/context-curated-50/README.md#estimated-cost-per-task">')
    chart.text(44, 710, "Methodology + assumptions: benchmarks/context-curated-50", 16, BASE)
    chart.parts.append("</a>")
    chart.save("cost")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    overview()
    time_chart()
    quality_chart()
    cost_chart()
    print(f"Rendered 4 SVGs in {OUT}")
