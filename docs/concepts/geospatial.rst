.. _geospatial:

Geospatial data
===============

Neuroglancer can display georeferenced data, such as satellite imagery, map
tiles, and gridded Earth system model output, in a common map projection.

Display coordinate reference system
-----------------------------------

Georeferenced data sources declare the coordinate reference system (CRS) of
their data, e.g. a UTM zone for a Sentinel-2 image. All georeferenced data
sources are reprojected on the fly into a single *display CRS*, specified by the
:json:schema:`ViewerState.crs` property of the viewer state as an EPSG code
(e.g. ``"EPSG:4326"`` for longitude/latitude, ``"EPSG:3857"`` for Web Mercator,
``"EPSG:3413"`` for polar stereographic) or a proj4 definition. If it is not
specified, the CRS of the first georeferenced data source that is loaded is
used.

The two horizontal dimensions of every georeferenced data source are named
``x`` (easting or longitude) and ``y`` (northing or latitude), and hold display
CRS coordinates in units of ``deg`` (for geographic CRSs) or ``m``. Other
dimensions, such as time, depth, or spectral bands, are unaffected.

The display CRS can be changed using the CRS field in the top bar. Changing the
display CRS preserves the geographic location and ground resolution of the
view.

Supported CRSs
~~~~~~~~~~~~~~

Coordinate transformations are computed using `proj4js
<https://github.com/proj4js/proj4js>`__. Built-in EPSG codes include WGS 84
(``EPSG:4326``), Web Mercator (``EPSG:3857``), the WGS 84, ETRS89, NAD83, and
GDA2020 UTM zones, polar stereographic and Lambert azimuthal equal area polar
projections, Equal Earth, and a number of common regional CRSs. Other CRSs may be
specified by proj4 definition, either as the display CRS or as the CRS of a data
source that supports overriding it (e.g. :ref:`GeoTIFF<geotiff-datasource>`).

Reprojection
------------

Neuroglancer's coordinate transforms are affine; reprojection between CRSs is
not. A reprojected data source is presented to the rest of Neuroglancer through
an affine approximation (the linearization of the reprojection at the center of
the source), and the exact reprojection is applied when determining the visible
chunks and when rendering:

- Visible chunks are determined by projecting the boundaries of blocks of chunks
  into the viewport, using a hierarchical search.

- Each chunk is rendered as a triangle mesh computed in double precision on the
  CPU, adaptively refined until the error of linear interpolation within each
  triangle is below 0.2 voxels. The refinement follows the approach of
  `@developmentseed/raster-reproject
  <https://developmentseed.org/deck.gl-raster/api/raster-reproject>`__ by Kyle
  Barron. The boundary of each chunk mesh is subdivided independently of the
  rest of the chunk, such that adjacent chunks join without cracks.

- For cylindrical display CRSs (e.g. ``EPSG:4326`` and ``EPSG:3857``), data is
  repeated at multiples of 360 degrees of longitude ("world copies"), and the
  view position wraps around in longitude.

Reprojected data is rendered only in cross sections parallel to the map plane.
Data sources already in the display CRS are also rendered in other cross
sections, such as vertical sections through 3-d volumes; 2-d data sources, such
as map tiles, are hidden in such cross sections.

Supported data sources
----------------------

- :ref:`XYZ map tiles<xyz-datasource>`, e.g. web map basemaps.
- :ref:`GeoTIFF<geotiff-datasource>`, including Cloud-Optimized GeoTIFF.
- :ref:`Zarr<zarr-xarray>` arrays and datasets written by xarray with
  regularly-spaced latitude/longitude coordinates.
- :ref:`GeoJSON<geojson-datasource>` points and lines, e.g. earthquake
  hypocenters and tectonic plate boundaries, displayed as annotations.

User interface
--------------

When a display CRS is set, the viewer adapts to the geometry of the Earth:

- Cross sections are oriented north-up, and may only be rotated within the map
  plane.
- The top bar shows the latitude and longitude under the mouse pointer (or at
  the center of the view), and the display CRS.
- Scale bars show great-circle ground distance at the center of the view. If the
  scale differs between the horizontal and vertical screen axes (as for
  non-conformal projections such as ``EPSG:4326``), separate scale bars are
  shown for each axis.
- A latitude/longitude graticule with labeled lines is drawn over map views
  (toggled by :json:schema:`ViewerState.showGraticule`), along with a north
  arrow.
- Vertical sections through georeferenced data with a vertical coordinate
  (e.g. ocean model output or earthquake hypocenters) show the sea level, the
  sky, depth ticks, and the solid Earth in a crust color.
- Cross sections parallel to the map plane show annotations at all depths
  along the vertical dimensions, rather than only those near the cross section.

Example
-------

The following viewer state displays a Sentinel-2 image over a WGS 84 basemap:

.. code-block:: json

   {
     "crs": "EPSG:4326",
     "layout": "xy",
     "layers": [
       {
         "type": "image",
         "name": "basemap",
         "source": "xyz://https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020/default/WGS84/{z}/{y}/{x}.jpg#crs=EPSG:4326&maxzoom=13"
       },
       {
         "type": "image",
         "name": "sentinel-2",
         "opacity": 1,
         "source": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/33/S/VB/2024/7/S2B_33SVB_20240725_0_L2A/TCI.tif|geotiff:"
       }
     ]
   }

Limitations
-----------

- Datum transformations requiring grid files are not supported.
- Annotations other than :ref:`GeoJSON<geojson-datasource>` features, meshes,
  and skeletons are not reprojected.
- Reprojected data cannot be volume rendered.
- Positions are represented in single precision, which limits the precision of
  navigation to about a meter for global datasets.
