.. _xyz-datasource:

XYZ map tiles
=============

The XYZ data source provides access to map tiles addressed by zoom level, tile
column, and tile row, such as the basemaps provided by web map tile services
(XYZ, TMS, and WMTS RESTful URLs). Tiles may be in any image format supported
by the browser, and are loaded as 4-channel RGBA images. Map tiles are
:ref:`reprojected<geospatial>` into the display CRS of the viewer.

URL syntax
----------

- :file:`xyz://{URL-TEMPLATE}`
- :file:`xyz://{URL-TEMPLATE}#{OPTIONS}`

The :file:`{URL-TEMPLATE}` must contain ``{z}``, ``{x}``, and ``{y}``
placeholders, which are replaced by the zoom level, tile column, and tile row.
``{-y}`` may be used instead of ``{y}`` for tile rows numbered from the bottom
(TMS), and ``{s}`` is replaced by a subdomain.

:file:`{OPTIONS}` are ``&``-separated :file:`{key}={value}` pairs:

``crs``
  Tile matrix set: ``EPSG:3857`` (default) for the Google Maps compatible tile
  matrix set used by most web maps, with a single tile at zoom level 0, or
  ``EPSG:4326`` for the WorldCRS84Quad tile matrix set, with two tiles at zoom
  level 0. Other CRSs require the ``resolution`` and ``origin`` options.

``tilesize``
  Tile size in pixels (default 256).

``minzoom``, ``maxzoom``
  Range of zoom levels (default 0 and 18).

``resolution``
  Resolution at zoom level 0 in CRS units per pixel.

``origin``
  Top-left corner :file:`{x},{y}` of the tile matrix in CRS units.

``columns``, ``rows``
  Number of tile columns and rows at zoom level 0.

``subdomains``
  Values substituted for ``{s}``, as a string of single characters (e.g.
  ``abc``, the default) or a comma-separated list.

Examples
--------

- Sentinel-2 cloudless mosaic by `EOX <https://s2maps.eu>`__ in WGS 84:

  :file:`xyz://https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020/default/WGS84/{z}/{y}/{x}.jpg#crs=EPSG:4326&maxzoom=13`

- OpenStreetMap (subject to the `tile usage policy
  <https://operations.osmfoundation.org/policies/tiles/>`__):

  :file:`xyz://https://tile.openstreetmap.org/{z}/{x}/{y}.png#maxzoom=19`
