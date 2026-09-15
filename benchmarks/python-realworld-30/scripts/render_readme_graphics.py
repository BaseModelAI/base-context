#!/usr/bin/env python3
"""Render README SVGs from the public frozen results. No provider access.

For a PNG preview, use ImageMagick on each generated SVG:
    convert -background none -density 144 input.svg -strip output.png
The README uses committed PNGs; SVGs remain editable vector originals.
"""
from decimal import Decimal
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "benchmarks/python-realworld-30/results/summary.json"
OUT = ROOT / "packages/coding-agent/docs/images/benchmarks"
DATA = json.loads(RESULTS.read_text())
GROUPS = {(g["model"], g["harness"]): g for g in DATA["groups"]}
BASE, PRIME = GROUPS["TOTAL", "current"], GROUPS["TOTAL", "vanilla"]
BG, PANEL, LINE = "#081321", "#112337", "#294058"
INK, MUTED, GREEN, BLUE = "#f2f7ff", "#b7c8dc", "#64edbd", "#91add6"
FONT = "DejaVu Sans, sans-serif"


def rect(x, y, w, h, fill=PANEL, radius=18, stroke="none"):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def text(x, y, label, size=22, fill=INK, weight=400, anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}">{escape(str(label))}</text>'


def line(x1, y1, x2, y2, color=LINE, width=1):
    return f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{color}" stroke-width="{width}"/>'


def arrow(x1, y, x2):
    return line(x1, y, x2, y, GREEN, 3) + f'<path d="M{x2-8} {y-6} L{x2} {y} L{x2-8} {y+6}" fill="none" stroke="{GREEN}" stroke-width="3"/>'


def canvas(name, height, title, description, parts):
    body = f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title description">'
    body += f'<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>'
    body += rect(0, 0, 1200, height, BG, 24)
    body += '<circle cx="1160" cy="-80" r="300" fill="#0c2334"/><circle cx="1160" cy="-80" r="225" fill="none" stroke="#183d4a" stroke-width="2"/>'
    body += ''.join(parts) + '</svg>\n'
    (OUT / f"{name}.svg").write_text(body)


def hero():
    clean_b, clean_p = (g["terminal"]["strict_runtime_clean"] for g in (BASE, PRIME))
    retry_drop = (1 - Decimal(BASE["retries"]) / Decimal(PRIME["retries"])) * 100
    time_drop = (1 - Decimal(str(BASE["cumulative_attempt_hours"])) / Decimal(str(PRIME["cumulative_attempt_hours"]))) * 100
    p = [text(48, 48, "SYNERISE / BASE-CONTEXT", 18, GREEN, 700),
         text(1152, 48, "ONE CODING-HARNESS STUDY", 17, MUTED, 600, "end"),
         text(48, 113, "More clean finishes.", 51, INK, 700),
         text(48, 174, "Fewer retries.", 51, INK, 700),
         text(48, 213, "30 Python tasks × 3 models · 90 task/model assignments per agent", 21, MUTED),
         rect(48, 249, 704, 348), rect(776, 249, 376, 166), rect(776, 431, 376, 166),
         text(72, 286, "STRICT PASSES WITH A CLEAN RUNTIME", 18, MUTED, 700),
         text(72, 332, "Base Context", 25, GREEN, 700), text(728, 332, f"{clean_b}/90", 29, INK, 700, "end"),
         text(72, 426, "Prime Agent", 25, BLUE, 700), text(728, 426, f"{clean_p}/90", 29, INK, 700, "end")]
    for y, value, color in ((350, clean_b, GREEN), (444, clean_p, BLUE)):
        p += [rect(72, y, 656, 34, "#1c344a", 6), rect(72, y, 656*value/90, 34, color, 6)]
    for tick in (0, 30, 60, 90):
        x = 72 + 656*tick/90
        p += [line(x, 490, x, 496), text(x, 518, tick, 18, MUTED, anchor="middle")]
    p += [text(72, 563, f"+{clean_b-clean_p} clean finishes", 27, GREEN, 700),
          text(728, 562, "Same 90 assignments", 18, MUTED, anchor="end"),
          text(800, 283, "FEWER ADDITIONAL ATTEMPTS", 16, MUTED, 700),
          text(800, 344, f"{retry_drop:.1f}%", 52, GREEN, 700),
          text(800, 386, f'{BASE["retries"]} vs {PRIME["retries"]} · Base Context vs Prime Agent', 18, INK),
          text(800, 465, "LESS CUMULATIVE ATTEMPT TIME", 16, MUTED, 700),
          text(800, 526, f"{time_drop:.2f}%", 52, GREEN, 700),
          text(800, 568, f'{BASE["cumulative_attempt_hours"]:.2f} h vs {PRIME["cumulative_attempt_hours"]:.2f} h · all attempts', 19, INK),
          text(48, 643, f'Strict task passes overall: {BASE["terminal"]["strict_pass"]}/90 vs {PRIME["terminal"]["strict_pass"]}/90. Runtime cleanliness is a separate measure.', 20, INK),
          line(48, 671, 1152, 671),
          text(48, 701, "Historical SDK study: Base Context 0.1.0 vs Prime Agent 0.9.4 · shared Bash · medium effort", 18, MUTED),
          text(48, 730, "180 assigned cells · 208 effective attempts · at most one deferred retry per cell; failures and retries included", 18, MUTED),
          text(48, 759, "Time is summed lifecycle duration, not campaign wall time or user latency. Not a new 1.0.0 measurement.", 18, MUTED)]
    canvas("benchmark-overview", 790, "More clean finishes, fewer retries in one coding-harness study", "Base Context: 89 of 90 terminal strict passes with a clean runtime, versus Prime Agent 64 of 90. Additional attempts: 2 versus 26. Cumulative lifecycle attempt time: 7.30 versus 9.62 hours. Historical SDK study, not measured release 1.0.0 performance.", p)


def models():
    p = [text(48, 48, "RELIABILITY / EVERY MODEL INCLUDED", 18, GREEN, 700),
         text(48, 109, "The clean-finish advantage, by model.", 40, INK, 700),
         text(48, 151, "Terminal strict passes with a clean runtime · 30 assignments per agent and model", 21, MUTED),
         rect(48, 177, 16, 16, GREEN, 4), text(75, 193, "Base Context", 19, MUTED),
         rect(258, 177, 16, 16, BLUE, 4), text(285, 193, "Prime Agent", 19, MUTED)]
    for i, model in enumerate(("sol", "astra", "deepseek")):
        x = 48 + i*376
        b, v = GROUPS[model, "current"], GROUPS[model, "vanilla"]
        bc, vc = b["terminal"]["strict_runtime_clean"], v["terminal"]["strict_runtime_clean"]
        p += [rect(x, 219, 352, 287), text(x+22, 256, DATA["models"][model], 23, INK, 700),
              text(x+22, 291, f"+{bc-vc} clean finishes", 21, GREEN, 700)]
        for y, val, col in ((312, bc, GREEN), (365, vc, BLUE)):
            p += [rect(x+22, y, 242, 29, "#1c344a", 5), rect(x+22, y, 242*val/30, 29, col, 5), text(x+332, y+23, f"{val}/30", 19, INK, 700, "end")]
        for tick in (0, 15, 30):
            p += [text(x+22+242*tick/30, 428, tick, 17, MUTED, anchor="middle")]
        p += [text(x+22, 478, f'Strict passes: {b["terminal"]["strict_pass"]}/30 vs {v["terminal"]["strict_pass"]}/30', 18, MUTED)]
    p += [text(48, 548, "Clean = no runtime error, valid capacity and zero recorded compaction failures; strict task pass also required.", 18, MUTED),
          text(48, 578, "Common zero-based 0–30 scales. Historical SDK/shared-Bash study; not a native Python/RLM evaluation.", 18, MUTED)]
    canvas("benchmark-models", 609, "Runtime-clean strict finishes across all three benchmark models", "Sol: Base Context 30 of 30, Prime Agent 18 of 30. Astra: 30 of 30 versus 19 of 30. DeepSeek: 29 of 30 versus 27 of 30. All scales start at zero and end at thirty. These are runtime-clean strict passes, not task correctness alone.", p)


def design():
    p = [text(48, 48, "DESIGN / SOURCE-BACKED WORKING SETS", 18, GREEN, 700),
         text(48, 110, "Keep the source. Focus the request.", 42, INK, 700),
         text(48, 152, "Retained history and the context sent to the model are different things.", 22, MUTED),
         rect(48, 193, 316, 251), rect(408, 193, 360, 251), rect(812, 193, 340, 251),
         text(72, 233, "01 / RETAIN", 18, GREEN, 700),
         text(72, 274, "Source history", 29, INK, 700),
         text(72, 316, "Native session records", 21, MUTED),
         text(72, 352, "Evidence and references", 21, MUTED),
         text(72, 407, "Recover selected public text", 18, INK),
         text(432, 233, "02 / SELECT + RECOVER", 18, GREEN, 700),
         text(432, 274, "A focused working set", 26, INK, 700),
         text(432, 316, "TaskFrame: keep the task visible", 18, MUTED),
         text(432, 352, "ViewUnits: keep dependencies", 18, MUTED),
         text(432, 388, "Retrieval: recover exact evidence", 18, MUTED),
         text(836, 233, "03 / SEND", 18, GREEN, 700),
         text(836, 274, "The model request", 27, INK, 700),
         text(836, 316, "Selected evidence + task state", 18, MUTED),
         text(836, 352, "Required tool-call/result groups", 18, MUTED),
         text(836, 407, "Opt-in request-budget admission", 17, INK),
         arrow(368, 325, 403), arrow(772, 325, 807),
         rect(48, 466, 1104, 60, "#12372f", 12),
         text(72, 504, "STABLE EPOCHS", 18, GREEN, 700),
         text(280, 504, "Preserve accepted context choices across subsequent requests and restoration.", 19, INK),
         text(48, 564, "Conceptual architecture, not a token-scale diagram or a separate performance experiment.", 18, MUTED),
         text(48, 593, "Budget checks need explicit profiles and supported providers. Compaction is not deletion; summaries can lose detail.", 18, MUTED)]
    canvas("context-working-set", 625, "Base Context separates retained history from the selected model request", "Retain source-backed history, select a task-aware working set with dependency closure and evidence retrieval, then send the selected model request. Stable epochs preserve accepted context choices. Budget admission is opt-in and needs supported configured profiles. Summaries are not lossless.", p)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    hero()
    models()
    design()
    print(f"Wrote 3 SVG graphics to {OUT.relative_to(ROOT)}")
