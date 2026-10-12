.. _geojson-datasource:

GeoJSON
=======

The GeoJSON data source displays the point and line features of a `GeoJSON
<https://datatracker.ietf.org/doc/html/rfc7946>`__ file as an annotation layer,
:ref:`reprojected<geospatial>` into the display CRS of the viewer. Points are
displayed as point annotations; line strings and the rings of polygons are
displayed as polylines.

Longitudes outside ``[-180, 180]`` (e.g. in ``[0, 360)``) are wrapped into
``[-180, 180)``. Line segments between consecutive positions take the shorter
way around the globe: a segment whose longitudes differ by more than 180
degrees crosses the antimeridian, and the line is split there into separate
polylines.

Positions with a third (vertical) coordinate are placed at the corresponding
elevation along the ``z`` dimension, such that vertical sections show features
at depth, e.g. earthquake hypocenters. The ``z`` dimension is shared by all
GeoJSON data sources; features without a vertical coordinate are placed at sea
level. Cross sections parallel to the map plane show features at all depths.

Numeric feature properties (up to 16) are available as annotation properties,
accessible in the annotation shader as :file:`prop_{name}()`, where
:file:`{name}` is the property name with each run of characters other than
letters and digits replaced by a single underscore, and leading and trailing
underscores removed. Names that do not start with a letter are prefixed with
``p_``, and names without letters or digits become ``p``. If several properties
map to the same name, numeric suffixes are appended (``a_b``, ``a_b_2``,
``a_b_3``, ...). If positions have a vertical coordinate, the depth in
kilometers is also available as ``prop_depth_km()``.

The default annotation shader colors features by depth (if available) and sizes
points by the ``mag`` property (if present), as in the `USGS earthquake catalog
<https://earthquake.usgs.gov/fdsnws/event/1/>`__. It is used if the layer's
shader has not been modified, and is replaced if the layer's data source is
changed, unless the shader has been edited.

Annotation ids are derived from the index of the feature in the file, followed
by the index of the part (``.0``, ``.1``, ...) for features with several parts
(e.g. ``MultiPoint`` geometries, polygons with holes, or lines split at the
antimeridian), such that they do not depend on the display CRS. A line divided
where it leaves the valid domain of the display CRS has an additional suffix
for each piece after the first.

URL syntax
----------

- :file:`{BASE-URL}|geojson:`
- :file:`{BASE-URL}|geojson:#{OPTIONS}`

The :file:`{BASE-URL}` specifies the location of the GeoJSON file in any
supported :ref:`key-value store<kvstores>`. Files containing a GeoJSON
``FeatureCollection`` or ``Feature`` are detected automatically if the
``"type"`` member appears within the first 512 bytes of the file (as is
typical); otherwise, the ``|geojson:`` suffix must be specified explicitly.

:file:`{OPTIONS}` are ``&``-separated :file:`{key}={value}` pairs:

``vertical``
  Interpretation of the third coordinate of positions: ``elevation_m``
  (default, elevation in meters as specified by RFC 7946), ``depth_km`` (depth
  in kilometers, the default for the USGS earthquake catalog), or ``none``.

``swath``
  Size in degrees of a horizontal voxel (default 1). When a horizontal
  dimension is not displayed, features within one voxel of the current position
  along it are shown. Otherwise, the cross-section depth determines the
  features shown in vertical sections.

``exaggeration``
  Vertical exaggeration (default 1).

Example
-------

The following viewer state displays earthquakes of magnitude 5.5 or greater
since 1990 and tectonic plate boundaries over a basemap, with a vertical section
through the Tonga subduction zone:

.. code-block:: json

   {
     "crs": "EPSG:4326",
     "layout": "4panel",
     "crossSectionDepth": 60,
     "layers": [
       {
         "type": "image",
         "name": "basemap",
         "source": "xyz://https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020/default/WGS84/{z}/{y}/{x}.jpg#crs=EPSG:4326&maxzoom=13"
       },
       {
         "type": "annotation",
         "name": "plate boundaries",
         "source": "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json|geojson:"
       },
       {
         "type": "annotation",
         "name": "earthquakes",
         "source": "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=1990-01-01&minmagnitude=5.5|geojson:"
       }
     ]
   }

Limitations
-----------

- The entire file is loaded into memory; large files (more than a few hundred
  thousand features) may be slow to load.
- Polygons are displayed as outlines.
- Non-numeric properties other than a feature title (``title``, ``name``,
  ``place``, or ``label``, displayed as the annotation description) are
  ignored.
