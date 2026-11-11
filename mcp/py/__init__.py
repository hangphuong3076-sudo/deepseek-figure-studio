"""shared/py — Python helpers shared by the v2 server and the v3 agent plugin.

Modules:
    figraster  document -> raster image (Pillow), TIFF/PNG/JPEG/PDF export,
               structural document validation.

This package deliberately performs no imports at load time so that
``import shared.py`` stays cheap; import ``figraster`` explicitly when needed
(it pulls in Pillow). The v2-server keeps a byte-identical copy of this
directory under ``v2-server/py/``.
"""

__all__ = ["figraster"]
