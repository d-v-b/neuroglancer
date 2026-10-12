.. _geotiff-datasource:

GeoTIFF
=======

The GeoTIFF :ref:`data format driver<data-formats>` supports TIFF and BigTIFF
images, and in particular `Cloud-Optimized GeoTIFF <https://cogeo.org/>`__
(COG) images. Only the image file directories and the tiles that are displayed
are read, using :ref:`byte range reads<kvstore-byte-range-reads>`.

Georeferenced images are :ref:`reprojected<geospatial>` into the display CRS of
the viewer.

URL syntax
----------

- :file:`{KVSTORE-URL}|geotiff:`
- :file:`{KVSTORE-URL}|geotiff:#crs={CRS}`

The optional :file:`crs` parameter specifies the CRS of the image, as an EPSG
code (e.g. :file:`EPSG:31468`) or a proj4 definition, overriding the CRS
determined from the GeoTIFF keys. This is necessary for images in CRSs that are
not built in.

Examples
--------

- Sentinel-2 L2A true color image (tile 33SVB, eastern Sicily) from the
  `Sentinel-2 Cloud-Optimized GeoTIFFs
  <https://registry.opendata.aws/sentinel-2-l2a-cogs/>`__ open dataset:

  :file:`https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/33/S/VB/2024/7/S2B_33SVB_20240725_0_L2A/TCI.tif|geotiff:`

Images
------

The first full-resolution image is displayed, with reduced-resolution images
(overviews, ``NewSubfileType`` bit 0) used as additional scales. Transparency
masks are ignored. The samples of each pixel are represented as a channel
dimension ``c^``. Image file directories after the first that cannot be parsed
(e.g. thumbnails or masks with unsupported properties) are skipped with a
warning; errors in the first image are reported.

Supported features:

- Tiled and stripped images. Tiles are loaded as individual chunks. Strips
  are grouped into chunks of about 256 rows; images wider than 1024 pixels and
  strips taller than 1024 rows are divided into chunks of 512 pixels, with the
  decoded strips cached briefly such that each strip is downloaded and decoded
  only once. Nearby tiles and strips needed at the same time are read with a
  single byte range request. Note that an image stored as a single strip must
  still be downloaded and decoded entirely.
- Chunky (interleaved) and planar sample configurations.
- Unsigned and signed integer samples of 8, 16, and 32 bits (and unsigned 64
  bits), and floating point samples of 32 and 64 bits (converted to 32 bits).
- Compression: none, LZW, DEFLATE, PackBits, JPEG (including ``JPEGTables``),
  Zstandard, and WebP.
- Predictors: horizontal differencing and floating point.

Byte range requests to servers that do not support them (and return the entire
file) still work, but are inefficient.

For 8-bit RGB(A) images, a default shader displays the image in color; if the
``GDAL_NODATA`` value is ``0``, black pixels are transparent.

Georeferencing
--------------

The transform from pixel coordinates to CRS coordinates is determined from the
``ModelTransformation`` tag, or from the ``ModelTiepoint`` and
``ModelPixelScale`` tags. ``PixelIsPoint`` raster types are shifted by half a
pixel, as by GDAL.

The CRS is determined from the GeoTIFF keys:

- ``ProjectedCSTypeGeoKey`` or ``GeographicTypeGeoKey`` EPSG codes, for codes
  that are built in (WGS 84 and ETRS89/NAD83/GDA2020 UTM zones, Web Mercator,
  polar stereographic, and a number of common national and regional CRSs).
- User-defined projected CRSs using the transverse Mercator, Mercator (1SP and
  2SP), Lambert conformal conic, Lambert azimuthal equal area, Albers equal
  area, polar stereographic, oblique stereographic, equirectangular, and
  cylindrical equal area projections, with linear units of metres, feet, US
  survey feet, kilometres, or a user-defined unit size
  (``ProjLinearUnitSizeGeoKey``). Other linear units are rejected; specify the
  CRS explicitly in that case.

Auto detection
--------------

TIFF and BigTIFF files are detected automatically based on the signature at the
start of the file.
