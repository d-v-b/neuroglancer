#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tifffile",
#     "imagecodecs",
#     "numpy",
# ]
# ///
"""Generates small GeoTIFF files for testing src/datasource/geotiff.

The pixel values follow closed-form patterns (see `pattern`), which the tests
reproduce in TypeScript.
"""

import pathlib

import numpy as np
import tifffile

OUT = pathlib.Path(__file__).parent

WIDTH = 70
HEIGHT = 45


def pattern(dtype, height, width, samples):
    y, x, c = np.meshgrid(
        np.arange(height), np.arange(width), np.arange(samples), indexing="ij"
    )
    dtype = np.dtype(dtype)
    if dtype.kind == "f":
        return (x * 0.5 - y * 0.25 + c * 3.0).astype(dtype)
    if dtype == np.uint8:
        return ((x * 3 + y * 7 + c * 11) % 256).astype(dtype)
    if dtype == np.int16:
        return (x * 37 - y * 101 + c * 7).astype(dtype)
    return (x * 1000 + y * 3 + c * 17).astype(dtype)


def utm_geokeys(epsg):
    # KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys
    return [
        1, 1, 0, 3,
        1024, 0, 1, 1,  # GTModelTypeGeoKey = Projected
        1025, 0, 1, 1,  # GTRasterTypeGeoKey = PixelIsArea
        3072, 0, 1, epsg,  # ProjectedCSTypeGeoKey
    ]  # fmt: skip


def geographic_geokeys():
    return [
        1, 1, 0, 3,
        1024, 0, 1, 2,  # GTModelTypeGeoKey = Geographic
        1025, 0, 1, 2,  # GTRasterTypeGeoKey = PixelIsPoint
        2048, 0, 1, 4326,  # GeographicTypeGeoKey
    ]  # fmt: skip


def user_defined_tm_geokeys():
    # User-defined transverse Mercator (equivalent to UTM zone 33N).
    return [
        1, 1, 0, 9,
        1024, 0, 1, 1,
        1025, 0, 1, 1,
        2048, 0, 1, 4326,
        3072, 0, 1, 32767,
        3075, 0, 1, 1,  # ProjCoordTransGeoKey = TransverseMercator
        3080, 34736, 1, 0,  # ProjNatOriginLongGeoKey
        3082, 34736, 1, 1,  # ProjFalseEastingGeoKey
        3092, 34736, 1, 2,  # ProjScaleAtNatOriginGeoKey
        3076, 0, 1, 9001,  # ProjLinearUnitsGeoKey = meter
    ]  # fmt: skip


def georef_tags(
    geokeys, pixel_scale=None, tiepoint=None, transformation=None, doubles=None
):
    tags = [(34735, "H", len(geokeys), geokeys, True)]
    if pixel_scale is not None:
        tags.append((33550, "d", 3, pixel_scale, True))
    if tiepoint is not None:
        tags.append((33922, "d", 6, tiepoint, True))
    if transformation is not None:
        tags.append((34264, "d", 16, transformation, True))
    if doubles is not None:
        tags.append((34736, "d", len(doubles), doubles, True))
    return tags


def write(name, data, *, overviews=0, extratags=(), **kwargs):
    path = OUT / name
    with tifffile.TiffWriter(path, bigtiff=kwargs.pop("bigtiff", False)) as tif:
        tif.write(data, extratags=list(extratags), **kwargs)
        level = data
        for _ in range(overviews):
            level = level[::2, ::2]
            tif.write(level, subfiletype=1, **kwargs)
    print("wrote", path)


def main():
    rgb = pattern(np.uint8, HEIGHT, WIDTH, 3)
    write(
        "utm_rgb_deflate_predictor.tif",
        rgb,
        overviews=2,
        photometric="rgb",
        compression="zlib",
        predictor=True,
        tile=(32, 32),
        extratags=georef_tags(
            utm_geokeys(32633),
            pixel_scale=[10.0, 10.0, 0.0],
            tiepoint=[0.0, 0.0, 0.0, 399960.0, 4200000.0, 0.0],
        )
        + [(42113, "s", 0, "0", True)],
    )
    write(
        "geographic_uint16_lzw_bigtiff.tif",
        pattern(np.uint16, HEIGHT, WIDTH, 1)[..., 0],
        photometric="minisblack",
        compression="lzw",
        predictor=True,
        tile=(16, 32),
        bigtiff=True,
        extratags=georef_tags(
            geographic_geokeys(),
            pixel_scale=[0.25, 0.25, 0.0],
            tiepoint=[0.0, 0.0, 0.0, 10.0, 50.0, 0.0],
        ),
    )
    write(
        "float32_planar_floatpredictor.tif",
        np.moveaxis(pattern(np.float32, HEIGHT, WIDTH, 2), -1, 0),
        photometric="minisblack",
        planarconfig="separate",
        compression="zlib",
        predictor=3,
        tile=(32, 32),
        extratags=georef_tags(
            utm_geokeys(32633),
            transformation=[
                10.0,
                0.0,
                0.0,
                399960.0,
                0.0,
                -10.0,
                0.0,
                4200000.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ],  # fmt: skip
        ),
    )
    write(
        "int16_packbits_strips.tif",
        pattern(np.int16, HEIGHT, WIDTH, 1)[..., 0],
        photometric="minisblack",
        compression="packbits",
        rowsperstrip=7,
        extratags=georef_tags(
            user_defined_tm_geokeys(),
            pixel_scale=[10.0, 10.0, 0.0],
            tiepoint=[0.0, 0.0, 0.0, 399960.0, 4200000.0, 0.0],
            doubles=[15.0, 500000.0, 0.9996],
        ),
    )
    write(
        "uint32_zstd.tif",
        pattern(np.uint32, HEIGHT, WIDTH, 1)[..., 0],
        photometric="minisblack",
        compression="zstd",
        tile=(16, 16),
    )
    write(
        "rgb_jpeg.tif",
        np.full((HEIGHT, WIDTH, 3), 128, dtype=np.uint8),
        photometric="rgb",
        compression="jpeg",
        tile=(32, 32),
    )
    write_rgb_jpeg_strips()


def write_rgb_jpeg_strips():
    # The last strip is encoded with only the remaining 13 rows.  Smooth vertical gradient, such
    # that the lossy compression error is small.
    y = np.arange(HEIGHT)[:, np.newaxis]
    data = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    data[..., 0] = y * 5
    data[..., 1] = 128
    data[..., 2] = 255 - y * 5
    write(
        "rgb_jpeg_strips.tif",
        data,
        photometric="rgb",
        compression="jpeg",
        rowsperstrip=16,
    )


if __name__ == "__main__":
    main()
