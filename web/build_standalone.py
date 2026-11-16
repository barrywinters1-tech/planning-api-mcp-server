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
    inner = inner.replace('<script src="/static/app.js"></script>', "")
    engine = read("engine.js")
    backend = read("local_backend.js")
    app = read("app.js")

    # route api() through the in-browser backend
    app = app.replace(
        "async function api(path, opts = {}) { const r = await fetch(path, opts); if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { } throw new Error(m); } return r.json(); }",
        "async function api(path, opts = {}) { const method = opts.method || 'GET'; let body = opts.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } } try { return await window.__local.route(method, path, body); } catch (e) { throw new Error(e && e.detail ? e.detail : ((e && e.message) || 'error')); } }",
    )
    # import via local file reader
    app = app.replace(
        "const fd = new FormData(); fd.append('file', f); toast('Importing ' + f.name + "
        + "'…'); try { show(await api('/api/import', { method: 'POST', body: fd }));",
        "toast('Importing ' + f.name + '…'); try { show(await window.__local.importFile(f));",
    )
    app = app.replace("} catch (err) { toast(err.message, 6000); } e.target.value = ''; };",
                      "} catch (err) { toast((err && err.detail) || err.message, 7000); } e.target.value = ''; };")
    # export via local download
    app = app.replace(
        "$$('[data-x]').forEach(a => a.onclick = () => { if (S.pid) location.href = '/api/projects/' + encodeURIComponent(S.pid) + '/export.' + a.dataset.x; });",
        "$$('[data-x]').forEach(a => a.onclick = async () => { if (S.pid) try { await window.__local.download(S.pid, a.dataset.x); } catch (e) { toast((e && e.detail) || e.message, 6000); } });",
    )
    # seed the demo project on first load
    app = app.replace(
        "}); } catch { }\n  wireToolbar();",
        "}); } catch { }\n  try { const all = JSON.parse(localStorage.getItem('planner:projects') || '{}'); if (!Object.keys(all).length) window.__local.store(window.__DEMO); } catch (e) { }\n  wireToolbar();",
        1,
    )

    demo = json.loads((ROOT / "examples" / "demo_house.json").read_text())
    seed = json.dumps(demo, separators=(",", ":"))

    html = (
        '<meta charset="utf-8">\n'
        "<title>Planner — construction scheduling</title>\n"
        "<style>\n" + styles + "\n</style>\n"
        + inner
        + "\n<script>window.__DEMO = " + seed + ";</script>\n"
        + "<script>\n" + engine + "\n</script>\n"
        + "<script>\n" + backend + "\n</script>\n"
        + "<script>\n" + app + "\n</script>\n"
    )
    out = HERE / "standalone.html"
    out.write_text(html, encoding="utf-8")
    print("built", out, len(html.encode("utf-8")), "bytes")


if __name__ == "__main__":
    main()
