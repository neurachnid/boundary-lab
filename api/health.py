"""Health check endpoint."""
from http.server import BaseHTTPRequestHandler
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from bridge_loader import get_bridge


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            bridge = get_bridge()
            # Get library name from the path
            lib_name = Path(bridge.path).name if hasattr(bridge, 'path') else "libbezopt.so"
            result = {
                "status": "ok",
                "backend": "native-c-api",
                "library": lib_name,
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode('utf-8'))
        except Exception as exc:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode('utf-8'))
