# 4.0.15
FROM emscripten/emsdk:4.0.15

# libde265 (HEVC decoder, LGPL-3.0), master after v1.1.3: v1.1.3 crops the
# conformance window of pictures of more than 8 bits by the wrong offsets,
# fixed by this commit.
ENV LIBDE265_COMMIT 4fb298ec1af0686211dc2def73f4f41c2ce19ce5
ENV LIBDE265_SHA256 51f7965f23f1a8065a11c14840989e84263563e220c61930ecbd923cbfafdfe5

RUN mkdir -p /usr/src/libde265 \
    && curl -SL -o /usr/src/libde265.tar.gz https://github.com/strukturag/libde265/archive/${LIBDE265_COMMIT}.tar.gz
RUN echo "${LIBDE265_SHA256} /usr/src/libde265.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/libde265 -f /usr/src/libde265.tar.gz --strip-components=1 \
    && rm /usr/src/libde265.tar.gz
