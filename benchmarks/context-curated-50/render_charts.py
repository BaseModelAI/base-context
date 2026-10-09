#!/usr/bin/env python3
"""Render the four publication SVGs from summary-replica1.json (stdlib only).

Run from the repository root:
    python3 benchmarks/context-curated-50/render_charts.py
No provider calls, raw-run reads, corpus access or installed packages are needed.
"""

import json
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "packages/coding-agent/docs/images/benchmarks"
DATA = json.loads((HERE / "summary-replica1.json").read_text())
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
        self.text(44, 45, "CURATED 50 / REPLICA 1", 15, BASE, 700)
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
    chart = Chart(760, "Less waiting. Strong results.",
        "Curated, outcome-informed first replica: 50 tasks per matching profile. "
        "Base Context mean attempt times are 27%, 37% and 39% lower than Codex. "
        "Full artifact passes are 49/50 vs 50/50, 50/50 vs 49/50, and 49/50 vs 47/50. "
        "Base completed all 150 selected attempts natively and was faster in 128 of the 141 pairs "
        "where both products fully passed and completed. All failures and timeouts are included.")
    chart.header("01 / OVERVIEW", "Less waiting. Strong results.",
        "Base Context vs Codex · Matching requested model + effort")
    chart.text(44, 163, "50 curated, outcome-informed tasks · First replica · 50 selected attempts per product/profile", 18, MUTED)
    for i, (base, codex) in enumerate(PAIRS):
        x = 44 + i * 376
        chart.rect(x, 192, 360, 352, "white", 16, LINE)
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
        chart.line(x + 22, 450, x + 338, 450)
        chart.text(x + 22, 480, "Full artifact passes", 17, MUTED)
        chart.text(x + 22, 517, f"{base['clean_full_passes']}/50", 28, BASE, 700)
        chart.text(x + 136, 515, "vs", 17, MUTED)
        chart.text(x + 191, 517, f"{codex['clean_full_passes']}/50", 28, CODEX, 700)
    chart.rect(44, 568, 1112, 89, "#e4f2ef", 12)
    chart.text(64, 601, "150/150 Base Context attempts completed natively.", 21, INK, 700)
    chart.text(64, 632, "Base faster in 128 of 141 matched pairs where both products fully passed and completed.", 18, INK)
    chart.text(44, 692, "Means include all 6 clean failures and 6 Codex timeouts; 3 timed-out artifacts fully passed.", 17, MUTED)
    chart.text(44, 721, "300 selected R1 attempts · 4 active/product · Mixed Base builds · Methods: benchmarks/context-curated-50", 17, MUTED)
    chart.save("overview")


def time_chart():
    chart = Chart(840, "Mean attempt time, including failures and timeouts",
        "All 50 selected R1 attempts per group. Base Context versus Codex, in minutes: "
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
        "First replica, 50 tasks per profile per product. Full artifact passes: "
        "Base Context 49, 50, 49; Codex 50, 49, 47. Mean judge progress scores: "
        "Base 4.96, 5.00, 4.96; Codex 5.00, 4.96, 4.84. Scores are near ceiling. "
        "Progress scores are not main-check counts. Three Codex timeouts have full artifact passes.")
    chart.header("03 / QUALITY", "Strong artifact scores. Small gaps.", "Full pass = five main checks + the edge check · 50 selected R1 attempts per group")
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
    chart = Chart(1080, "Cost per run: captured + estimated",
        "Solid bars are captured-usage API-list-rate subtotals, not invoices or complete costs. "
        "Hatching adds hypothetical Codex cost if unknown-model receipts used the profile model. "
        "All 441 Codex unpriced receipts have usage but unknown model. Eight Base receipts have known model "
        "but no usage, leaving an unquantified additional component. Sol/Astra sensitivities are scenarios, not bounds.")
    chart.header("04 / COST", "Cost per run: captured + estimated*", "Mean USD per selected R1 attempt · Captured usage at API list rates, not subscription charges")
    chart.legend(171)
    chart.rect(382, 157, 24, 16, "url(#hypothesis)", stroke=CODEX)
    chart.text(416, 171, "Codex estimate: missing model priced at profile model", 17, MUTED)
    start, width = 310, 465
    chart.text(44, 217, "Matching profile / product", 17, MUTED)
    chart.text(815, 217, "Captured + estimate = scenario", 17, MUTED)
    for tick in range(5):
        x = start + width * tick / 4
        chart.line(x, 237, x, 631)
        chart.text(x, 662, f"${tick}", 17, MUTED, anchor="middle")
    estimates = DATA["cost"]["codex_hypothetical_missing_model_estimates"]
    for i, ((base, codex), estimate) in enumerate(zip(PAIRS, estimates)):
        y = 266 + i * 132
        chart.text(44, y, LABELS[i], 22, INK, 700)
        for j, (group, color, name) in enumerate([(base, BASE, "Base"), (codex, CODEX, "Codex")]):
            top = y + 15 + j * 38
            known = group["mean_known_api_rate_cost_usd"]
            length = width * known / 4
            chart.text(220, top + 20, name, 17, color, 700)
            chart.rect(start, top, length, 25, color)
            if j == 0:
                missing = group["captured_receipts"] - group["priced_receipts"]
                noun = "receipt" if missing == 1 else "receipts"
                chart.text(815, top + 20, f"${known:.3f} + unknown ({missing} {noun})", 18, color, 700)
            else:
                extra = estimate["estimated_missing_mean_same_model_usd"]
                total = estimate["estimated_total_mean_same_model_usd"]
                chart.rect(start + length, top, width * extra / 4, 25, "url(#hypothesis)", stroke=CODEX)
                chart.text(815, top + 20, f"${known:.3f} + ${extra:.3f} = ${total:.3f}*", 18, color, 700)
    chart.rect(44, 695, 1112, 231, "white", 12, LINE)
    chart.text(64, 727, "Unknown-model sensitivity · Codex total mean", 22, INK, 700)
    chart.text(64, 758, "Same 441 unpriced receipts; all have usage, none has a recorded model (147/profile).", 17, MUTED)
    chart.text(560, 792, "Assume Sol rates", 18, MUTED, anchor="middle")
    chart.text(895, 792, "Assume Astra rates", 18, MUTED, anchor="middle")
    for i, estimate in enumerate(estimates):
        y = 826 + i * 35
        chart.text(64, y, LABELS[i], 19, INK, 700)
        for x, model in [(560, "gpt-6.1-sol"), (895, "gpt-6-astra")]:
            total = estimate["known_mean_usd"] + estimate["estimated_missing_by_assumed_model_usd"][model] / estimate["runs"]
            chart.text(x, y, f"${total:.3f}", 21, CODEX, 700, "middle")
    chart.text(44, 963, "* Model-price estimate, not measured cost. Sol/Astra values are scenarios, not bounds.", 17, MUTED)
    chart.text(44, 994, "Base: 8 receipts have no usage (7 native-control, 1 refine); extra cost unknown, not zero.", 17, MUTED)
    chart.text(44, 1025, "Selected R1 only; excludes invalid/interrupted attempts and R2. Full-family costs remain unknown.", 17, MUTED)
    chart.save("cost")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    overview()
    time_chart()
    quality_chart()
    cost_chart()
    print(f"Rendered 4 SVGs in {OUT}")
