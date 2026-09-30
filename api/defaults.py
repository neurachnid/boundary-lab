"""Defaults endpoint."""
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
            result = {
                "options": bridge.defaults(),
                "preprocessor_options": bridge.preprocess_defaults(),
                "fitter_options": bridge.fit_defaults(),
                "raster_options": bridge.raster_defaults(),
                "raster_optimizer_options": bridge.raster_optimize_defaults(),
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
