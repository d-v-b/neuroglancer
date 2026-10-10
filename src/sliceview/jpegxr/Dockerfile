# 4.0.15
FROM emscripten/emsdk:4.0.15

# jxrlib (Microsoft's JPEG XR reference codec, BSD 2-clause), from the
# GitHub mirror of its CodePlex repository.
ENV JXRLIB_COMMIT f7521879862b9085318e814c6157490dd9dbbdb4
ENV JXRLIB_SHA256 8ab20a21f6c3f8cfdedd2511b03a2009e52cce7fa6550202c355063d0d83213e

RUN mkdir -p /usr/src/jxrlib \
    && curl -SL -o /usr/src/jxrlib.tar.gz https://github.com/4creators/jxrlib/archive/${JXRLIB_COMMIT}.tar.gz
RUN echo "${JXRLIB_SHA256} /usr/src/jxrlib.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/jxrlib -f /usr/src/jxrlib.tar.gz --strip-components=1 \
    && rm /usr/src/jxrlib.tar.gz
