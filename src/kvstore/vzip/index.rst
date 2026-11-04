.. _vzip-kvstore:

vzip
====

The vzip :ref:`key-value store adapter<kvstore-adapters>` provides access to
a *vzip* archive: a ZIP file in which every entry is either ordinary bytes or
a **reference** to byte ranges of other objects (external URLs, other
entries of the same archive, or literal bytes). It is used for "virtual"
Zarr datasets whose chunks live inside other files (HDF5, netCDF, TIFF).
This adapter implements format version 0 of the vzip specification.

URL syntax
----------

- :file:`{base-kvstore-url}|vzip:{path}/{to}/{entry}`

The :file:`{base-kvstore-url}` must refer to a file, and typically ends with
``.vzip``. For example:

- ``https://example.com/dataset.vzip|vzip:|zarr3:``

Relative ``url`` sources in the archive are resolved against the archive's
own URL, so an archive can be published next to the files it references.

Capabilities
------------

.. list-table::

   * - :ref:`Byte range reads<kvstore-byte-range-reads>`
     - Supported
   * - :ref:`Listing<kvstore-listing>`
     - Supported

Checksums
---------

A source range may carry a `crc32c
<https://github.com/d-v-b/refkv/blob/main/spec/refkv.md#42-range>`__, which
detects a changed source even where a cross-origin response hides the headers
that pins need. Such a range is `read whole
<https://github.com/d-v-b/refkv/blob/main/spec/refkv.md#63-resolving-a-reference>`__,
however little of it a read asks for, and checked before any of its bytes are
returned. A failed check fails the reads that need that range and no others.

Sources and pins
----------------

``url`` sources with the ``http:`` or ``https:`` scheme are read with
``Range`` requests. Pins (``size``, ``etag``, ``modified_not_after``) are
checked against each response: ``size`` by ``Content-Range``, ``etag`` by
``ETag`` and ``If-Match``, ``modified_not_after`` by ``Last-Modified`` and
``If-Unmodified-Since``. A cross-origin response shows those headers only
if the server lists them in ``Access-Control-Expose-Headers``, which most
servers that allow range requests do not. A pin whose header the response
hides is skipped (the exception of `refkv's reader policy, rule 7
<https://github.com/d-v-b/refkv/blob/main/spec/refkv.md#67-reader-policy>`__);
a pin whose header the response shows is checked, and fails as an error.
A script cannot tell a hidden header from one the server exposes but does
not send, so a cross-origin response without the header skips the pin
either way (a same-origin one fails it). A ``200`` response, from a server
that ignores ``Range``, gives the size by its body, so a ``size`` pin is
checked.
A pinned ``etag`` or ``modified_not_after`` also needs the server to allow
``If-Match`` or ``If-Unmodified-Since`` in ``Access-Control-Allow-Headers``,
or the browser refuses the request. If ``Content-Range`` is not exposed, a
``206`` response is accepted when its body has exactly the requested
length. Other schemes (``gs:``, ``s3:``, ...) are read
through Neuroglancer's own key-value stores, without pins.
