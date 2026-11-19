"""Assemble web/standalone.html from styles, index body, engine, local backend and UI.

Run from the repo root:  python web/build_standalone.py
"""
import re
import json
import pathlib

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent


def read(p):
    return (HERE / p).read_text(encoding="utf-8")


def main():
    styles = read("styles.css")
    inner = re.search(r"<body>(.*)</body>", read("index.html"), re.S).group(1)
    inner = re.sub(r'<script src="/static/[^"]+"></script>\s*', "", inner)
    engine = read("engine.js")
    # file readers (P6 XER, P6 XML, MS Project XML) ported from planner/*.py; parity tested
    readers = "\n".join(read(f) for f in ("import_xer.js", "import_xml.js", "import_any.js", "compare.js", "briefing.js", "pdf_export.js") if (HERE / f).exists())
    backend = read("local_backend.js")
    app = read("app.js")

    # app.js detects window.__local itself, so it is bundled unchanged

    demo = json.loads((ROOT / "examples" / "demo_house.json").read_text())
    seed = json.dumps(demo, separators=(",", ":"))

    html = (
        '<meta charset="utf-8">\n'
        "<title>Planner — construction scheduling</title>\n"
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        "<style>\n" + styles + "\n</style>\n"
        + inner
        + "\n<script>window.__DEMO = " + seed + ";</script>\n"
        + "<script>\n" + engine + "\n</script>\n"
        + "<script>\n" + readers + "\n</script>\n"
        + "<script>\n" + backend + "\n</script>\n"
        + "<script>\n" + app + "\n</script>\n"
    )
    out = HERE / "standalone.html"
    out.write_text(html, encoding="utf-8")
    print("built", out, len(html.encode("utf-8")), "bytes")


if __name__ == "__main__":
    main()
