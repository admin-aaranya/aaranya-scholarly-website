# Generates the seven journal marks.
#
# Family logic: every mark shares the parent identity's signature -- a gold
# rule with round caps beneath the glyph -- and identical geometry, stroke
# weight and corner radius. Only the glyph and the accent colour change.
# Generated rather than hand-drawn so that consistency is guaranteed instead
# of maintained by hand across seven files.

import os

OUT = "/sessions/modest-quirky-sagan/mnt/Aaranya Scholarly/website/assets/logo/journals"
GOLD = "#c8912a"

JOURNALS = {
    # code: (accent, tint, glyph-svg, human name)
    "alstm": ("#0f5d73", "#e7f0f3", """
    <!-- Double helix: life sciences and translational medicine -->
    <path d="M34 24C34 38 62 42 62 56C62 70 34 74 34 88" />
    <path d="M62 24C62 38 34 42 34 56C34 70 62 74 62 88" />
    <path d="M39 34h18M37 46h22M37 66h22M39 78h18" stroke-width="3.4" />
    """, "Advanced Life Sciences & Translational Medicine"),

    "ipsb": ("#3d5a99", "#e9edf6", """
    <!-- Atom: physical sciences and bioengineering -->
    <circle cx="48" cy="54" r="7.5" />
    <ellipse cx="48" cy="54" rx="26" ry="11" />
    <ellipse cx="48" cy="54" rx="26" ry="11" transform="rotate(60 48 54)" />
    <ellipse cx="48" cy="54" rx="26" ry="11" transform="rotate(-60 48 54)" />
    """, "Interdisciplinary Physical Sciences & Bioengineering"),

    "ghesb": ("#2e7d4f", "#e7f2ea", """
    <!-- Globe with leaf: global health, environment, sustainability -->
    <circle cx="48" cy="52" r="24" />
    <path d="M48 28c-9 8-9 40 0 48M48 28c9 8 9 40 0 48" />
    <path d="M25 44h46M25 60h46" stroke-width="3" />
    <path d="M62 30c8-6 14-4 14-4s1 7-5 12-11 3-11 3 -2-7 2-11Z" fill="#fff" />
    """, "Global Health, Environment & Sustainable Biosciences"),

    "jec": ("#b5651d", "#f7ece1", """
    <!-- Confluence: separate streams meeting and continuing as one -->
    <path d="M24 24C24 44 40 48 48 56" />
    <path d="M72 24C72 44 56 48 48 56" />
    <path d="M48 56v26" />
    <circle cx="48" cy="56" r="5.5" fill="#fff" />
    """, "Journal of Engineering Confluence"),

    "jtim": ("#9c4a6b", "#f6e9ef", """
    <!-- Integration: two fields overlapping, with a medical cross in the
         intersection. Deliberately not the Y-with-crossbar first drafted:
         at small sizes that read as the Venus symbol, which is both a
         gendered glyph and nearly identical to the JEC confluence mark. -->
    <circle cx="37" cy="50" r="20" />
    <circle cx="59" cy="50" r="20" />
    <path d="M48 41v18M39 50h18" stroke-width="4.6" />
    """, "Journal of Translational & Integrated Medicine"),

    "jsamp": ("#a97418", "#f7f0e1", """
    <!-- Ascending strategy: measured steps and direction -->
    <path d="M24 78V58M40 78V46M56 78V52M72 78V32" />
    <path d="M24 40l16-12 16 8 18-16" />
    <path d="M64 20h10v10" />
    """, "Journal of Strategic Advisory & Management Practice"),

    "acfdi": ("#6b4a9c", "#efeaf6", """
    <!-- Connected nodes: computation and digital intelligence -->
    <path d="M30 34l36 16M30 34v34M66 50L30 68M66 50V26" />
    <circle cx="30" cy="30" r="6.5" fill="#fff" />
    <circle cx="66" cy="50" r="6.5" fill="#fff" />
    <circle cx="30" cy="72" r="6.5" fill="#fff" />
    <circle cx="72" cy="76" r="5" fill="#fff" />
    <path d="M66 50l6 26" />
    """, "Annals of Computational Frontiers & Digital Intelligence"),
}

TEMPLATE = """<!--
  {name}
  Journal mark, part of the Aaranya Scholarly family.

  Shared with every sibling: the rounded tile, the 5.2 stroke weight, and the
  gold rule beneath the glyph, which is the signature carried over from the
  parent identity. Only the glyph and accent colour distinguish this one.

  Generated, not hand-drawn, so the seven stay consistent.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="{name}">
  <rect width="96" height="96" rx="14" fill="{tint}"/>
  <g fill="none" stroke="{accent}" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round">
{glyph}  </g>
  <path d="M30 88h36" stroke="{gold}" stroke-width="5" stroke-linecap="round"/>
</svg>
"""

os.makedirs(OUT, exist_ok=True)
for code, (accent, tint, glyph, name) in JOURNALS.items():
    # "&" is not legal raw in XML -- it appears in six of the seven
    # journal names and silently breaks the file.
    safe = name.replace("&", "&amp;")
    svg = TEMPLATE.format(name=safe, tint=tint, accent=accent, glyph=glyph, gold=GOLD)
    import xml.dom.minidom
    try:
        xml.dom.minidom.parseString(svg)
    except Exception as e:
        raise SystemExit(f"REFUSING to write {code}.svg -- invalid XML: {e}")
    with open(f"{OUT}/{code}.svg", "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"  {code:6s} {accent}  {name}")
