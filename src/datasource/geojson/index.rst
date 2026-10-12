.. _geojson-datasource:

GeoJSON
=======

The GeoJSON data source displays the point and line features of a `GeoJSON
<https://datatracker.ietf.org/doc/html/rfc7946>`__ file as an annotation layer,
:ref:`reprojected<geospatial>` into the display CRS of the viewer. Points are
displayed as point annotations; line strings and the rings of polygons are
displayed as polylines.

Positions with a third (vertical) coordinate are placed at the corresponding
elevation along the ``z`` dimension, such that vertical sections show features
at depth, e.g. earthquake hypocenters. The ``z`` dimension is shared by all
GeoJSON data sources; features without a vertical coordinate are placed at sea
level. Cross sections parallel to the map plane show features at all depths.

Numeric feature properties (up to 16) are available as annotation properties,
accessible in the annotation shader as :file:`prop_{name}()`, where
:file:`{name}` is the property name with characters other than letters, digits,
and underscores replaced by underscores. If positions have a vertical
coordinate, the depth in kilometers is also available as ``prop_depth_km()``.

The default annotation shader colors features by depth (if available) and sizes
points by the ``mag`` property (if present), as in the `USGS earthquake catalog
<https://earthquake.usgs.gov/fdsnws/event/1/>`__.

URL syntax
----------

- :file:`{BASE-URL}|geojson:`
- :file:`{BASE-URL}|geojson:#{OPTIONS}`

The :file:`{BASE-URL}` specifies the location of the GeoJSON file in any
supported :ref:`key-value store<kvstores>`. Files containing a GeoJSON
``FeatureCollection`` or ``Feature`` are detected automatically.

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
