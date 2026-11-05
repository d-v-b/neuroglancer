#!/usr/bin/env python3
# @license
# Copyright 2026 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Generates the phkv test stores.

Uses the reference phkv writer, `refkv.phkv.PhkvWriter`, of the refkv Python package
(https://github.com/d-v-b/refkv, `pip install refkv` once it has phkv):

    python testdata/kvstore/phkv/generate_phkv.py

The stores reference `files.blob`, which `testdata/kvstore/vzip/generate_vzip.py` writes.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from refkv.pb import Range
from refkv.phkv import PhkvWriter

HERE = Path(__file__).parent
VZIP = HERE.parent / "vzip"
FILES = HERE.parent / "files"  # the files the generic kvstore tests expect


def files_blob() -> dict[str, tuple[int, int]]:
    """The offsets of every test file in files.blob, which the vzip generator wrote."""
    shutil.copyfile(VZIP / "files.blob", HERE / "files.blob")
    layout, at = {}, 7
    for path in sorted(p for p in FILES.rglob("*") if p.is_file()):
        key = path.relative_to(FILES).as_posix()
        layout[key] = (at, path.stat().st_size)
        at += path.stat().st_size + 5
    assert at == (HERE / "files.blob").stat().st_size, "files.blob is not the one the layout says"
    return layout


def write_files(name: str, layout: dict[str, tuple[int, int]], **options) -> None:
    """The generic test files, each stored a different way."""
    with (HERE / name).open("wb") as f, PhkvWriter(f, **options) as w:
        blob = w.url("files.blob")  # relative to the store
        for key, (offset, length) in layout.items():
            data = (FILES / key).read_bytes()
            if key == "a":  # Concat: a literal byte, then a url range
                w.add_ranges(key, [Range(data=data[:1]), Range(source=blob, offset=offset + 1, length=length - 1)])
            elif key == "c":  # a bytes value, stored as it is
                w.add_bytes(key, data)
            elif key == "#":  # a bytes value, DEFLATE-compressed
                w.add_bytes(key, data, codec="deflate")
            elif key == "empty":  # an empty Concat
                w.add_ranges(key, [])
            elif key == "baz/x":  # a data source
                w.add_ranges(key, [Range(source=w.blob(data), offset=0, length=len(data))])
            else:  # a url range
                w.add_ref(key, "files.blob", offset, length)


def write_key_source(layout: dict[str, tuple[int, int]]) -> None:
    """A key source naming `__vz__/first`, an ordinary key in a phkv store (it reserves no names)."""
    data = b"the bytes of a key source"
    with (HERE / "key_source.phkv").open("wb") as f, PhkvWriter(f) as w:
        w.add_bytes("__vz__/first", data, codec="deflate")
        hidden = w.internal("__vz__/first")
        w.add_ranges("baz/first", [Range(source=hidden, offset=0, length=len(data))])
        w.add_ranges("slice", [Range(source=hidden, offset=1, length=2)])


def write_checksums(layout: dict[str, tuple[int, int]]) -> None:
    """Values stored outside their records, one of them with a byte changed after the checksum."""
    value = bytes(range(256)) * 4
    for name, flip in [("values.phkv", False), ("bad_crc.phkv", True)]:
        with (HERE / name).open("wb") as f, PhkvWriter(f, inline_max=0) as w:
            w.add_bytes("good", b"good value")
            w.add_bytes("value", value)
            w.add_bytes("packed", value, codec="deflate")
        if flip:
            data = bytearray((HERE / name).read_bytes())
            at = data.index(value)  # the stored bytes of `value`
            data[at + 100] ^= 0xFF
            (HERE / name).write_bytes(bytes(data))


def write_many() -> None:
    """3,000 keys in directories: many pages, many slots, a prefix to list."""
    with (HERE / "many.phkv").open("wb") as f, PhkvWriter(f, page_size=512) as w:
        for i in range(3000):
            w.add_bytes(f"d/{i % 30:02}/{i:05}", f"value {i}".encode())
        w.add_bytes("top", b"top")


if __name__ == "__main__":
    layout = files_blob()
    write_files("files.phkv", layout)
    write_files("files_paged.phkv", layout, page_size=64)
    write_files("files_out_of_line.phkv", layout, inline_max=0)
    write_files("files_stored_sections.phkv", layout, section_codec="none")
    write_files("files_deflate_sections.phkv", layout, section_codec="deflate")
    write_key_source(layout)
    write_checksums(layout)
    write_many()
    print("wrote", sorted(p.name for p in HERE.glob("*.phkv")))
