.. _layer:

Layer
=====

.. _layer-data-source:

Layer data source
-----------------

TODO

Layer kinds
-----------

.. _image-layer:

Image layer
^^^^^^^^^^^

Image layers display generic volumetric data in a user-configurable way.

.. _image-layer-stack-sources:

Combining sources as channels
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Normally, each data source of an image layer is drawn separately, and the shader
only accesses the channels of one source at a time. With the ``stackSources``
layer property enabled, the volume sources of the layer are combined, in order,
as the channels of a single volume, such that the shader can combine them, e.g.
to compute a vegetation index from the spectral bands of a satellite image
stored as separate arrays or files, or the speed of ocean currents from their
eastward and northward components:

.. code-block:: json

   {
     "type": "image",
     "source": [".../b04/", ".../b08/"],
     "stackSources": true,
     "shader": "void main() { float red = getDataValue(0); float nir = getDataValue(1); ... }"
   }

The sources must have the same data type. If none of the sources has a channel
dimension, a channel dimension ``c^`` is appended, with one channel per source;
if each has a channel dimension (which must be its last dimension, with the
same name in all sources, e.g. ``c^`` for GeoTIFF images), their channels are
concatenated. The combined volume has the geometry of the first source, and
the resolution levels at which all sources have the same voxel grid, which
allows combining sources of different resolutions (e.g. 10 m and 20 m
Sentinel-2 bands, combined at 20 m and coarser).

.. _image-layer-shader:

Image layer shader
~~~~~~~~~~~~~~~~~~

TODO

.. _segmentation-layer:

Segmentation layer
^^^^^^^^^^^^^^^^^^

Segmentation layers display *segmentations* where each object/class, each
identified by a integer label, is (typically) shown with a distinct color.

Several kinds of data sources are supported:

- multi-resolution volumes, which maps spatial locations to the corresponding
  object label;
- object surface meshes, which map each object label to a corresponding to mesh;
- object skeleton representations, which map each object label to a
  corresponding skeleton representation.
