FFMPEG_VERSION ?= n8.1.2

ROOT_DIR := $(CURDIR)
BUILD_DIR := $(ROOT_DIR)/build
WEB_DIR := $(ROOT_DIR)/web
FFMPEG_DIST := $(ROOT_DIR)/external/ffmpeg-dist

PLAYER_JS := $(BUILD_DIR)/hls-player.js
DEMO_PLAYLIST := $(WEB_DIR)/media/hls/demo.m3u8

EXPORTED_FUNCTIONS := '["_malloc","_free","_player_open","_player_close","_player_next_event","_player_duration_ms","_player_start_time_ms","_player_start_time_valid","_player_has_audio","_player_video_width","_player_video_height","_player_video_pts_ms","_player_video_y","_player_video_u","_player_video_v","_player_video_stride_y","_player_video_stride_u","_player_video_stride_v","_player_video_matrix","_player_video_full_range","_player_audio_data","_player_audio_channels","_player_audio_sample_rate","_player_audio_sample_count","_player_audio_pts_ms","_player_error"]'

.PHONY: all ffmpeg web-assets demo serve clean distclean rebuild

all: $(PLAYER_JS) web-assets

ffmpeg:
	FFMPEG_VERSION=$(FFMPEG_VERSION) bash ./scripts/build_ffmpeg.sh

$(PLAYER_JS): src/player.c scripts/build_ffmpeg.sh
	$(MAKE) ffmpeg
	mkdir -p $(BUILD_DIR)
	emcc src/player.c \
		-I$(FFMPEG_DIST)/include \
		-Wl,--start-group \
		$(FFMPEG_DIST)/lib/libavformat.a \
		$(FFMPEG_DIST)/lib/libavcodec.a \
		$(FFMPEG_DIST)/lib/libavutil.a \
		-Wl,--end-group \
		-O3 \
		-flto \
		--no-entry \
		-s WASM=1 \
		-s MODULARIZE=1 \
		-s EXPORT_NAME=createHlsPlayer \
		-s ENVIRONMENT=web \
		-s FILESYSTEM=0 \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s INITIAL_MEMORY=67108864 \
		-s MAXIMUM_MEMORY=536870912 \
		-s MALLOC=emmalloc \
		-s EXPORTED_FUNCTIONS=$(EXPORTED_FUNCTIONS) \
		-s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32","UTF8ToString"]' \
		-o $(PLAYER_JS)

web-assets:
	mkdir -p $(BUILD_DIR)
	cp -R $(WEB_DIR)/. $(BUILD_DIR)/
	touch $(BUILD_DIR)/.nojekyll

demo: $(DEMO_PLAYLIST)

$(DEMO_PLAYLIST):
	mkdir -p $(WEB_DIR)/media/hls
	rm -f $(WEB_DIR)/media/hls/*.ts $(WEB_DIR)/media/hls/*.m3u8
	ffmpeg \
		-hide_banner \
		-loglevel error \
		-f lavfi \
		-i "testsrc2=size=640x360:rate=25" \
		-f lavfi \
		-i "sine=frequency=440:sample_rate=48000" \
		-t 18 \
		-shortest \
		-c:v libx264 \
		-profile:v baseline \
		-level:v 3.0 \
		-pix_fmt yuv420p \
		-preset veryfast \
		-x264-params "keyint=50:min-keyint=50:scenecut=0" \
		-c:a aac \
		-b:a 96k \
		-ar 48000 \
		-ac 2 \
		-f hls \
		-hls_time 2 \
		-hls_list_size 0 \
		-hls_flags independent_segments \
		-hls_segment_filename "$(WEB_DIR)/media/hls/seg%03d.ts" \
		-y \
		$(DEMO_PLAYLIST)
	@echo "Creato HLS demo: $(DEMO_PLAYLIST)"

serve: demo all
	cd $(BUILD_DIR) && python3 -m http.server 8080

clean:
	rm -rf $(BUILD_DIR)

distclean: clean
	rm -rf external
	rm -f $(WEB_DIR)/media/hls/*.ts $(WEB_DIR)/media/hls/*.m3u8

rebuild: distclean serve
