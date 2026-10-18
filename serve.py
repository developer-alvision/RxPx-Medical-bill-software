"""Serve only the bill app's public files, never the other documents on this drive."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse
import mimetypes

ROOT = Path(__file__).resolve().parent
PUBLIC_FILES = {
    "medical bills.html", "app-config.js", "medical-bills.js",
    "bill-extraction.js", "bill-export.js", "supabase-setup.sql", "README.md",
}


class AppHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.respond(head=True)

    def do_GET(self):
        self.respond()

    def respond(self, head=False):
        name = unquote(urlsplit(self.path).path).lstrip("/") or "medical bills.html"
        if name == "index.html":
            name = "medical bills.html"
        if name not in PUBLIC_FILES or not (ROOT / name).is_file():
            self.send_error(404)
            return
        data = (ROOT / name).read_bytes()
        content_type = mimetypes.guess_type(name)[0] or "text/plain"
        if name.endswith(".js"):
            content_type = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head:
            self.wfile.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5500)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), AppHandler)
    print(f"RxPx Bills: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
