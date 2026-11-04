.. _zarr-datasource:

zarr
====

The Zarr :ref:`data format driver<data-formats>` provides access to `Zarr
version 2 <https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html>`__ and
`Zarr version 3
<https://zarr-specs.readthedocs.io/en/latest/v3/core/v3.0.html>`__ arrays, and
`OME-Zarr multiscale
<https://ngff.openmicroscopy.org/latest/index.html#multiscale-md>`__ v4.0 and
v5.0 arrays.

URL syntax
----------

- :file:`{KVSTORE-URL/}|zarr:` (auto-detect zarr version)
- :file:`{KVSTORE-URL/}|zarr2:` (v2 only)
- :file:`{KVSTORE-URL/}|zarr3:` (v3 only)
- :file:`{KVSTORE-URL/}|zarr:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr2:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr3:{additional/path/}`
- :file:`{KVSTORE-URL/}|zarr:#dimension_separator=/`
- :file:`{KVSTORE-URL/}|zarr2:#dimension_separator=/`

Specifying an :file:`{additional/path/}` after the zarr URL scheme is currently
equivalent to including it in the :file:`{KVSTORE-URL/}`, but may be
preferred for distinguishing the root of a zarr hierarchy from the path within
it, and may be necessary to support group-level storage transformers which may
be added to the specification in the future.

For zarr v2 only, if a dimension separator of ``/`` is used but not indicated in
the metadata, it must be specified using the :file:`#dimension_separator=/`
syntax.

The :file:`{KVSTORE-URL/}` must refer to a directory, and the combination
of :file:`{KVSTORE-URL/}` and any :file:`{additional/path/}` after the zarr
URL scheme must specify either a Zarr array or a Zarr group with OME-Zarr
multiscale metadata.

Data types
----------

Supported data types:

- uint8
- int8
- uint16
- int16
- uint32
- int32
- uint64
- float32

Coordinate spaces
-----------------

Units specified by OME-Zarr multiscale metadata are supported.

Additionally, as a Neuroglancer-specific extension, dimension units may be
specified using the ``dimension_units`` user attribute. For example, to specify
that the voxel size is 4x5x30nm for a 3-d array, the following attribute may be
set:

.. code-block:: json

   {
     "dimension_units": ["4 nm", "5 nm", "30 nm"]
   }

Zarr v2 features
----------------

Supported compressors:

- blosc
- gzip
- null (raw)
- zlib
- zstd

Filters are not supported.

Dimension names may be specified using an ``_ARRAY_DIMENSIONS`` attribute, `as
defined by xarray
<https://xarray.pydata.org/en/latest/internals/zarr-encoding-spec.html>`__.

Zarr v3 features
----------------

Supported codecs:

- crc32c (not validated)
- blosc
- bytes
- gzip
- imagecodecs_jpeg2k (decoding of 8- and 16-bit integer JPEG 2000 codestreams
  and JP2 files; a chunk's shape must end in ``[height, width]``, or
  ``[height, width, components]`` for multi-component images, with all other
  dimensions 1)
- imagecodecs_delta (differences summed back along ``axis``, as TIFF's
  horizontal predictor stores integer samples; ``dist`` must be 1, and it may
  not come before a transpose or sharding_indexed codec)
- imagecodecs_lzw (TIFF LZW streams, as the tiles and strips of LZW-compressed
  TIFF files are stored)
- imagecodecs_jpegxr (decoding of JPEG XR files of gray, RGB, BGR, RGBA and
  BGRA pixels of ``uint8``, ``uint16`` or ``float32`` samples, as jxrlib
  decodes them, color in R, G, B (A) order; the chunk shape is as for
  imagecodecs_jpeg2k)
- imagecodecs_ljpeg (lossless JPEG, ITU-T T.81 process 14 with the SOF3
  marker: predictors 1 to 7, point transforms, restart intervals, and 1 to 4
  components of 2 to 16 bits interleaved in one scan, decoded to ``uint8``
  for up to 8 bits and ``uint16`` otherwise; the chunk shape is as for
  imagecodecs_jpeg2k)
- imagecodecs_floatpred (TIFF's floating-point predictor, Predictor 3 of TIFF
  Technical Note 3, in place of bytes; ``axis`` must be the last axis or the one
  before it, an axis after it holding a pixel's samples, and ``dist`` must be 1;
  ``float32`` arrays, and ``float64`` arrays, shown as ``float32``, their values
  rounded to nearest)
- imagecodecs_packints (TIFF's packed samples: ``bitspersample`` 1 for ``uint8``
  arrays of values 0 and 1, or 12 for ``uint16`` arrays, most significant bit
  first, restarting on a byte boundary every ``runlen`` samples)
- imagecodecs_packbits (TIFF PackBits run-length coding; this is not the
  zarr-extensions ``packbits`` codec, which is bit packing)
- imagecodecs_ccittfax4 (CCITT Group 4, ITU-T T.6, bits filled most significant
  bit first, to ``uint8`` arrays, coded black runs 1 and white runs 0, with no
  photometric interpretation applied; a chunk's last two dimensions are the
  image's, the others 1, and a stream that ends before the image does is an
  error)
- imagecodecs_eer (Electron Event Representation frames, to ``uint8`` arrays of
  0 and 1; ``superres`` must be 0, and the configuration's ``shape`` must be the
  last two dimensions of a chunk, the others 1)
- imagecodecs_jpegxl (decoding of lossless JPEG XL images of one frame, of 1, 3
  or 4 components of ``uint8``, ``uint16`` or ``float32`` samples; lossy images
  are refused, because jxl-oxide's samples for them differ slightly from libjxl's;
  the chunk shape is as for imagecodecs_jpeg2k)
- imagecodecs_lerc (LERC 2 blobs of any data type LERC has, with values of masked
  pixels as stored; a chunk's shape must end in ``[height, width]``, ``[height,
  width, depth]`` for a blob of several values per pixel, or ``[bands, height,
  width]`` for a blob of several bands, as imagecodecs reads them, with all other
  dimensions 1. A float64 array is shown as ``float32``, its values rounded to
  nearest)
- imagecodecs_webp (WebP images, lossy or lossless, of ``uint8`` arrays whose
  shape ends in ``[height, width, 3]`` or ``[height, width, 4]``, with all other
  dimensions 1, unassociated alpha, and alpha 255 for an image without any;
  ``hasalpha``, if given, must agree with the shape)
- n5_default (one N5 default-mode block per chunk, header included, its
  body encoded with the inner codecs; edge blocks of another size are
  truncated or padded with zeros to the chunk's shape)
- numcodecs.shuffle (numcodecs' byte shuffle, as zarr-python 3 names it)
- numcodecs.zlib (zlib streams, as zarr-python 3 names numcodecs' Zlib)
- refkv.precomputed (a chunk or a whole shard of a Neuroglancer precomputed
  volume, as refkv writes them: raw, jpeg, png, compressed_segmentation,
  compresso, crackle and jxl chunks, clipped ones filled with the fill value, a shard's chunks read through
  its index as the precomputed data source reads them. It refuses what it
  cannot decode as refkv's Python codec does: a chunk stored in brotli, a JPEG
  with subsampled chroma or of other than 8 bits, and a PNG of several 16-bit
  channels. Other JPEGs may differ from libjpeg's by 1 level, as those of the
  precomputed data source do, and lossy JPEG XL images by 1 level too. It has no
  decoder of fpzip, zfpc and kempressed chunks, which refkv's Python codec reads)
- refkv.tiff_lzw (the same streams as imagecodecs_lzw, as refkv names them)
- sharding_indexed
- transpose
- zlib
- zstd

Supported chunk grids:

- regular
- rectilinear (the zarr-extensions chunk grid whose chunk lengths vary along
  each dimension; not combined with sharding_indexed). It is read through a
  regular grid of the largest chunk lengths, so arrays whose chunks are
  regular but for a shorter last one, as clipped pyramid levels are, read
  each chunk once.

A dimension shown as a channel dimension (such as ``c^``) may be chunked
more finely than its extent, as a planar image with one channel per chunk
is: Neuroglancer's chunks then span it whole, each assembled from the zarr
chunks it overlaps. Other arrays read one zarr chunk per Neuroglancer chunk.

Auto detection
--------------

- Zarr v2 is detected automatically based on the presence of the :file:`.zarray`
  and :file:`.zattrs` files.
- Zarr v3 is detected automatically based on the presence of the
  :file:`zarr.json` file.
