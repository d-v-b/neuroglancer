"""Generates the JPEG XR decoder fixtures and their expected decodes.

Each `<name>.jxr` has a `<name>.json` with the decoded shape and data type
and `<name>.raw`, the samples imagecodecs (jxrlib) decodes, little-endian,
interleaved by sample. There is one per pixel format of CZI JpgXr subblocks
(Gray8, Gray16, Gray32Float, Bgr24, Bgr48, Bgr96Float, Bgra32), written as
vzip's CZI fixtures write them (`fixtures/generators/czi/write_fixtures.py`):
imagecodecs' encoder, with the pixel format GUID rewritten to 24bppBGR or
32bppBGRA where CZI stores those. The sizes are not multiples of the 16-pixel
macroblock, and the lossy ones exercise the overlap filter.

Usage: uv run --with imagecodecs --with numpy python testdata/codec/jpegxr/generate.py
"""

import json
import struct
from pathlib import Path

import imagecodecs
import numpy as np

HERE = Path(__file__).parent
WIC = bytes.fromhex("24C3DD6F034EFE4BB1853D77768DC9")
rng = np.random.default_rng(0)
y, x = np.mgrid[0:23, 0:37]
gradient = x * 5 + y * 3


def set_format(b: bytes, guid: bytes) -> bytes:
    b = bytearray(b)
    ifd = struct.unpack_from("<I", b, 4)[0]
    for k in range(struct.unpack_from("<H", b, ifd)[0]):
        tag, _, _, value = struct.unpack_from("<HHII", b, ifd + 2 + 12 * k)
        if tag == 0xBC01:
            b[value : value + 16] = guid
    return bytes(b)


def color(scale, dtype):
    return np.stack([gradient * scale + 40 * i * scale for i in range(3)], axis=-1).astype(dtype)


images = {
    # name: (image, level, GUID or None)
    "gray8": ((gradient % 256).astype(np.uint8), 1.0, None),
    "gray8_lossy": ((gradient % 256).astype(np.uint8), 0.8, None),
    "gray16": ((gradient * 300 + rng.integers(0, 50, gradient.shape)).astype(np.uint16), 1.0, None),
    "gray32float": ((gradient / 7 - 3).astype(np.float32), 1.0, None),
    "rgb24": (color(1, np.uint8), 1.0, None),
    "bgr24": (color(1, np.uint8), 1.0, WIC + b"\x0c"),
    "bgr24_lossy": (color(1, np.uint8), 0.7, WIC + b"\x0c"),
    "bgr48": (color(150, np.uint16), 1.0, None),
    "bgr96float": (color(0.01, np.float32), 1.0, None),
    "bgra32": (
        np.concatenate([color(1, np.uint8), (gradient % 256).astype(np.uint8)[..., None]], axis=-1),
        1.0,
        WIC + b"\x0f",
    ),
}
for name, (image, level, guid) in images.items():
    encoded = imagecodecs.jpegxr_encode(image, level=level)
    if guid is not None:
        encoded = set_format(encoded, guid)
    (HERE / f"{name}.jxr").write_bytes(encoded)

for path in sorted(HERE.glob("*.jxr")):
    decoded = imagecodecs.jpegxr_decode(path.read_bytes())
    name = path.stem
    path.with_suffix(".raw").write_bytes(decoded.astype(decoded.dtype.newbyteorder("<")).tobytes())
    path.with_suffix(".json").write_text(
        json.dumps({"shape": list(decoded.shape), "dtype": decoded.dtype.name}) + "\n"
    )
    print(name, decoded.shape, decoded.dtype, path.stat().st_size)
