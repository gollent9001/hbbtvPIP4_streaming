#!/usr/bin/env bash
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-n8.1.2}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${ROOT_DIR}/external/ffmpeg"
DIST_DIR="${ROOT_DIR}/external/ffmpeg-dist"
STAMP_FILE="${DIST_DIR}/.built-hls-ts-${FFMPEG_VERSION}"

if [[ -f "${STAMP_FILE}" ]]; then
    echo "FFmpeg ${FFMPEG_VERSION} HLS/TS già compilato."
    exit 0
fi

command -v emcc >/dev/null 2>&1 || { echo "Errore: emcc non trovato."; exit 1; }
mkdir -p "${ROOT_DIR}/external"

if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
    rm -rf "${SOURCE_DIR}"
    git clone --depth 1 --branch "${FFMPEG_VERSION}" \
        https://github.com/FFmpeg/FFmpeg.git "${SOURCE_DIR}"
else
    git -C "${SOURCE_DIR}" fetch --depth 1 origin "${FFMPEG_VERSION}"
    git -C "${SOURCE_DIR}" checkout --force "${FFMPEG_VERSION}"
fi

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
pushd "${SOURCE_DIR}" >/dev/null
make distclean >/dev/null 2>&1 || true

echo "Configurazione FFmpeg minimale MPEG-TS + H.264 + AAC per HLS/WASM..."
emconfigure ./configure \
    --prefix="${DIST_DIR}" \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --nm=emnm \
    --dep-cc=emcc \
    --enable-cross-compile \
    --target-os=none \
    --arch=x86_32 \
    --cpu=generic \
    --disable-asm \
    --disable-inline-asm \
    --disable-x86asm \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-logging \
    --disable-autodetect \
    --disable-network \
    --disable-avdevice \
    --disable-avfilter \
    --disable-swscale \
    --disable-swresample \
    --disable-pthreads \
    --disable-w32threads \
    --disable-os2threads \
    --disable-iconv \
    --disable-zlib \
    --disable-bzlib \
    --disable-lzma \
    --disable-sdl2 \
    --disable-everything \
    --enable-avformat \
    --enable-avcodec \
    --enable-avutil \
    --enable-demuxer=mpegts \
    --enable-demuxer=mov \
    --enable-decoder=h264 \
    --enable-decoder=aac \
    --enable-decoder=aac_latm \
    --enable-parser=h264 \
    --enable-parser=aac \
    --enable-protocol=file \
    --enable-small \
    --extra-cflags="-O3 -flto" \
    --extra-ldflags="-O3 -flto"

echo "Compilazione FFmpeg..."
emmake make -j"$(nproc)"
emmake make install
popd >/dev/null

touch "${STAMP_FILE}"
echo "FFmpeg pronto in ${DIST_DIR}."
