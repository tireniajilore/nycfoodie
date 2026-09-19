#!/usr/bin/env python3
"""Build the NYCfoodie hype demo: an animated replay of a real MCP tool-call
trace (demo-trace.json) rendered as an agent chat. Output: nycfoodie-demo.html"""
import json, html

trace = json.load(open("demo-trace.json"))
by_tool = {s["tool"]: s["result"] for s in trace}

search = by_tool["search_restaurants"][:3]
detail = by_tool["get_restaurant"]
compare = by_tool["compare_restaurants"]
consensus = by_tool["guide_consensus"][:3]

def esc(s): return html.escape(str(s))

def stars(r):
    full = int(round(r / 2))
    return "★" * full + "☆" * (5 - full)

search_rows = "\n".join(
    f'<div class="res"><div><b>{esc(v["name"])}</b><span class="hood">{esc((v.get("neighborhoods") or [""])[0])}</span></div>'
    f'<div class="rating">{v["rating"]:.1f} <span class="stars">{stars(v["rating"])}</span></div></div>'
    for v in search
)

compare_rows = "\n".join(
    f'<div class="res"><div><b>{esc(v["name"])}</b><span class="hood">{esc(v.get("neighborhood",""))} · {"$" * int(v.get("price_tier") or 2)}</span></div>'
    f'<div class="rating">{v["rating"]:.1f} <span class="stars">{stars(v["rating"])}</span></div></div>'
    for v in compare
)

consensus_rows = "\n".join(
    f'<div class="res"><div><b>{esc(v["name"])}</b></div>'
    f'<div class="rating">{v["rating"]:.1f} · <span class="gc">{v["guide_count"]} guides</span></div></div>'
    for v in consensus
)

rev = detail["review"] if isinstance(detail.get("review"), dict) else {}
resy = (detail.get("reservation") or {}).get("url", "")

steps = [
    ("user", "Find me a romantic Italian spot for date night in the West Village. Somewhere the critics actually love.", None),
    ("tool", "search_restaurants", {"query": "date night Italian", "city": "new-york"},
     "3 candidates, ranked by critic rating", search_rows),
    ("tool", "get_restaurant", {"id": "Via Carota", "city": "new-york"},
     "Full picture: review, booking intel, Resy link",
     f'<div class="res"><div><b>{esc(detail["name"])}</b><span class="hood">{esc(detail["address"]["line1"])} · {esc((detail.get("tags") or {}).get("neighborhood", [""])[0] if isinstance(detail.get("tags"), dict) else "")}</span></div>'
     f'<div class="rating">{detail["rating"]:.1f} <span class="stars">{stars(detail["rating"])}</span></div></div>'
     f'<p class="headline">“{esc(rev.get("headline", ""))}”</p>'),
    ("tool", "compare_restaurants", {"restaurants": ["Via Carota", "Lilia", "Torrisi"], "city": "new-york"},
     "Head-to-head on the shortlist", compare_rows),
    ("tool", "guide_consensus", {"theme": "Italian", "city": "new-york"},
     "Cross-guide consensus — who can't you go wrong with?", consensus_rows),
    ("agent", None, None,
     "Via Carota. 9.5 from the critics — the highest-rated Italian date-night spot in the data — and it shows up across the guides. Heads up: it's mostly walk-in, expect a wait, and it's worth it.",
     f'<a class="cta" href="{esc(resy)}">Book on Resy →</a>' if resy else ""),
]

html_parts = []
for i, s in enumerate(steps):
    kind = s[0]
    if kind == "user":
        html_parts.append(f'<div class="msg user" data-i="{i}"><div class="bubble">{esc(s[1])}</div></div>')
    elif kind == "agent":
        html_parts.append(f'<div class="msg agent" data-i="{i}"><div class="avatar">🍝</div><div class="bubble">{esc(s[3])}{s[4]}</div></div>')
    else:
        _, tool, args, caption, body = s
        argstr = " ".join(f'{k}="{v}"' for k, v in args.items())
        html_parts.append(
            f'<div class="msg tool" data-i="{i}"><div class="chip">⚙️ {esc(tool)} <span class="args">{esc(argstr)}</span></div>'
            f'<div class="tresult"><div class="tcap">{esc(caption)}</div>{body}</div></div>')

page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NYCfoodie — watch an agent plan dinner</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0f0f12;color:#e8e8ea;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;min-height:100vh}
.wrap{width:100%;max-width:620px;padding:24px 16px 64px}
header{text-align:center;margin-bottom:20px}header h1{font-size:1.4rem;margin:0 0 4px}header p{color:#9a9aa0;font-size:.9rem;margin:0}
.msg{margin:14px 0;opacity:0;transform:translateY(8px);transition:opacity .4s,transform .4s}.msg.show{opacity:1;transform:none}
.bubble{display:inline-block;padding:10px 14px;border-radius:16px;max-width:100%;line-height:1.5}
.user{text-align:right}.user .bubble{background:#2b5cff;color:#fff;border-bottom-right-radius:4px;text-align:left}
.agent{display:flex;gap:10px}.agent .bubble{background:#1c1c21;border-bottom-left-radius:4px}
.avatar{font-size:1.4rem}
.tool .chip{display:inline-block;background:#141419;border:1px solid #2e2e38;color:#8ef0a0;font-family:ui-monospace,monospace;font-size:.78rem;padding:6px 10px;border-radius:8px;margin-bottom:6px}
.tool .args{color:#7a7a85}
.tresult{background:#141419;border:1px solid #2e2e38;border-radius:12px;padding:12px 14px;margin-left:8px}
.tcap{color:#9a9aa0;font-size:.8rem;margin-bottom:8px}
.res{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid #23232b}.res:first-of-type{border-top:none}
.hood{color:#9a9aa0;font-size:.8rem;margin-left:8px}
.rating{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.stars{color:#f5b301;font-size:.85rem}.gc{color:#8ef0a0;font-size:.85rem}
.headline{font-style:italic;color:#c9c9d1;margin:10px 0 2px}
.cta{display:inline-block;margin-top:10px;background:#2b5cff;color:#fff;text-decoration:none;padding:8px 16px;border-radius:10px;font-weight:600}
footer{text-align:center;color:#6a6a72;font-size:.8rem;margin-top:32px}
#replay{display:block;margin:8px auto 0;background:#1c1c21;color:#e8e8ea;border:1px solid #2e2e38;border-radius:10px;padding:8px 20px;cursor:pointer;font-size:.9rem}
</style></head><body><div class="wrap">
<header><h1>🍝 NYCfoodie</h1><p>Watch an AI agent plan date night — powered by the NYCfoodie MCP server</p></header>
<div id="chat">
""" + "\n".join(html_parts) + """
</div>
<button id="replay">↻ Replay</button>
<footer>Real session replay · live data from the NYCfoodie MCP endpoint · nycfoodie-production.up.railway.app/mcp</footer>
</div>
<script>
const msgs=[...document.querySelectorAll('.msg')];let t;
function play(){clearTimeout(t);msgs.forEach(m=>m.classList.remove('show'));let i=0;
(function next(){if(i>=msgs.length)return;msgs[i].classList.add('show');msgs[i].scrollIntoView({behavior:'smooth',block:'nearest'});i++;t=setTimeout(next,i===1?900:1600);})();}
document.getElementById('replay').onclick=play;play();
</script></body></html>"""

open("nycfoodie-demo.html", "w").write(page)
print("wrote nycfoodie-demo.html", len(page), "bytes")
