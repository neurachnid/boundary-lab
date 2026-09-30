"""export-flat-svg endpoint."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from post_base import PostHandler


class handler(PostHandler):
    method_name = "export_flat_svg"
