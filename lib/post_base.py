"""Base class for POST API handlers."""
from http.server import BaseHTTPRequestHandler
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from bridge_loader import get_bridge
from bezopt_bridge import BezoptInputError

MAX_REQUEST_BYTES = 64 * 1024 * 1024


class PostHandler(BaseHTTPRequestHandler):
    """Base class for POST endpoints that call bridge methods."""
    
    # Subclasses set this to the bridge method name
    method_name = None
    
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self._send_json(400, {"error": "invalid Content-Length"})
            return
        
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "request size is invalid or exceeds 64 MiB"})
            return
        
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "request body must be valid UTF-8 JSON"})
            return
        
        try:
            bridge = get_bridge()
            method = getattr(bridge, self.method_name)
            result = method(payload)
            self._send_json(200, result)
        except BezoptInputError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": f"native bridge failure: {exc}"})
    
    def _send_json(self, status, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
