#!/bin/bash -xve

JXRLIB=${JXRLIB:-/usr/src/jxrlib}

compile_options=(
    -O2
    -I$JXRLIB -I$JXRLIB/common/include -I$JXRLIB/image/sys -I$JXRLIB/jxrgluelib
    -D__ANSI__ -DDISABLE_PERF_MEASUREMENT -DNDEBUG -w
    # segdec.c calls strcodec.c's _byteswap_ulong without declaring it.
    -Wno-error=implicit-function-declaration
    $JXRLIB/image/sys/{adapthuff,image,strcodec,strPredQuant,strTransform,perfTimerANSI}.c
    $JXRLIB/image/decode/{decode,postprocess,segdec,strdec,strInvTransform,strPredQuantDec,JXRTranscode}.c
    $JXRLIB/image/encode/{encode,segenc,strenc,strFwdTransform,strPredQuantEnc}.c
    $JXRLIB/jxrgluelib/{JXRGlue,JXRMeta,JXRGluePFC,JXRGlueJxr}.c
    jpegxr_wasm.c
    --no-entry
    -s FILESYSTEM=0
    -s ALLOW_MEMORY_GROWTH=1
    -s TOTAL_STACK=65536
    -s TOTAL_MEMORY=1mb
    -s EXPORTED_FUNCTIONS='["_jpegxr_decode","_malloc","_free"]'
    -s MALLOC=emmalloc
    -s ENVIRONMENT=worker
    -s STANDALONE_WASM=1
    -o jpegxr.wasm
)
emcc "${compile_options[@]}"
