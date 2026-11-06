.. _phkv-kvstore:

phkv
====

The phkv :ref:`key-value store adapter<kvstore-adapters>` provides access to
a *phkv* store: a single file in which a perfect hash of the keys finds any
key's record in one hop, and in which every value is either ordinary bytes or
a **reference** to byte ranges of other objects (external URLs, other keys of
the same store, or literal bytes). It holds the same "virtual" datasets as a
:ref:`vzip<vzip-kvstore>` archive, and resolves references in the same way. A
phkv store reads a key with a few ranged requests however many keys it holds,
where a vzip archive reads a page of its central directory. This adapter
implements the standalone profile of format version 0 of the phkv
specification, which is a draft.

URL syntax
----------

- :file:`{base-kvstore-url}|phkv:{path}/{to}/{key}`
- :file:`phkv://{base-kvstore-url}` (and :file:`phkv://{base-kvstore-url}/{key}`
  when the URL of the store ends in ``.phkv``)

The :file:`{base-kvstore-url}` must refer to a file, and typically ends with
``.phkv``. For example:

- ``https://example.com/dataset.phkv|phkv:|zarr3:``
- ``phkv://https://example.com/dataset.phkv|zarr3:``

Relative ``url`` sources in the store are resolved against the store's own
URL, so a store can be published next to the files it references. Neuroglancer
detects a phkv store by its superblock, at the end of the file.

Capabilities
------------

.. list-table::

   * - :ref:`Byte range reads<kvstore-byte-range-reads>`
     - Supported
   * - :ref:`Listing<kvstore-listing>`
     - Supported

How it reads
------------

Opening a store reads the end of the file, which holds its superblock, the
section directory, the source table, the perfect hash and the page index (up
to 64 KiB at once, more with a further request for each section that lies
before it). Looking up a key reads its 12-byte slot and then its record,
which holds a small value (a Zarr metadata document, usually) inline;
a larger value, or a reference's ranges, are read from where the record says.
Listing a prefix reads the pages of the page index that may hold such a key.

Sections and values may be stored, compressed with DEFLATE, or compressed
with Zstandard. A value that has a CRC-32C is checked whenever the whole of it
is read, and a failed check is a body error. A phkv store reserves no names:
every key of it is visible, including those that start with ``__vz__/``.

Not supported: the hybrid profile (a phkv store inside a ZIP file), a store
followed by other data in its file, and properties (the PROPERTY sections are
skipped).

Sources, pins, checksums and merged reads
-----------------------------------------

These are as for :ref:`vzip<vzip-kvstore>`: the same source table, the same
pins and ``crc32c`` of a range, the same ``Range`` requests, and the same
merging of reads that wait at the same time.
