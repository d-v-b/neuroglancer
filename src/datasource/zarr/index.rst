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
- :file:`{KVSTORE-URL/}|zarr:#variables=uo,vo` (xarray dataset)

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
multiscale metadata, or a Zarr group written by `xarray
<https://docs.xarray.dev/en/stable/user-guide/io.html#zarr>`__ with consolidated
metadata (see :ref:`zarr-xarray`).

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
or the zarr v3 ``dimension_names``) include ``longitude``/``lon`` and
``latitude``/``lat`` dimensions with regularly-spaced 1-d coordinate arrays of
the same names in the parent group. Such arrays are displayed in WGS 84
(``EPSG:4326``) coordinates over other georeferenced data, such as map tiles.

Vertical dimensions (``depth``, ``elevation``, ``altitude``, ``height``,
``lev``, ``level``, ``z``) with 1-d coordinate arrays are displayed with a scale
corresponding to their mean level spacing, with 100x vertical exaggeration
relative to horizontal distances. Vertical sections through such volumes show
the sea level, the sky, depth ticks placed according to the actual level depths,
and the solid Earth (regions without data, such as below the seafloor) in a
crust color.

A default shader maps the CF ``valid_min``/``valid_max`` (or ``valid_range``)
attributes to a colormap and renders missing values (``_FillValue``,
``missing_value``, or the zarr fill value) as transparent.

A Zarr group with consolidated metadata (``.zmetadata`` for zarr v2, or
``consolidated_metadata`` in ``zarr.json`` for zarr v3) written by xarray may be
opened directly. Its data variables with identical dimensions, shape, chunking,
and data type are combined along an additional channel dimension ``c^``.
Specific variables may be selected using the :file:`#variables={a,b}` URL
parameter. If the selected variables are the eastward and northward components
of a vector field (indicated by CF standard names beginning with
``eastward_``/``northward_``), such as ocean currents or winds, the default
shader shows the speed, optionally colored by direction.

Examples
~~~~~~~~

- Ocean temperature from the `Copernicus Marine Service
  <https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024/description>`__
  global ocean physics analysis (1/12 degree, monthly means, 50 depth levels):

  :file:`https://s3.waw3-1.cloudferro.com/mdl-arco-geo-012/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-thetao_anfc_0.083deg_P1M-m_202406/geoChunked.zarr/thetao/|zarr2:`

- Ocean currents (``uo`` and ``vo`` combined) from the same product:

  :file:`https://s3.waw3-1.cloudferro.com/mdl-arco-geo-007/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_P1M-m_202406/geoChunked.zarr/|zarr2:`

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
- sharding_indexed
- transpose
- zstd

Auto detection
--------------

- Zarr v2 is detected automatically based on the presence of the :file:`.zarray`
  and :file:`.zattrs` files.
- Zarr v3 is detected automatically based on the presence of the
  :file:`zarr.json` file.
