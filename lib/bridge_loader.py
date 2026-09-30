"""Shared bridge loader for Boundary Lab Vercel functions."""
import os
import sys
from pathlib import Path

# Add the lib directory to sys.path so we can import bezopt_bridge
_LIB_DIR = Path(__file__).resolve().parent
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from bezopt_bridge import BezoptLibrary  # noqa: E402

_bridge = None

def get_bridge():
    """Get or create the shared BezoptLibrary instance."""
    global _bridge
    if _bridge is None:
        # The .so is in the same directory as this file
        so_path = _LIB_DIR / "libbezopt.so"
        _bridge = BezoptLibrary(str(so_path))
    return _bridge
