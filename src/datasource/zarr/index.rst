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
- :file:`{KVSTORE-URL/}|zarr:#variable=uo` (xarray dataset or GeoZarr multiscale group)
- :file:`{KVSTORE-URL/}|zarr:#georeference=false` (disable georeferencing)

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
URL scheme must specify either a Zarr array, a Zarr group with OME-Zarr
multiscale metadata, a Zarr group written by `xarray
<https://docs.xarray.dev/en/stable/user-guide/io.html#zarr>`__ with consolidated
metadata (see :ref:`zarr-xarray`), or a GeoZarr multiscale group whose levels
are such groups (see :ref:`zarr-geozarr`).

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

.. _zarr-xarray:

xarray datasets and georeferencing
----------------------------------

Arrays written by xarray following the `CF conventions
<https://cfconventions.org/>`__ are :ref:`georeferenced<geospatial>`
automatically if their dimensions (given by the ``_ARRAY_DIMENSIONS`` attribute
or the zarr v3 ``dimension_names``) include longitude (``longitude``, ``lon``,
``long``, ``nav_lon``) and latitude (``latitude``, ``lat``, ``nav_lat``)
dimensions with regularly-spaced 1-d coordinate arrays of the same names in the
parent group. Such arrays are displayed in WGS 84 (``EPSG:4326``) coordinates
over other georeferenced data, such as map tiles.

The coordinate arrays must hold degrees: if they have a CF ``units`` attribute,
it must be ``degrees_east`` (or a variant such as ``degree_E``) for longitude,
``degrees_north`` (or a variant) for latitude, or ``degrees``; if they have a
``standard_name`` attribute, it must be ``longitude`` or ``latitude``; and their
values must be within [-180, 360] for longitude and [-90, 90] for latitude.
Coordinates packed with CF ``scale_factor``/``add_offset`` attributes are
unpacked. A dimension with a single coordinate is georeferenced if the
coordinate has a CF ``bounds`` array giving the cell size.

Georeferencing may be disabled using the :file:`#georeference=false` URL
parameter, in which case the array is displayed in index coordinates.

Vertical dimensions (``depth``, ``elevation``, ``altitude``, ``height``,
``lev``, ``level``, ``plev``, ``z``) with 1-d coordinate arrays are displayed
with a scale corresponding to their mean level spacing, with 100x vertical
exaggeration relative to horizontal distances. The vertical coordinate is
interpreted according to its CF attributes:

- Lengths (``units`` of ``m``, ``km``, ``cm``, or ``mm``) are converted to
  meters. Coordinates with ``positive: down``, or named ``depth*`` without a
  ``positive`` attribute and with mostly non-negative values, are depths below
  sea level. ``depth``, ``elevation``, ``altitude``, and ``height`` coordinates
  without ``units`` are assumed to be in meters.
- Pressures (``units`` of ``Pa``, ``hPa``, ``kPa``, ``mbar``, ``millibar``, or
  ``bar``), such as ERA5 pressure levels, are converted to *approximate*
  altitudes using the barometric formula of the International Standard
  Atmosphere.
- Dimensionless coordinates (such as sigma or hybrid levels, with ``units`` of
  ``1``, a ``formula_terms`` attribute, or a ``standard_name`` of
  ``atmosphere_*_coordinate`` or ``ocean_*_coordinate``), coordinates with other
  or missing ``units``, and coordinates with an ``axis`` other than ``Z`` are
  displayed as ordinary (non-vertical) dimensions.

Vertical sections through such volumes show the sea level, the sky, depth ticks
placed according to the actual level depths, and the solid Earth (regions
without data, such as below the seafloor) in a crust color.

A default shader maps the CF ``valid_min``/``valid_max`` (or ``valid_range``)
attributes to a colormap and renders missing values (``_FillValue``,
``missing_value``, or the zarr fill value) as transparent. For variables packed
with CF ``scale_factor``/``add_offset`` attributes (typically integer
variables), the shader also computes the unpacked ``value``; as in the CF
conventions, the valid range and fill value are in packed units.

A Zarr group with consolidated metadata (``.zmetadata`` for zarr v2, or
``consolidated_metadata`` in ``zarr.json`` for zarr v3) written by xarray may be
opened directly, showing one of its data variables. By default, the primary
data variable is chosen by preferring variables with longitude and latitude
dimensions, then higher rank, then more elements; coordinates, auxiliary
coordinates, and CF bounds arrays (referenced by a ``bounds`` attribute, or with
a trailing dimension such as ``bnds`` or ``nv``) are not data variables. Another
variable may be selected using the :file:`#variable={name}` URL parameter, or
by specifying the URL of the variable's array.

To combine multiple variables in a shader (e.g. the eastward and northward
components of ocean currents, to show the speed), specify each as a data source
of an image layer with :ref:`stackSources<image-layer-stack-sources>` enabled.

Examples
~~~~~~~~

- Ocean temperature from the `Copernicus Marine Service
  <https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024/description>`__
  global ocean physics analysis (1/12 degree, monthly means, 50 depth levels):

  :file:`https://s3.waw3-1.cloudferro.com/mdl-arco-geo-012/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-thetao_anfc_0.083deg_P1M-m_202406/geoChunked.zarr/thetao/|zarr2:`

- Eastward ocean currents from the same product:

  :file:`https://s3.waw3-1.cloudferro.com/mdl-arco-geo-007/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_P1M-m_202406/geoChunked.zarr/uo/|zarr2:`

.. _zarr-geozarr:

GeoZarr multiscale groups
-------------------------

Groups following the `multiscales <https://github.com/zarr-conventions/multiscales>`__
zarr convention, whose resolution levels (the ``asset`` entries of the
``multiscales.layout`` attribute) are groups of data variables as above, are
displayed as multiscale volumes of one data variable, selected as above (e.g.
:file:`#variable=b04`), over the levels that contain it. This is the layout of,
for example, the Sentinel-2 products of the ESA `EOPF Sentinel Zarr
<https://zarr.eopf.copernicus.eu/>`__ service, whose ``measurements/reflectance``
group has levels ``r10m``, ``r20m``, ``r60m``, ... holding one array per
spectral band; since a band at all resolutions is not a single array, it is
addressed by the multiscale group and the variable name. Multiple bands are
combined using :ref:`stackSources<image-layer-stack-sources>`.

Data variables (also of a single dataset) are georeferenced from the
attributes of the `spatial <https://github.com/zarr-conventions/spatial>`__ and
`proj <https://github.com/zarr-experimental/geo-proj>`__ conventions, of the
arrays or their enclosing groups and layout entries: the CRS (``proj:code`` or
``proj:wkt2``), the affine transform from pixel to CRS coordinates
(``spatial:transform``, which must not be rotated), the spatial dimensions
(``spatial:dimensions``, default ``["y", "x"]``), and the registration
(``spatial:registration``). Projected data are :ref:`reprojected<geospatial>`
into the display CRS.

Consolidated metadata stored in an ancestor group (e.g. only at the root of a
product) is used for the groups within it.

Example
~~~~~~~

- Sentinel-2 L2A red band (Po delta, 12 May 2025):

  :file:`https://s3.explorer.eopf.copernicus.eu/esa-zarr-sentinel-explorer-fra/tests-output/sentinel-2-l2a/S2C_MSIL2A_20250512T100611_N0511_R022_T32TQQ_20250512T173114.zarr/measurements/reflectance/|zarr3:#variable=b04`

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
- cast_value (to and from integer and float32 data types, with ``scalar_map``)
- gzip
- scale_offset (float32 arrays)
- sharding_indexed
- transpose
- zstd

Auto detection
--------------

- Zarr v2 is detected automatically based on the presence of the :file:`.zarray`
  and :file:`.zattrs` files.
- Zarr v3 is detected automatically based on the presence of the
  :file:`zarr.json` file.
