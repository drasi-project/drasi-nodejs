#!/usr/bin/env python3
# Copyright 2026 The Drasi Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Render Docsy/Hugo tutorial sources into plain Markdown READMEs.

Each tutorial is authored once in an ``_index.md`` that may use Docsy/Hugo
shortcodes (``{{< tabpane >}}``, ``{{% alert %}}``, ...). The doc site consumes
``_index.md`` directly so the tab widgets and styled alerts render. GitHub and
plain Markdown viewers cannot process shortcodes, so this script generates a
sibling ``README.md`` with the shortcodes converted to equivalent plain
Markdown.

Source of truth:   tutorials/<name>/_index.md   (shortcodes, used by doc site)
Generated output:  tutorials/<name>/README.md   (plain Markdown, shown on GitHub)

Usage:
    python3 scripts/render-tutorials.py          # write README.md files
    python3 scripts/render-tutorials.py --check   # fail if any are stale
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TUTORIALS_DIR = REPO_ROOT / "tutorials"

GENERATED_BANNER = (
    "<!-- DO NOT EDIT. Generated from _index.md by scripts/render-tutorials.py. "
    "Edit _index.md and run `python3 scripts/render-tutorials.py`. -->\n\n"
)

_ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')

_FRONT_MATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)

_TABPANE_RE = re.compile(
    r"\{\{<\s*tabpane[^}]*>\}\}(?P<body>.*?)\{\{<\s*/\s*tabpane\s*>\}\}",
    re.DOTALL,
)
_CODE_TAB_RE = re.compile(
    r"\{\{<\s*tab\s+(?P<attrs>[^}]*?)>\}\}(?P<body>.*?)\{\{<\s*/\s*tab\s*>\}\}",
    re.DOTALL,
)
_MD_TAB_RE = re.compile(
    r"\{\{%\s*tab\s+(?P<attrs>[^}]*?)%\}\}(?P<body>.*?)\{\{%\s*/\s*tab\s*%\}\}",
    re.DOTALL,
)
_ALERT_RE = re.compile(
    r"\{\{%\s*alert\s+(?P<attrs>[^}]*?)%\}\}(?P<body>.*?)\{\{%\s*/\s*alert\s*%\}\}",
    re.DOTALL,
)
_CARD_GRID_RE = re.compile(
    r'^<div\s+class="card-grid">\n(?P<body>.*?)\n</div>[ \t]*$',
    re.DOTALL | re.MULTILINE,
)
_CARD_RE = re.compile(
    r'<a\s+href="(?P<href>[^"]+)">.*?'
    r'unified-card-title">(?P<title>.*?)</h3>.*?'
    r'unified-card-summary">(?P<summary>.*?)</p>.*?</a>',
    re.DOTALL,
)
_FLOW_DIAGRAM_RE = re.compile(
    r'^<div\s+class="flow-diagram">\n(?P<body>.*?)\n</div>[ \t]*$',
    re.DOTALL | re.MULTILINE,
)
_FLOW_STEP_RE = re.compile(
    r'flow-step__label">(?P<label>.*?)</div>.*?'
    r'flow-step__description">(?P<description>.*?)</div>',
    re.DOTALL,
)


def _parse_attrs(raw: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in _ATTR_RE.finditer(raw)}


def _render_tabpane(match: re.Match[str]) -> str:
    body = match.group("body")

    rendered: list[tuple[int, str]] = []

    for m in _CODE_TAB_RE.finditer(body):
        attrs = _parse_attrs(m.group("attrs"))
        header = attrs.get("header", "").strip()
        lang = attrs.get("lang", "").strip()
        code = m.group("body").strip("\n")
        block = f"**{header}**\n\n```{lang}\n{code}\n```"
        rendered.append((m.start(), block))

    for m in _MD_TAB_RE.finditer(body):
        attrs = _parse_attrs(m.group("attrs"))
        header = attrs.get("header", "").strip()
        content = m.group("body").strip("\n")
        block = f"**{header}**\n\n{content}"
        rendered.append((m.start(), block))

    rendered.sort(key=lambda item: item[0])
    return "\n\n".join(block for _, block in rendered)


def _render_alert(match: re.Match[str]) -> str:
    attrs = _parse_attrs(match.group("attrs"))
    title = attrs.get("title", "").strip()
    body = match.group("body").strip("\n")

    lines: list[str] = []
    if title:
        lines.append(f"> **{title}**")
        lines.append(">")
    for line in body.splitlines():
        lines.append(">" if not line.strip() else f"> {line}")
    return "\n".join(lines)


def _render_card_grid(match: re.Match[str]) -> str:
    """Convert a Docsy ``card-grid`` of link cards into a Markdown list.

    GitHub renders ``<a href><div>...</div></a>`` cards as empty links because
    it hoists the block-level ``<div>`` out of the anchor. The doc site keeps
    the cards; here we emit a plain bullet list of named links instead.
    """
    items: list[str] = []
    for card in _CARD_RE.finditer(match.group("body")):
        href = card.group("href").strip()
        title = " ".join(card.group("title").split())
        summary = " ".join(card.group("summary").split())
        items.append(f"- **[{title}]({href})** — {summary}")
    return "\n".join(items) if items else match.group(0)


def _render_flow_diagram(match: re.Match[str]) -> str:
    """Convert a Docsy ``flow-diagram`` into a Markdown arrow chain plus list.

    GitHub renders the nested ``<div>`` steps as stray words, so we emit an
    arrow chain of the step labels followed by a bullet list of each step's
    description. The doc site keeps the styled diagram.
    """
    steps = [
        (" ".join(m.group("label").split()), " ".join(m.group("description").split()))
        for m in _FLOW_STEP_RE.finditer(match.group("body"))
    ]
    if not steps:
        return match.group(0)

    chain = " → ".join(f"**{label}**" for label, _ in steps)
    bullets = "\n".join(f"- **{label}** — {desc}" for label, desc in steps)
    return f"{chain}\n\n{bullets}"


_HEADING_ID_RE = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<text>.*?)\s*\{#(?P<id>[\w-]+)\}\s*$", re.MULTILINE)


def _github_slug(text: str) -> str:
    """Approximate GitHub's heading-to-anchor slug algorithm."""
    slug = text.strip().lower()
    # Drop characters GitHub strips (anything not a word char, space, or hyphen).
    slug = re.sub(r"[^\w\s-]", "", slug)
    # Collapse whitespace runs to single hyphens.
    slug = re.sub(r"\s+", "-", slug)
    return slug


def _rewrite_heading_ids(source: str) -> str:
    """Strip Hugo ``{#id}`` heading attributes and repoint in-page links.

    Hugo uses ``## Title {#id}`` to set an explicit anchor, and links such as
    ``[Title](#id)`` rely on it. Plain Markdown viewers render the ``{#id}``
    literally and instead auto-generate anchors from the heading text, so we
    remove the attribute and rewrite every ``#id`` link to the slug GitHub
    derives from the heading text.
    """
    id_to_slug: dict[str, str] = {}
    for match in _HEADING_ID_RE.finditer(source):
        id_to_slug[match.group("id")] = _github_slug(match.group("text"))

    # Remove the {#id} attribute from headings.
    out = _HEADING_ID_RE.sub(lambda m: f"{m.group('hashes')} {m.group('text')}", source)

    # Repoint in-page links that targeted the explicit ids.
    def _replace_link(m: re.Match[str]) -> str:
        slug = id_to_slug.get(m.group("id"))
        return f"](#{slug})" if slug else m.group(0)

    out = re.sub(r"\]\(#(?P<id>[\w-]+)\)", _replace_link, out)
    return out


def render(source: str) -> str:
    out = _FRONT_MATTER_RE.sub("", source)
    out = _rewrite_heading_ids(out)
    out = _CARD_GRID_RE.sub(_render_card_grid, out)
    out = _FLOW_DIAGRAM_RE.sub(_render_flow_diagram, out)
    out = _TABPANE_RE.sub(_render_tabpane, out)
    out = _ALERT_RE.sub(_render_alert, out)
    # Collapse 3+ blank lines that conversions can introduce.
    out = re.sub(r"\n{4,}", "\n\n\n", out)
    return GENERATED_BANNER + out.lstrip("\n")


def iter_sources() -> list[Path]:
    if not TUTORIALS_DIR.is_dir():
        return []
    return sorted(TUTORIALS_DIR.glob("*/_index.md"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify generated READMEs are up to date; do not write.",
    )
    args = parser.parse_args()

    sources = iter_sources()
    if not sources:
        print("No tutorials/*/_index.md sources found.", file=sys.stderr)
        return 0

    stale: list[Path] = []
    for source in sources:
        target = source.with_name("README.md")
        expected = render(source.read_text(encoding="utf-8"))
        current = target.read_text(encoding="utf-8") if target.exists() else None

        if args.check:
            if current != expected:
                stale.append(target)
            continue

        if current != expected:
            target.write_text(expected, encoding="utf-8")
            print(f"rendered {target.relative_to(REPO_ROOT)}")
        else:
            print(f"unchanged {target.relative_to(REPO_ROOT)}")

    if args.check and stale:
        print(
            "The following generated READMEs are out of date:\n"
            + "\n".join(f"  - {p.relative_to(REPO_ROOT)}" for p in stale)
            + "\n\nRun `python3 scripts/render-tutorials.py` and commit the result.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
