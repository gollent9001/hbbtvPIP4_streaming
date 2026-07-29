#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <limits.h>

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <libavutil/pixfmt.h>
#include <libavutil/samplefmt.h>

typedef struct MemoryReader {
    const uint8_t *data;
    int64_t size;
    int64_t position;
} MemoryReader;

static MemoryReader g_reader;
static AVFormatContext *g_format = NULL;
static AVIOContext *g_avio = NULL;
static uint8_t *g_avio_buffer = NULL;
static AVCodecContext *g_video_codec = NULL;
static AVCodecContext *g_audio_codec = NULL;
static AVFrame *g_video_frame = NULL;
static AVFrame *g_audio_frame = NULL;
static AVPacket *g_packet = NULL;
static int g_video_stream = -1;
static int g_audio_stream = -1;
static int g_packet_pending = 0;
static int g_input_eof = 0;
static int g_video_flush_sent = 0;
static int g_audio_flush_sent = 0;
static int g_video_eof = 0;
static int g_audio_eof = 0;
static int64_t g_duration_ms = 0;
static int64_t g_start_time_ms = 0;
static int g_start_time_valid = 0;
static int64_t g_video_pts_ms = 0;
static int64_t g_audio_pts_ms = 0;
static int64_t g_next_video_pts_ms = 0;
static int64_t g_next_audio_pts_ms = 0;
static double g_video_frame_duration_ms = 40.0;
static float *g_audio_interleaved = NULL;
static size_t g_audio_capacity_samples = 0;
static int g_audio_channels = 0;
static int g_audio_sample_rate = 0;
static int g_audio_sample_count = 0;
static char g_error[AV_ERROR_MAX_STRING_SIZE] = "Nessun errore.";

static void set_error_text(const char *message) {
    snprintf(g_error, sizeof(g_error), "%s", message ? message : "Errore sconosciuto.");
}

static void set_ffmpeg_error(const char *prefix, int code) {
    char text[AV_ERROR_MAX_STRING_SIZE];
    if (av_strerror(code, text, sizeof(text)) < 0) {
        snprintf(text, sizeof(text), "codice %d", code);
    }
    snprintf(g_error, sizeof(g_error), "%s: %s", prefix ? prefix : "Errore FFmpeg", text);
}

static int memory_read(void *opaque, uint8_t *buffer, int buffer_size) {
    MemoryReader *reader = (MemoryReader *)opaque;
    if (!reader || !buffer || buffer_size <= 0) return AVERROR(EINVAL);
    if (reader->position >= reader->size) return AVERROR_EOF;
    int64_t remaining = reader->size - reader->position;
    int count = buffer_size;
    if ((int64_t)count > remaining) count = (int)remaining;
    memcpy(buffer, reader->data + reader->position, (size_t)count);
    reader->position += count;
    return count;
}

static int64_t memory_seek(void *opaque, int64_t offset, int whence) {
    MemoryReader *reader = (MemoryReader *)opaque;
    if (!reader) return AVERROR(EINVAL);
    if (whence == AVSEEK_SIZE) return reader->size;
    int base = whence & ~AVSEEK_FORCE;
    int64_t target;
    if (base == SEEK_SET) target = offset;
    else if (base == SEEK_CUR) target = reader->position + offset;
    else if (base == SEEK_END) target = reader->size + offset;
    else return AVERROR(EINVAL);
    if (target < 0 || target > reader->size) return AVERROR(EINVAL);
    reader->position = target;
    return target;
}

static int open_decoder(int stream_index, AVCodecContext **output) {
    AVStream *stream = g_format->streams[stream_index];
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
        set_error_text("Decoder non incluso nella build FFmpeg.");
        return AVERROR_DECODER_NOT_FOUND;
    }
    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    if (!ctx) return AVERROR(ENOMEM);
    int result = avcodec_parameters_to_context(ctx, stream->codecpar);
    if (result < 0) {
        set_ffmpeg_error("avcodec_parameters_to_context", result);
        avcodec_free_context(&ctx);
        return result;
    }
    ctx->thread_count = 1;
    ctx->thread_type = 0;
    result = avcodec_open2(ctx, codec, NULL);
    if (result < 0) {
        set_ffmpeg_error("avcodec_open2", result);
        avcodec_free_context(&ctx);
        return result;
    }
    *output = ctx;
    return 0;
}

static int64_t frame_pts_ms(const AVFrame *frame, const AVStream *stream, int64_t fallback) {
    int64_t ts = frame->best_effort_timestamp;
    if (ts == AV_NOPTS_VALUE) ts = frame->pts;
    if (ts == AV_NOPTS_VALUE) return fallback;
    return av_rescale_q(ts, stream->time_base, (AVRational){1, 1000});
}

static float read_sample(enum AVSampleFormat packed, const uint8_t *data, int index) {
    switch (packed) {
        case AV_SAMPLE_FMT_U8: return (((const uint8_t *)data)[index] - 128.0f) / 128.0f;
        case AV_SAMPLE_FMT_S16: return ((const int16_t *)data)[index] / 32768.0f;
        case AV_SAMPLE_FMT_S32: return (float)(((const int32_t *)data)[index] / 2147483648.0);
        case AV_SAMPLE_FMT_S64: return (float)(((const int64_t *)data)[index] / 9223372036854775808.0);
        case AV_SAMPLE_FMT_FLT: return ((const float *)data)[index];
        case AV_SAMPLE_FMT_DBL: return (float)((const double *)data)[index];
        default: return 0.0f;
    }
}

static int prepare_audio(void) {
    int channels = g_audio_frame->ch_layout.nb_channels;
    if (channels <= 0) channels = g_audio_codec->ch_layout.nb_channels;
    if (channels <= 0 || g_audio_frame->nb_samples <= 0 || g_audio_frame->sample_rate <= 0) {
        set_error_text("Parametri audio non validi.");
        return -1;
    }
    enum AVSampleFormat fmt = (enum AVSampleFormat)g_audio_frame->format;
    enum AVSampleFormat packed = av_get_packed_sample_fmt(fmt);
    if (packed == AV_SAMPLE_FMT_NONE) {
        set_error_text("Formato PCM non supportato.");
        return -2;
    }
    int planar = av_sample_fmt_is_planar(fmt);
    size_t total = (size_t)channels * (size_t)g_audio_frame->nb_samples;
    if (total > g_audio_capacity_samples) {
        float *next = (float *)av_realloc_array(g_audio_interleaved, total, sizeof(float));
        if (!next) {
            set_error_text("Memoria PCM insufficiente.");
            return -3;
        }
        g_audio_interleaved = next;
        g_audio_capacity_samples = total;
    }
    for (int s = 0; s < g_audio_frame->nb_samples; ++s) {
        for (int c = 0; c < channels; ++c) {
            const uint8_t *src = planar ? g_audio_frame->extended_data[c] : g_audio_frame->extended_data[0];
            int index = planar ? s : s * channels + c;
            float value = read_sample(packed, src, index);
            if (!isfinite(value)) value = 0.0f;
            if (value > 1.0f) value = 1.0f;
            if (value < -1.0f) value = -1.0f;
            g_audio_interleaved[(size_t)s * (size_t)channels + (size_t)c] = value;
        }
    }
    g_audio_channels = channels;
    g_audio_sample_rate = g_audio_frame->sample_rate;
    g_audio_sample_count = g_audio_frame->nb_samples;
    AVStream *stream = g_format->streams[g_audio_stream];
    g_audio_pts_ms = frame_pts_ms(g_audio_frame, stream, g_next_audio_pts_ms);
    g_next_audio_pts_ms = g_audio_pts_ms + av_rescale(g_audio_sample_count, 1000, g_audio_sample_rate);
    return 0;
}

static int prepare_video(void) {
    if (g_video_frame->format != AV_PIX_FMT_YUV420P && g_video_frame->format != AV_PIX_FMT_YUVJ420P) {
        snprintf(g_error, sizeof(g_error), "Formato video %d non supportato: usare YUV420P 8 bit.", g_video_frame->format);
        return -1;
    }
    if (!g_video_frame->data[0] || !g_video_frame->data[1] || !g_video_frame->data[2]) {
        set_error_text("Piani YUV incompleti.");
        return -2;
    }
    AVStream *stream = g_format->streams[g_video_stream];
    g_video_pts_ms = frame_pts_ms(g_video_frame, stream, g_next_video_pts_ms);
    g_next_video_pts_ms = g_video_pts_ms + (int64_t)llround(g_video_frame_duration_ms);
    return 0;
}

EMSCRIPTEN_KEEPALIVE void player_close(void) {
    if (g_packet) av_packet_free(&g_packet);
    if (g_video_frame) av_frame_free(&g_video_frame);
    if (g_audio_frame) av_frame_free(&g_audio_frame);
    if (g_video_codec) avcodec_free_context(&g_video_codec);
    if (g_audio_codec) avcodec_free_context(&g_audio_codec);
    if (g_format) avformat_close_input(&g_format);
    if (g_avio) {
        avio_context_free(&g_avio);
        g_avio_buffer = NULL;
    } else if (g_avio_buffer) {
        av_free(g_avio_buffer);
        g_avio_buffer = NULL;
    }
    av_freep(&g_audio_interleaved);
    g_audio_capacity_samples = 0;
    memset(&g_reader, 0, sizeof(g_reader));
    g_video_stream = g_audio_stream = -1;
    g_packet_pending = g_input_eof = 0;
    g_video_flush_sent = g_audio_flush_sent = 0;
    g_video_eof = g_audio_eof = 0;
    g_duration_ms = 0;
    g_start_time_ms = 0;
    g_start_time_valid = 0;
    g_video_pts_ms = g_audio_pts_ms = 0;
    g_next_video_pts_ms = g_next_audio_pts_ms = 0;
    g_video_frame_duration_ms = 40.0;
    g_audio_channels = g_audio_sample_rate = g_audio_sample_count = 0;
}

/*
 * input_kind:
 *   0 = MOV/MP4
 *   1 = MPEG-TS, usato per i segmenti HLS .ts
 */
EMSCRIPTEN_KEEPALIVE int player_open(uint8_t *input, int input_size, int input_kind) {
    player_close();
    av_log_set_level(AV_LOG_WARNING);

    if (!input || input_size <= 0) {
        set_error_text("Segmento multimediale vuoto.");
        return -1;
    }

    g_reader.data = input;
    g_reader.size = input_size;
    g_reader.position = 0;

    const int avio_size = 32768;
    g_avio_buffer = (uint8_t *)av_malloc(avio_size);
    if (!g_avio_buffer) return -2;

    g_avio = avio_alloc_context(
        g_avio_buffer,
        avio_size,
        0,
        &g_reader,
        memory_read,
        NULL,
        memory_seek
    );
    if (!g_avio) {
        set_error_text("Impossibile creare AVIOContext.");
        player_close();
        return -3;
    }

    g_format = avformat_alloc_context();
    if (!g_format) {
        player_close();
        return -4;
    }

    g_format->pb = g_avio;
    g_format->flags |= AVFMT_FLAG_CUSTOM_IO;

    const char *format_name = input_kind == 1 ? "mpegts" : "mov";
    const char *synthetic_name = input_kind == 1 ? "file:segment.ts" : "file:memory.mp4";
    const AVInputFormat *input_format = av_find_input_format(format_name);

    if (!input_format) {
        set_error_text(input_kind == 1
            ? "Demuxer MPEG-TS non incluso nella build FFmpeg."
            : "Demuxer MOV/MP4 non incluso nella build FFmpeg.");
        player_close();
        return -5;
    }

    int result = avformat_open_input(
        &g_format,
        synthetic_name,
        input_format,
        NULL
    );
    if (result < 0) {
        set_ffmpeg_error("avformat_open_input", result);
        player_close();
        return -6;
    }

    result = avformat_find_stream_info(g_format, NULL);
    if (result < 0) {
        set_ffmpeg_error("avformat_find_stream_info", result);
        player_close();
        return -7;
    }

    g_video_stream = av_find_best_stream(
        g_format,
        AVMEDIA_TYPE_VIDEO,
        -1,
        -1,
        NULL,
        0
    );
    if (g_video_stream < 0) {
        set_error_text("Traccia video assente nel segmento.");
        player_close();
        return -8;
    }

    g_audio_stream = av_find_best_stream(
        g_format,
        AVMEDIA_TYPE_AUDIO,
        -1,
        -1,
        NULL,
        0
    );

    if (open_decoder(g_video_stream, &g_video_codec) < 0) {
        player_close();
        return -9;
    }
    if (g_audio_stream >= 0 && open_decoder(g_audio_stream, &g_audio_codec) < 0) {
        player_close();
        return -10;
    }

    g_video_frame = av_frame_alloc();
    g_audio_frame = av_frame_alloc();
    g_packet = av_packet_alloc();
    if (!g_video_frame || !g_audio_frame || !g_packet) {
        set_error_text("Allocazione frame/packet fallita.");
        player_close();
        return -11;
    }

    if (g_format->duration != AV_NOPTS_VALUE) {
        g_duration_ms = av_rescale(g_format->duration, 1000, AV_TIME_BASE);
    }

    int64_t earliest = INT64_MAX;
    int selected_streams[2] = {g_video_stream, g_audio_stream};
    for (int i = 0; i < 2; ++i) {
        int stream_index = selected_streams[i];
        if (stream_index < 0) continue;
        AVStream *stream = g_format->streams[stream_index];
        if (stream->start_time != AV_NOPTS_VALUE) {
            int64_t value = av_rescale_q(
                stream->start_time,
                stream->time_base,
                (AVRational){1, 1000}
            );
            if (value < earliest) earliest = value;
        }
    }
    if (earliest != INT64_MAX) {
        g_start_time_ms = earliest;
        g_start_time_valid = 1;
        g_next_video_pts_ms = earliest;
        g_next_audio_pts_ms = earliest;
    } else if (g_format->start_time != AV_NOPTS_VALUE) {
        g_start_time_ms = av_rescale(g_format->start_time, 1000, AV_TIME_BASE);
        g_start_time_valid = 1;
        g_next_video_pts_ms = g_start_time_ms;
        g_next_audio_pts_ms = g_start_time_ms;
    }

    AVStream *video_stream = g_format->streams[g_video_stream];
    AVRational rate = video_stream->avg_frame_rate;
    if (rate.num <= 0 || rate.den <= 0) rate = video_stream->r_frame_rate;
    if (rate.num > 0 && rate.den > 0) {
        g_video_frame_duration_ms = 1000.0 * rate.den / rate.num;
    }

    set_error_text("Nessun errore.");
    return 0;
}

static int receive_video(void) {
    if (!g_video_codec || g_video_eof) return AVERROR(EAGAIN);
    av_frame_unref(g_video_frame);
    int result = avcodec_receive_frame(g_video_codec, g_video_frame);
    if (result == 0) return prepare_video() == 0 ? 1 : -100;
    if (result == AVERROR_EOF) {
        g_video_eof = 1;
        return result;
    }
    if (result == AVERROR(EAGAIN)) return result;
    set_ffmpeg_error("avcodec_receive_frame video", result);
    return -101;
}

static int receive_audio(void) {
    if (!g_audio_codec || g_audio_eof) return AVERROR(EAGAIN);
    av_frame_unref(g_audio_frame);
    int result = avcodec_receive_frame(g_audio_codec, g_audio_frame);
    if (result == 0) return prepare_audio() == 0 ? 2 : -110;
    if (result == AVERROR_EOF) {
        g_audio_eof = 1;
        return result;
    }
    if (result == AVERROR(EAGAIN)) return result;
    set_ffmpeg_error("avcodec_receive_frame audio", result);
    return -111;
}

static int send_pending(void) {
    if (!g_packet_pending) return 0;
    AVCodecContext *target = NULL;
    if (g_packet->stream_index == g_video_stream) target = g_video_codec;
    else if (g_packet->stream_index == g_audio_stream) target = g_audio_codec;
    if (!target) {
        av_packet_unref(g_packet);
        g_packet_pending = 0;
        return 0;
    }
    int result = avcodec_send_packet(target, g_packet);
    if (result == 0) {
        av_packet_unref(g_packet);
        g_packet_pending = 0;
        return 0;
    }
    if (result == AVERROR(EAGAIN)) return result;
    set_ffmpeg_error("avcodec_send_packet", result);
    return -120;
}

static int flush_decoders(void) {
    if (g_video_codec && !g_video_flush_sent && !g_video_eof) {
        int r = avcodec_send_packet(g_video_codec, NULL);
        if (r == 0 || r == AVERROR_EOF) {
            g_video_flush_sent = 1;
            if (r == AVERROR_EOF) g_video_eof = 1;
            return 1;
        }
        if (r != AVERROR(EAGAIN)) {
            set_ffmpeg_error("flush video", r);
            return -130;
        }
    }
    if (g_audio_codec && !g_audio_flush_sent && !g_audio_eof) {
        int r = avcodec_send_packet(g_audio_codec, NULL);
        if (r == 0 || r == AVERROR_EOF) {
            g_audio_flush_sent = 1;
            if (r == AVERROR_EOF) g_audio_eof = 1;
            return 1;
        }
        if (r != AVERROR(EAGAIN)) {
            set_ffmpeg_error("flush audio", r);
            return -131;
        }
    }
    return 0;
}

/* 1 = frame video, 2 = blocco audio PCM, 0 = fine segmento. */
EMSCRIPTEN_KEEPALIVE int player_next_event(void) {
    if (!g_format || !g_video_codec || !g_packet) {
        set_error_text("Player non inizializzato.");
        return -200;
    }
    for (int safety = 0; safety < 100000; ++safety) {
        int vr = receive_video();
        if (vr == 1) return 1;
        if (vr < 0 && vr != AVERROR(EAGAIN) && vr != AVERROR_EOF) return vr;

        int ar = receive_audio();
        if (ar == 2) return 2;
        if (ar < 0 && ar != AVERROR(EAGAIN) && ar != AVERROR_EOF) return ar;

        if (g_packet_pending) {
            int sr = send_pending();
            if (sr == AVERROR(EAGAIN)) continue;
            if (sr < 0) return sr;
            continue;
        }

        if (!g_input_eof) {
            int rr = av_read_frame(g_format, g_packet);
            if (rr == 0) {
                if (g_packet->stream_index == g_video_stream || g_packet->stream_index == g_audio_stream) {
                    g_packet_pending = 1;
                } else {
                    av_packet_unref(g_packet);
                }
                continue;
            }
            if (rr == AVERROR_EOF) {
                g_input_eof = 1;
                continue;
            }
            set_ffmpeg_error("av_read_frame", rr);
            return -201;
        }

        int fr = flush_decoders();
        if (fr < 0) return fr;
        if (fr > 0) continue;
        if (g_video_eof && (!g_audio_codec || g_audio_eof)) return 0;
    }
    set_error_text("Limite di sicurezza superato.");
    return -202;
}

EMSCRIPTEN_KEEPALIVE int player_duration_ms(void) { return (int)g_duration_ms; }
EMSCRIPTEN_KEEPALIVE int player_start_time_ms(void) { return (int)g_start_time_ms; }
EMSCRIPTEN_KEEPALIVE int player_start_time_valid(void) { return g_start_time_valid; }
EMSCRIPTEN_KEEPALIVE int player_has_audio(void) { return g_audio_codec ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_width(void) { return g_video_frame ? g_video_frame->width : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_height(void) { return g_video_frame ? g_video_frame->height : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_pts_ms(void) { return (int)g_video_pts_ms; }
EMSCRIPTEN_KEEPALIVE uint8_t *player_video_y(void) { return g_video_frame ? g_video_frame->data[0] : NULL; }
EMSCRIPTEN_KEEPALIVE uint8_t *player_video_u(void) { return g_video_frame ? g_video_frame->data[1] : NULL; }
EMSCRIPTEN_KEEPALIVE uint8_t *player_video_v(void) { return g_video_frame ? g_video_frame->data[2] : NULL; }
EMSCRIPTEN_KEEPALIVE int player_video_stride_y(void) { return g_video_frame ? g_video_frame->linesize[0] : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_stride_u(void) { return g_video_frame ? g_video_frame->linesize[1] : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_stride_v(void) { return g_video_frame ? g_video_frame->linesize[2] : 0; }
EMSCRIPTEN_KEEPALIVE int player_video_matrix(void) { return g_video_frame && g_video_frame->colorspace == AVCOL_SPC_BT709 ? 709 : 601; }
EMSCRIPTEN_KEEPALIVE int player_video_full_range(void) {
    return g_video_frame && (
        g_video_frame->format == AV_PIX_FMT_YUVJ420P ||
        g_video_frame->color_range == AVCOL_RANGE_JPEG
    );
}
EMSCRIPTEN_KEEPALIVE float *player_audio_data(void) { return g_audio_interleaved; }
EMSCRIPTEN_KEEPALIVE int player_audio_channels(void) { return g_audio_channels; }
EMSCRIPTEN_KEEPALIVE int player_audio_sample_rate(void) { return g_audio_sample_rate; }
EMSCRIPTEN_KEEPALIVE int player_audio_sample_count(void) { return g_audio_sample_count; }
EMSCRIPTEN_KEEPALIVE int player_audio_pts_ms(void) { return (int)g_audio_pts_ms; }
EMSCRIPTEN_KEEPALIVE const char *player_error(void) { return g_error; }
