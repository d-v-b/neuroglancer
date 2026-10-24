.. _refkv-kvstore:

refkv
=====

The refkv :ref:`key-value store adapter<kvstore-adapters>` presents a file
of a format refkv supports (TIFF and its slide formats, CZI, ND2, IMS, NIfTI,
MRC, FITS, DICOM, VSI, MP3, MP4 and others) as a Zarr v3 hierarchy, without
converting or copying it. It runs refkv's virtualizer (`refkv
<https://github.com/d-v-b/refkv>`__, vendored in ``src/third_party/refkv``)
in the worker: the file's structure is read, a :ref:`vzip<vzip-kvstore>`
archive of references to its bytes is written in memory, and the keys are
read from that archive as the vzip adapter reads any other. A chunk is read
from the file itself, by its byte ranges.

URL syntax
----------

- :file:`{base-kvstore-url}|refkv:{path}/{to}/{key}`

The :file:`{base-kvstore-url}` names a file, or a store when it ends in
``/`` (an N5, Zarr v2, OME-Zarr 0.4 or Sentinel-2 SAFE store, which refkv
lists and reads itself, over ``http:`` and ``https:`` only). For example:

- ``https://example.com/recording.mp4|refkv:|zarr3:``
- ``https://example.com/slide.ndpi|refkv:|zarr3:``

A VSI file's tile files are read from beside it through the same base
key-value store.

Sources and pins
----------------

The archive has no pins: it is written from the responses just read, and
kept in memory, so a pin would check nothing. (The vzip adapter refuses a pin
it cannot check, such as a size whose ``Content-Range`` header a cross-origin
server does not expose.)

Capabilities
------------

.. list-table::

   * - :ref:`Byte range reads<kvstore-byte-range-reads>`
     - Supported
   * - :ref:`Listing<kvstore-listing>`
     - Supported

The archive is written once per base URL and kept in the chunk cache: the
first read of a file reads its structure (for most formats a few requests),
and every later read is a read of the file's own bytes.
