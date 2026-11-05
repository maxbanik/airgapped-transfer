#!/usr/bin/env python3
"""Builds the self-contained pages in the project root from build/.

    python3 build/build.py

Outputs: sender.html (v2, offline), receiver.html (v2, for GitHub Pages),
sender-classic.html (v1, compatible with the original hosted scanner).
"""
import base64, hashlib, pathlib, re

B = pathlib.Path(__file__).resolve().parent
ROOT = B.parent
MAX_CHUNK = 1000  # bytes per QR code; verified with capacity sweep (see README)


def sri(p):
    return "sha512-" + base64.b64encode(hashlib.sha512(p.read_bytes()).digest()).decode()


def js(p):
    s = p.read_text()
    if re.search(r"</script", s, re.I):
        raise SystemExit(f"{p} contains '</script' and can't be inlined safely")
    return s


def build(template, out, subs):
    html = (B / template).read_text()
    for k, v in subs.items():
        if k not in html:
            raise SystemExit(f"placeholder {k} missing in {template}")
        html = html.replace(k, v)
    left = re.findall(r"__[A-Z_]+__", html.split("<script>")[0])
    if left:
        raise SystemExit(f"unreplaced placeholders in {template}: {left}")
    (ROOT / out).write_text(html)
    print(f"{out:22} {len(html.encode()):>8} bytes")


V = B / "vendor"
proto = js(B / "protocol.js")
build("sender.template.html", "sender.html", {
    "__QRGEN_SRI__": sri(V / "qrcodegen-1.8.0.js"), "__PAKO_SRI__": sri(V / "pako_deflate.min.js"),
    "__QRGEN_JS__": js(V / "qrcodegen-1.8.0.js"), "__PAKO_JS__": js(V / "pako_deflate.min.js"),
    "__PROTOCOL_JS__": proto, "__MAXCHUNK__": str(MAX_CHUNK),
})
build("receiver.template.html", "receiver.html", {
    "__ZBAR_SRI__": sri(V / "zbar-wasm-0.11.0-inlined.js"), "__PAKO_SRI__": sri(V / "pako_inflate.min.js"),
    "__ZBAR_JS__": js(V / "zbar-wasm-0.11.0-inlined.js"), "__PAKO_JS__": js(V / "pako_inflate.min.js"),
    "__PROTOCOL_JS__": proto,
})
C = B / "classic"
build("classic/sender-classic.template.html", "sender-classic.html", {
    "__QR_SRI__": sri(C / "qrcode.min.js"), "__PAKO_SRI__": sri(V / "pako_deflate.min.js"),
    "__QR_JS__": js(C / "qrcode.min.js"), "__PAKO_JS__": js(V / "pako_deflate.min.js"),
})
