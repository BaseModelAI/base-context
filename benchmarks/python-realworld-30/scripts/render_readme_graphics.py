#!/usr/bin/env python3
"""Render three public SVG charts from the checked-in 60-pair CSV and summary.

Run from any directory. Uses only the Python standard library; no provider access.
"""
import csv
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "benchmarks/python-realworld-30/results"
OUT = ROOT / "packages/coding-agent/docs/images/benchmarks"
BG, PANEL, GRID = "#091522", "#112438", "#2c4157"
INK, MUTED, BASE, CODEX = "#f2f7fc", "#b6c6d7", "#68e0b5", "#97b9ee"
FONT = "DejaVu Sans, sans-serif"
PROFILES = ("gpt-6.1-sol-high", "gpt-6-astra-medium")
SCOPE = "GPT-6.1 Sol · high + GPT-6 Astra · medium"


def rect(x, y, w, h, fill=PANEL, radius=12):
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{radius}" fill="{fill}"/>'


def text(x, y, value, size=20, fill=INK, weight=400, anchor="start"):
    return f'<text x="{x:.2f}" y="{y:.2f}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}">{escape(str(value))}</text>'


def line(x1, y1, x2, y2, color=GRID, width=1):
    return f'<path d="M{x1:.2f} {y1:.2f} L{x2:.2f} {y2:.2f}" fill="none" stroke="{color}" stroke-width="{width}"/>'


def circle(x, y, color, radius=4):
    return f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{color}"/>'


def canvas(name, height, title, description, parts):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title description">'
    svg += f'<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>'
    svg += rect(0, 0, 1200, height, BG, 20) + ''.join(parts) + '</svg>\n'
    (OUT / f"{name}.svg").write_text(svg)


def legend(y):
    return [rect(48, y - 14, 14, 14, BASE, 3), text(72, y, "Base Context 1.1.1", 18, MUTED),
            rect(305, y - 14, 14, 14, CODEX, 3), text(329, y, "Codex 0.160.0", 18, MUTED)]


def headline(data):
    b, c = (data["overall"][h] for h in ("base-context", "codex"))
    p = [text(48, 42, "BASE CONTEXT / NATIVE CODING BENCHMARK", 17, BASE, 700),
         text(48, 82, SCOPE, 23, INK, 600),
         text(48, 139, "Same full-pass result. Less time and cost.", 42, INK, 700),
         text(48, 174, "30 Python tasks · 60 matched task/profile pairs · best of two eligible attempts", 20, MUTED)]
    specs = [("full_passes", 60, [0, 30, 60], "Full task passes", "60/60", "for both agents", lambda v: f"{v}/60"),
             ("mean_runtime_seconds", 500, [0, 250, 500], "Mean runtime (seconds)", f'{data["relative_reductions_percent"]["mean_runtime_seconds"]:.0f}%', "less mean runtime", lambda v: f"{v:.1f} s"),
             ("estimated_api_cost_usd", 45, [0, 20, 40], "Estimated API cost (USD)", f'{data["relative_reductions_percent"]["estimated_api_cost_usd"]:.0f}%', "lower estimated API cost", lambda v: f"${v:.2f}")]
    for i, (key, limit, ticks, label, big, subtitle, fmt) in enumerate(specs):
        x = 48 + i * 376
        p += [rect(x, 205, 352, 305), text(x + 24, 242, label, 19, MUTED, 600),
              text(x + 24, 311, big, 60, BASE, 700), text(x + 24, 344, subtitle, 20, INK)]
        for y, group, color in ((371, b, BASE), (413, c, CODEX)):
            p += [rect(x + 24, y, 210 * group[key] / limit, 20, color, 3),
                  text(x + 328, y + 17, fmt(group[key]), 18, color, 600, "end")]
        p += [line(x + 24, 447, x + 234, 447)]
        for tick in ticks:
            tx = x + 24 + 210 * tick / limit
            p += [line(tx, 447, tx, 453), text(tx, 476, tick, 16, MUTED, anchor="middle")]
    p += legend(546)
    p += [text(48, 579, "Selected runs · 3–5 Oct 2026 · captured-usage API estimates · mean task runtime", 17, MUTED)]
    canvas("benchmark-overview", 600, "Same quality, 31% less mean runtime and 19% lower estimated API cost", "Scope: " + SCOPE + ". Both agents fully pass 60 of 60 selected cases. Base Context vs Codex: mean runtime 295.6 vs 428.3 seconds; estimated API cost $30.41 vs $37.42. Best of two eligible attempts per task, profile and agent. All bar scales start at zero.", p)


def profiles(data):
    p = [text(48, 42, "TWO EXACT PROFILES / THE BREAKDOWN", 17, BASE, 700),
         text(48, 94, "Lower means in both tested profiles.", 40, INK, 700),
         text(48, 132, "30 selected runs per agent and profile · 30/30 full task passes in every group", 20, MUTED)]
    p += legend(169)
    for x, key, limit, ticks, label in [(48, "estimated_api_cost_usd", 35, [0, 10, 20, 30], "Estimated API cost (USD) · total"),
                                        (612, "mean_runtime_seconds", 600, [0, 200, 400, 600], "Mean runtime (seconds)")]:
        p += [rect(x, 194, 540, 382), text(x + 24, 230, label, 22, INK, 600)]
        plot_x, plot_w = x + 24, 420
        for tick in ticks:
            tx = plot_x + plot_w * tick / limit
            p += [line(tx, 273, tx, 526), text(tx, 549, tick, 17, MUTED, anchor="middle")]
        for j, profile in enumerate(PROFILES):
            g = data["profiles"][profile]
            y = 269 + j * 139
            p += [text(plot_x, y, g["label"], 20, INK, 600)]
            for offset, harness, color in [(16, "base-context", BASE), (54, "codex", CODEX)]:
                value = g[harness][key]
                w = plot_w * value / limit
                value_label = f"${value:.2f}" if key == "estimated_api_cost_usd" else f"{value:.1f} s"
                p += [rect(plot_x, y + offset, w, 27, color, 3), text(plot_x + w + 10, y + offset + 21, value_label, 18, color, 600)]
    p += [text(48, 612, "Same tasks within each profile · selected best-of-two results · zero-based axes · lower is better", 18, MUTED)]
    canvas("benchmark-models", 642, "Estimated API cost and mean runtime by model and effort", "Scope: " + SCOPE + ". Sol high: Base $6.75 and 377.1 seconds versus Codex $8.03 and 490.8 seconds. Astra medium: Base $23.66 and 214.0 seconds versus Codex $29.39 and 365.8 seconds. Each agent fully passes 30 of 30 selected tasks per profile. Cost bars show totals; runtime bars show means.", p)


def task_pairs(data, rows):
    p = [text(48, 42, "60 EXACT PAIRS / TASK-LEVEL SPREAD", 17, BASE, 700),
         text(48, 94, "Not just a lower average.", 40, INK, 700),
         text(48, 132, SCOPE + " · all 60 pairs tied on full task quality", 20, MUTED)]
    for x, key, count, label in [(48, "estimated_api_cost_usd", data["paired_outcomes"]["base_lower_estimated_api_cost"], "Estimated API cost"),
                                (612, "runtime_seconds", data["paired_outcomes"]["base_shorter_runtime"], "Runtime")]:
        p += [rect(x, 159, 540, 490), text(x + 24, 198, label, 24, INK, 600),
              text(x + 24, 253, f"{count}/60", 46, BASE, 700), text(x + 199, 248, "pairs lower for Base", 21, INK),
              text(x + 24, 286, f"{60 - count}/60 lower for Codex · no ties", 18, MUTED),
              text(x + 24, 320, "Base / Codex ratio · below 1 is lower", 18, MUTED)]
        px, pw = x + 24, 456
        for tick in (0, 0.5, 1, 1.5, 2):
            tx = px + pw * tick / 2
            p += [line(tx, 340, tx, 572, INK if tick == 1 else GRID, 2 if tick == 1 else 1),
                  text(tx, 598, f"{tick:g}", 17, MUTED, anchor="middle")]
        for j, profile in enumerate(PROFILES):
            py = 381 + 116 * j
            p += [text(px, py - 25, data["profiles"][profile]["label"], 18, INK, 600)]
            profile_rows = sorted((r for r in rows if r["profile_id"] == profile), key=lambda r: int(r["task_id"]))
            # Deterministic vertical spacing separates points; only x encodes the ratio.
            for i, row in enumerate(profile_rows):
                ratio = float(row["base_" + key]) / float(row["codex_" + key])
                p += [circle(px + pw * ratio / 2, py + (i % 5) * 11, BASE if ratio < 1 else CODEX)]
        p += [text(px, 631, "Each dot = one task/profile pair; horizontal scale only", 17, MUTED)]
    p += [text(48, 683, "Best of two eligible attempts · 3–5 Oct 2026 · selected-run API cost estimates", 18, MUTED)]
    canvas("benchmark-task-pairs", 714, "Base is lower-cost in 55 of 60 pairs and faster in 55 of 60 pairs", "Scope: " + SCOPE + ". Each dot shows the selected Base / Codex ratio for one task and exact model/effort profile. The full zero-to-two axis includes every observation; the equality line is one. Lower estimated API cost: Base 55, Codex 5. Shorter runtime: Base 55, Codex 5. All 60 pairs tie on full task quality.", p)


def main():
    data = json.loads((RESULTS / "summary.json").read_text())
    with (RESULTS / "task-profile-pairs.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    OUT.mkdir(parents=True, exist_ok=True)
    headline(data)
    profiles(data)
    task_pairs(data, rows)
    print("Wrote benchmark-overview.svg, benchmark-models.svg and benchmark-task-pairs.svg")


if __name__ == "__main__":
    main()
