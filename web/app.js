"use strict";
(function () {
    var config = window.PIP_CONFIG || {};
    var playlistUrl = config.useLocalDemo ? config.localDemoUrl : config.hlsUrl;
    var liveBackSegments = Math.max(1, Number(config.liveBackSegments) || 3);
    var prebufferMs = Math.max(1000, Number(config.prebufferMs) || 4500);
    var bufferAheadMs = Math.max(prebufferMs, Number(config.bufferAheadMs) || 9000);
    var maxDownloadedSegments = Math.max(1, Number(config.maxDownloadedSegments) || 3);
    var maxQueuedSegments = Math.max(maxDownloadedSegments, Number(config.maxQueuedSegments) || 12);
    var audioBatchMs = Math.max(250, Number(config.audioBatchMs) || 1800);
    var audioStartLeadMs = Math.max(80, Number(config.audioStartLeadMs) || 350);
    var benchmarkFrames = Math.max(10, Number(config.benchmarkVideoFrames) || 100);

    var applicationManager = document.getElementById("applicationManager");
    var broadcastVideo = document.getElementById("broadcastVideo");
    var browserBackground = document.getElementById("browserBackground");
    var launcher = document.getElementById("launcher");
    var pipPanel = document.getElementById("pipPanel");
    var canvas = document.getElementById("pipCanvas");
    var badge = document.getElementById("badge");
    var screenMessage = document.getElementById("screenMessage");
    var statusLabel = document.getElementById("status");
    var timeLabel = document.getElementById("timeLabel");
    var durationLabel = document.getElementById("durationLabel");
    var progressBar = document.getElementById("progressBar");
    var decodeMetric = document.getElementById("decodeMetric");
    var averageMetric = document.getElementById("averageMetric");
    var resolutionMetric = document.getElementById("resolutionMetric");
    var audioMetric = document.getElementById("audioMetric");
    var playButton = document.getElementById("playButton");
    var restartButton = document.getElementById("restartButton");
    var benchmarkButton = document.getElementById("benchmarkButton");
    var muteButton = document.getElementById("muteButton");
    var sizeButton = document.getElementById("sizeButton");
    var closeButton = document.getElementById("closeButton");

    var module = null;
    var renderer = null;
    var generation = 0;
    var panelOpen = false;
    var compact = config.compactByDefault === true;
    var ready = false;
    var playing = false;
    var benchmarking = false;
    var streamLive = true;
    var streamEnded = false;
    var hasAudio = false;

    var mediaPlaylistUrl = playlistUrl;
    var targetDurationMs = 4000;
    var totalTimelineMs = 0;
    var lastKnownSequence = null;
    var knownSequences = {};
    var pendingSegments = [];
    var downloadedSegments = [];
    var keyCache = {};
    var networkBusy = false;
    var playlistBusy = false;
    var currentSegment = null;
    var currentPointer = 0;
    var currentInputSize = 0;
    var decodeTimer = 0;
    var networkTimer = 0;
    var playlistTimer = 0;

    var videoQueue = [];
    var audioQueue = [];
    var firstPts = 0;
    var lastVideoPts = -Infinity;
    var lastAudioEnd = -Infinity;
    var lastRenderedPts = 0;
    var totalVideoDecodeMs = 0;
    var decodedVideoFrames = 0;

    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    var audioContext = null;
    var gainNode = null;
    var audioTimelineStarted = false;
    var audioTimelineContextStart = 0;
    var audioTimelineMediaStart = 0;
    var nextAudioStartTime = 0;
    var audioUnderruns = 0;
    var scheduledSources = [];
    var volume = Math.max(0, Math.min(1, Number(config.volume) || 0.65));
    var muted = config.muted === true;

    var performanceAnchor = 0;
    var mediaAnchor = 0;
    var animationHandle = 0;
    var pumpTimer = 0;
    var waitingForData = false;

    var KEY = {
        RED: typeof VK_RED !== "undefined" ? VK_RED : 403,
        GREEN: typeof VK_GREEN !== "undefined" ? VK_GREEN : 404,
        YELLOW: typeof VK_YELLOW !== "undefined" ? VK_YELLOW : 405,
        BLUE: typeof VK_BLUE !== "undefined" ? VK_BLUE : 406,
        ENTER: typeof VK_ENTER !== "undefined" ? VK_ENTER : 13,
        PLAY: typeof VK_PLAY !== "undefined" ? VK_PLAY : 415,
        PAUSE: typeof VK_PAUSE !== "undefined" ? VK_PAUSE : 19,
        UP: typeof VK_UP !== "undefined" ? VK_UP : 38,
        DOWN: typeof VK_DOWN !== "undefined" ? VK_DOWN : 40,
        BACK: typeof VK_BACK !== "undefined" ? VK_BACK : 461,
        ESCAPE: 27,
        SPACE: 32
    };

    function pad(value, length) {
        var text = String(value);
        while (text.length < length) text = "0" + text;
        return text;
    }

    function formatTime(ms) {
        var safe = Math.max(0, Number(ms) || 0);
        var totalSeconds = Math.floor(safe / 1000);
        return pad(Math.floor(totalSeconds / 60), 2) + ":" +
            pad(totalSeconds % 60, 2) + "." +
            pad(Math.floor(safe % 1000), 3);
    }

    function setStatus(message) { statusLabel.textContent = message; }
    function setBadge(message, type) { badge.textContent = message; badge.className = "badge" + (type ? " " + type : ""); }
    function showMessage(message) { screenMessage.textContent = message; screenMessage.classList.remove("hidden"); }
    function hideMessage() { screenMessage.classList.add("hidden"); }

    function initialiseHbbTV() {
        var hbbtv = false;
        try {
            if (applicationManager && typeof applicationManager.getOwnerApplication === "function") {
                var owner = applicationManager.getOwnerApplication(document);
                if (owner) {
                    hbbtv = true;
                    owner.show();
                    var keyset = owner.privateData && owner.privateData.keyset;
                    if (keyset) {
                        var requested = 0;
                        requested |= keyset.RED || 0;
                        requested |= keyset.GREEN || 0;
                        requested |= keyset.YELLOW || 0;
                        requested |= keyset.BLUE || 0;
                        requested |= keyset.NAVIGATION || 0;
                        requested |= keyset.VCR || 0;
                        keyset.setValue(requested);
                    }
                }
            }
        } catch (error) { console.log("HbbTV Application Manager:", error); }
        if (hbbtv) {
            browserBackground.classList.add("hidden");
            try {
                if (broadcastVideo && typeof broadcastVideo.bindToCurrentChannel === "function") {
                    broadcastVideo.bindToCurrentChannel();
                }
            } catch (error) { console.log("Broadcast:", error); }
        }
    }

    function xhr(url, responseType, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var request = new XMLHttpRequest();
            request.open("GET", url, true);
            request.responseType = responseType || "text";
            request.timeout = timeoutMs || 15000;
            request.onload = function () {
                if (request.status >= 200 && request.status < 300) {
                    resolve(request.responseType === "text" ? request.responseText : request.response);
                } else {
                    reject(new Error("HTTP " + request.status + " caricando " + url));
                }
            };
            request.onerror = function () {
                reject(new Error(
                    "Richiesta HLS fallita. Verificare URL, scadenza token e CORS del CDN: " + url
                ));
            };
            request.ontimeout = function () {
                reject(new Error("Timeout caricando " + url));
            };
            request.send();
        });
    }

    function parseAttributes(text) {
        var result = {};
        var regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/g;
        var match;
        while ((match = regex.exec(text))) {
            var value = match[2];
            if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
                value = value.slice(1, -1);
            }
            result[match[1]] = value;
        }
        return result;
    }

    function resolveUrl(relative, base) {
        try { return new URL(relative, base).href; }
        catch (error) {
            var slash = base.lastIndexOf("/");
            return slash >= 0 ? base.slice(0, slash + 1) + relative : relative;
        }
    }

    function parsePlaylist(text, url) {
        var lines = String(text).replace(/\r/g, "").split("\n");
        if (lines[0].trim() !== "#EXTM3U") throw new Error("La risposta non è una playlist M3U8 valida.");

        var variants = [];
        var pendingVariant = null;
        var segments = [];
        var mediaSequence = 0;
        var sequenceSet = false;
        var targetDuration = 4;
        var pendingDuration = null;
        var pendingByteRange = null;
        var discontinuity = false;
        var endList = false;
        var activeKey = null;
        var keyMethods = {};
        var independent = false;
        var mapUrl = null;

        lines.forEach(function (rawLine) {
            var line = rawLine.trim();
            if (!line) return;

            if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
                pendingVariant = parseAttributes(line.slice(18));
                return;
            }
            if (line.indexOf("#EXT-X-MEDIA-SEQUENCE:") === 0) {
                mediaSequence = parseInt(line.slice(22), 10) || 0;
                sequenceSet = true;
                return;
            }
            if (line.indexOf("#EXT-X-TARGETDURATION:") === 0) {
                targetDuration = parseFloat(line.slice(22)) || targetDuration;
                return;
            }
            if (line.indexOf("#EXTINF:") === 0) {
                pendingDuration = parseFloat(line.slice(8).split(",")[0]);
                return;
            }
            if (line.indexOf("#EXT-X-BYTERANGE:") === 0) {
                pendingByteRange = line.slice(17);
                return;
            }
            if (line.indexOf("#EXT-X-DISCONTINUITY") === 0) {
                discontinuity = true;
                return;
            }
            if (line.indexOf("#EXT-X-INDEPENDENT-SEGMENTS") === 0) {
                independent = true;
                return;
            }
            if (line.indexOf("#EXT-X-ENDLIST") === 0) {
                endList = true;
                return;
            }
            if (line.indexOf("#EXT-X-KEY:") === 0) {
                var key = parseAttributes(line.slice(11));
                var method = String(key.METHOD || "").toUpperCase();

                if (!method) {
                    throw new Error("EXT-X-KEY senza attributo METHOD.");
                }

                if (method === "NONE") {
                    activeKey = null;
                    return;
                }

                activeKey = {
                    method: method,
                    uri: key.URI ? resolveUrl(key.URI, url) : "",
                    iv: key.IV || "",
                    keyFormat: key.KEYFORMAT || "identity"
                };
                keyMethods[method] = true;
                return;
            }
            if (line.indexOf("#EXT-X-MAP:") === 0) {
                var map = parseAttributes(line.slice(11));
                if (map.URI) mapUrl = resolveUrl(map.URI, url);
                return;
            }
            if (line.charAt(0) === "#") return;

            if (pendingVariant) {
                variants.push({
                    url: resolveUrl(line, url),
                    bandwidth: parseInt(pendingVariant.BANDWIDTH, 10) || 0,
                    resolution: pendingVariant.RESOLUTION || ""
                });
                pendingVariant = null;
                return;
            }

            if (pendingDuration === null) return;
            segments.push({
                sequence: mediaSequence + segments.length,
                durationMs: Math.max(1, Math.round(pendingDuration * 1000)),
                url: resolveUrl(line, url),
                byteRange: pendingByteRange,
                discontinuity: discontinuity,
                key: activeKey ? {
                    method: activeKey.method,
                    uri: activeKey.uri,
                    iv: activeKey.iv,
                    keyFormat: activeKey.keyFormat
                } : null
            });
            pendingDuration = null;
            pendingByteRange = null;
            discontinuity = false;
        });

        if (variants.length) return {type:"master", variants:variants};
        return {
            type: "media",
            url: url,
            mediaSequence: sequenceSet ? mediaSequence : 0,
            targetDurationMs: Math.max(1000, Math.round(targetDuration * 1000)),
            segments: segments,
            endList: endList,
            keyMethods: Object.keys(keyMethods),
            independent: independent,
            mapUrl: mapUrl
        };
    }

    function chooseVariant(variants) {
        var sorted = variants.slice().sort(function (a, b) { return a.bandwidth - b.bandwidth; });
        return sorted[0];
    }

    function wasmError() {
        var pointer = module ? module._player_error() : 0;
        return pointer ? module.UTF8ToString(pointer) : "Errore sconosciuto.";
    }

    function closeCurrentSegment() {
        if (module) module._player_close();
        if (module && currentPointer) module._free(currentPointer);
        currentPointer = 0;
        currentInputSize = 0;
        currentSegment = null;
    }

    function clearTimers() {
        if (decodeTimer) clearTimeout(decodeTimer);
        if (networkTimer) clearTimeout(networkTimer);
        if (playlistTimer) clearTimeout(playlistTimer);
        if (pumpTimer) clearTimeout(pumpTimer);
        if (animationHandle) cancelAnimationFrame(animationHandle);
        decodeTimer = networkTimer = playlistTimer = pumpTimer = animationHandle = 0;
    }

    function stopAudioSources() {
        scheduledSources.slice().forEach(function (source) {
            try { source.stop(); } catch (error) {}
        });
        scheduledSources = [];
        audioTimelineStarted = false;
        audioTimelineContextStart = 0;
        audioTimelineMediaStart = 0;
        nextAudioStartTime = 0;
    }

    function resetPipeline() {
        generation += 1;
        clearTimers();
        closeCurrentSegment();
        stopAudioSources();
        if (audioContext && audioContext.state === "running") audioContext.suspend();

        ready = false;
        playing = false;
        streamEnded = false;
        hasAudio = false;
        mediaPlaylistUrl = playlistUrl;
        targetDurationMs = 4000;
        totalTimelineMs = 0;
        lastKnownSequence = null;
        knownSequences = {};
        pendingSegments = [];
        downloadedSegments = [];
        keyCache = {};
        networkBusy = false;
        playlistBusy = false;
        currentSegment = null;

        videoQueue = [];
        audioQueue = [];
        lastVideoPts = -Infinity;
        lastAudioEnd = -Infinity;
        lastRenderedPts = 0;
        totalVideoDecodeMs = 0;
        decodedVideoFrames = 0;
        audioUnderruns = 0;
        performanceAnchor = 0;
        mediaAnchor = 0;
        waitingForData = false;

        renderer.clear();
        timeLabel.textContent = "00:00.000";
        durationLabel.textContent = "LIVE";
        progressBar.style.width = "0%";
        playButton.textContent = "Play";
        setControlsEnabled(false);
    }

    function setControlsEnabled(enabled) {
        playButton.disabled = !enabled;
        restartButton.disabled = !enabled;
        benchmarkButton.disabled = !enabled;
        muteButton.disabled = !enabled || !hasAudio;
    }

    function fatalHlsError(message, cause) {
        var error = new Error(message);
        error.hlsFatal = true;
        if (cause) error.cause = cause;
        return error;
    }

    function validateSegmentKey(segment) {
        if (!segment.key) return;

        var method = String(segment.key.method || "").toUpperCase();
        var keyFormat = String(segment.key.keyFormat || "identity");

        if (method !== "AES-128") {
            throw fatalHlsError(
                "Cifratura HLS " + method + " non supportata. " +
                "Questa versione gestisce EXT-X-KEY METHOD=AES-128, non SAMPLE-AES o DRM."
            );
        }

        if (keyFormat !== "identity") {
            throw fatalHlsError(
                "KEYFORMAT HLS non supportato: " + keyFormat + ". " +
                "È supportato soltanto KEYFORMAT=identity."
            );
        }

        if (!segment.key.uri) {
            throw fatalHlsError("EXT-X-KEY AES-128 senza URI della chiave.");
        }
    }

    function parseExplicitIv(value) {
        var hex = String(value || "").replace(/^0x/i, "");

        if (!/^[0-9a-fA-F]{1,32}$/.test(hex)) {
            throw fatalHlsError("IV AES-128 non valido nella playlist HLS: " + value);
        }

        if (hex.length % 2) hex = "0" + hex;
        while (hex.length < 32) hex = "00" + hex;

        var iv = new Uint8Array(16);
        for (var index = 0; index < 16; index += 1) {
            iv[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        }
        return iv;
    }

    function sequenceIv(sequence) {
        var iv = new Uint8Array(16);
        var value = Math.max(0, Math.floor(Number(sequence) || 0));

        /*
         * RFC 8216: rappresentazione big-endian del Media Sequence Number,
         * allineata a destra in 16 byte.
         */
        for (var index = 15; index >= 0 && value > 0; index -= 1) {
            iv[index] = value % 256;
            value = Math.floor(value / 256);
        }
        return iv;
    }

    function segmentIv(segment) {
        return segment.key && segment.key.iv
            ? parseExplicitIv(segment.key.iv)
            : sequenceIv(segment.sequence);
    }

    function getImportedAesKey(keyInfo) {
        var subtle = window.crypto && window.crypto.subtle;
        if (!subtle) {
            return Promise.reject(fatalHlsError(
                "Web Crypto API non disponibile: impossibile decifrare EXT-X-KEY AES-128."
            ));
        }

        var cacheId = keyInfo.uri;
        if (keyCache[cacheId]) return keyCache[cacheId];

        keyCache[cacheId] = xhr(keyInfo.uri, "arraybuffer", 15000)
            .then(function (buffer) {
                if (!buffer || buffer.byteLength !== 16) {
                    throw fatalHlsError(
                        "La chiave HLS AES-128 deve contenere esattamente 16 byte; ricevuti " +
                        (buffer ? buffer.byteLength : 0) + "."
                    );
                }

                return subtle.importKey(
                    "raw",
                    buffer,
                    {name: "AES-CBC"},
                    false,
                    ["decrypt"]
                );
            })
            .catch(function (error) {
                delete keyCache[cacheId];
                if (error && error.hlsFatal) throw error;
                throw fatalHlsError(
                    "Impossibile scaricare/importare la chiave AES-128. " +
                    "Il file della chiave deve essere raggiungibile e autorizzare CORS: " +
                    keyInfo.uri + ". Dettaglio: " + (error.message || error),
                    error
                );
            });

        return keyCache[cacheId];
    }

    function decryptSegment(buffer, segment) {
        if (!segment.key) return Promise.resolve(buffer);

        validateSegmentKey(segment);

        if (!buffer || buffer.byteLength === 0 || buffer.byteLength % 16 !== 0) {
            return Promise.reject(fatalHlsError(
                "Segmento AES-128 non valido: la dimensione cifrata deve essere un multiplo di 16 byte."
            ));
        }

        var subtle = window.crypto && window.crypto.subtle;
        var iv = segmentIv(segment);

        return getImportedAesKey(segment.key)
            .then(function (cryptoKey) {
                return subtle.decrypt(
                    {name: "AES-CBC", iv: iv},
                    cryptoKey,
                    buffer
                );
            })
            .catch(function (error) {
                if (error && error.hlsFatal) throw error;
                throw fatalHlsError(
                    "Decifratura AES-128 fallita per il segmento " + segment.sequence +
                    ". Verificare chiave, IV, token e scadenza URL. Dettaglio: " +
                    (error.message || error),
                    error
                );
            });
    }

    function enqueueInitialSegments(parsed) {
        var list = parsed.segments;
        if (!list.length) throw new Error("La playlist non contiene segmenti.");

        var startIndex = parsed.endList ? 0 : Math.max(0, list.length - liveBackSegments);
        for (var skipped = 0; skipped < startIndex; skipped += 1) {
            knownSequences[list[skipped].sequence] = true;
        }

        list.slice(startIndex).forEach(enqueueSegment);
    }

    function enqueueSegment(segment) {
        if (knownSequences[segment.sequence]) return;
        if (segment.byteRange) {
            throw new Error("EXT-X-BYTERANGE non è supportato in questa versione.");
        }
        segment.timelineStartMs = totalTimelineMs;
        totalTimelineMs += segment.durationMs;
        knownSequences[segment.sequence] = true;
        lastKnownSequence = segment.sequence;
        pendingSegments.push(segment);
        if (pendingSegments.length > maxQueuedSegments) {
            pendingSegments.splice(0, pendingSegments.length - maxQueuedSegments);
        }
    }

    function applyMediaPlaylist(parsed, initial) {
        if (parsed.mapUrl) throw new Error("Segmenti fMP4/CMAF non ancora supportati: serve MPEG-TS .ts.");

        parsed.segments.forEach(validateSegmentKey);

        streamLive = !parsed.endList;
        targetDurationMs = parsed.targetDurationMs;
        durationLabel.textContent = streamLive ? "LIVE" : formatTime(totalTimelineMs);

        if (initial) {
            enqueueInitialSegments(parsed);
            if (!parsed.independent) {
                setStatus("Playlist caricata; EXT-X-INDEPENDENT-SEGMENTS non dichiarato, compatibilità da verificare.");
            }
        } else {
            parsed.segments.forEach(function (segment) {
                if (!knownSequences[segment.sequence]) enqueueSegment(segment);
            });
        }

        if (parsed.endList && !pendingSegments.length && !downloadedSegments.length && !currentSegment) {
            streamEnded = true;
        }

        kickNetwork();
        kickDecode();
    }

    function schedulePlaylistReload(localGeneration) {
        if (!streamLive || localGeneration !== generation) return;
        var configured = Number(config.playlistReloadMs) || 0;
        var delay = configured > 0 ? configured : Math.max(1000, Math.round(targetDurationMs / 2));
        playlistTimer = setTimeout(function () {
            reloadMediaPlaylist(localGeneration);
        }, delay);
    }

    function reloadMediaPlaylist(localGeneration) {
        if (playlistBusy || localGeneration !== generation) return;
        playlistBusy = true;
        xhr(mediaPlaylistUrl, "text", 15000)
            .then(function (text) {
                if (localGeneration !== generation) return;
                var parsed = parsePlaylist(text, mediaPlaylistUrl);
                if (parsed.type !== "media") throw new Error("La variante HLS non è una Media Playlist.");
                applyMediaPlaylist(parsed, false);
            })
            .catch(function (error) {
                if (localGeneration === generation) setStatus("Aggiornamento playlist fallito: " + error.message);
            })
            .then(function () {
                playlistBusy = false;
                schedulePlaylistReload(localGeneration);
            });
    }

    function loadInitialPlaylist(localGeneration) {
        return xhr(playlistUrl, "text", 15000)
            .then(function (text) {
                if (localGeneration !== generation) return null;
                var parsed = parsePlaylist(text, playlistUrl);
                if (parsed.type === "master") {
                    var variant = chooseVariant(parsed.variants);
                    if (!variant) throw new Error("Master playlist senza varianti.");
                    mediaPlaylistUrl = variant.url;
                    setStatus("Variante selezionata: " + (variant.resolution || variant.bandwidth + " bit/s"));
                    return xhr(mediaPlaylistUrl, "text", 15000).then(function (variantText) {
                        return parsePlaylist(variantText, mediaPlaylistUrl);
                    });
                }
                mediaPlaylistUrl = playlistUrl;
                return parsed;
            })
            .then(function (parsed) {
                if (!parsed || localGeneration !== generation) return;
                if (parsed.type !== "media") throw new Error("Media Playlist HLS non valida.");
                applyMediaPlaylist(parsed, true);
                schedulePlaylistReload(localGeneration);
            });
    }

    function kickNetwork() {
        if (networkTimer || networkBusy) return;
        networkTimer = setTimeout(downloadNextSegment, 0);
    }

    function downloadNextSegment() {
        networkTimer = 0;
        if (networkBusy || downloadedSegments.length >= maxDownloadedSegments || !pendingSegments.length) return;
        var localGeneration = generation;
        var segment = pendingSegments.shift();
        networkBusy = true;
        setBadge("Download HLS", "warning");
        xhr(segment.url, "arraybuffer", Math.max(15000, targetDurationMs * 3))
            .then(function (buffer) {
                if (localGeneration !== generation) return null;
                if (segment.key) {
                    setBadge("AES-128", "warning");
                    setStatus("Decifratura segmento HLS " + segment.sequence + "…");
                }
                return decryptSegment(buffer, segment);
            })
            .then(function (buffer) {
                if (localGeneration !== generation || !buffer) return;
                downloadedSegments.push({meta:segment, buffer:buffer});
                setStatus(
                    "Segmento " + segment.sequence +
                    (segment.key ? " decifrato" : " scaricato") +
                    "; buffer " + downloadedSegments.length + "."
                );
                kickDecode();
            })
            .catch(function (error) {
                if (localGeneration !== generation) return;

                if (error && error.hlsFatal) {
                    pendingSegments = [];
                    showFatal(error);
                    return;
                }

                pendingSegments.unshift(segment);
                setStatus("Segmento " + segment.sequence + " non scaricato: " + error.message);
            })
            .then(function () {
                networkBusy = false;
                if (localGeneration === generation && pendingSegments.length && downloadedSegments.length < maxDownloadedSegments) {
                    networkTimer = setTimeout(downloadNextSegment, 120);
                }
            });
    }

    function openDownloadedSegment(item) {
        closeCurrentSegment();
        var bytes = new Uint8Array(item.buffer);
        currentInputSize = bytes.byteLength;
        currentPointer = module._malloc(currentInputSize);
        if (!currentPointer) throw new Error("Memoria WASM insufficiente per il segmento HLS.");
        module.HEAPU8.set(bytes, currentPointer);
        var result = module._player_open(currentPointer, currentInputSize, 1);
        if (result < 0) throw new Error(wasmError());

        currentSegment = {
            meta: item.meta,
            rawBaseMs: module._player_start_time_valid() ? module._player_start_time_ms() : null,
            firstRawPts: null
        };
        hasAudio = hasAudio || module._player_has_audio() === 1;
        muteButton.disabled = !hasAudio || !ready;
    }

    function normalizePts(rawPts) {
        if (!currentSegment) return rawPts;
        if (currentSegment.rawBaseMs === null) {
            if (currentSegment.firstRawPts === null) currentSegment.firstRawPts = rawPts;
            currentSegment.rawBaseMs = currentSegment.firstRawPts;
        }
        var relative = rawPts - currentSegment.rawBaseMs;
        if (!isFinite(relative) || relative < -250) relative = 0;
        return currentSegment.meta.timelineStartMs + Math.max(0, relative);
    }

    function captureVideo() {
        var rawPts = module._player_video_pts_ms();
        var metadata = {
            pts: normalizePts(rawPts),
            width: module._player_video_width(),
            height: module._player_video_height(),
            y: module._player_video_y(),
            u: module._player_video_u(),
            v: module._player_video_v(),
            strideY: module._player_video_stride_y(),
            strideU: module._player_video_stride_u(),
            strideV: module._player_video_stride_v(),
            matrix: module._player_video_matrix(),
            fullRange: module._player_video_full_range() === 1
        };
        var frame = renderer.capture(module, metadata);
        videoQueue.push(frame);
        lastVideoPts = Math.max(lastVideoPts, frame.pts);
        resolutionMetric.textContent = frame.width + "×" + frame.height;
    }

    function captureAudio() {
        var channels = module._player_audio_channels();
        var sampleRate = module._player_audio_sample_rate();
        var sampleCount = module._player_audio_sample_count();
        var pointer = module._player_audio_data();
        var pts = normalizePts(module._player_audio_pts_ms());
        if (!pointer || channels <= 0 || sampleRate <= 0 || sampleCount <= 0) {
            throw new Error("Blocco PCM non valido.");
        }
        var total = channels * sampleCount;
        var source = new Float32Array(module.HEAPF32.buffer, pointer, total);
        var copy = new Float32Array(total);
        copy.set(source);
        var duration = sampleCount * 1000 / sampleRate;
        audioQueue.push({
            pts: pts,
            channels: channels,
            sampleRate: sampleRate,
            sampleCount: sampleCount,
            duration: duration,
            data: copy
        });
        lastAudioEnd = Math.max(lastAudioEnd, pts + duration);
        audioMetric.textContent = sampleRate + " Hz / " + channels + " ch";
    }

    function finishCurrentSegment() {
        var finished = currentSegment ? currentSegment.meta : null;
        closeCurrentSegment();
        if (finished) {
            lastVideoPts = Math.max(lastVideoPts, finished.timelineStartMs + finished.durationMs);
            if (hasAudio) lastAudioEnd = Math.max(lastAudioEnd, finished.timelineStartMs + finished.durationMs);
        }
        if (!streamLive && !pendingSegments.length && !downloadedSegments.length) streamEnded = true;
        kickNetwork();
    }

    function desiredDecodeEnd() {
        if (!ready) return prebufferMs;
        return currentMediaTime() + bufferAheadMs;
    }

    function bufferEnd() {
        if (hasAudio && isFinite(lastAudioEnd)) return Math.min(lastVideoPts, lastAudioEnd);
        return lastVideoPts;
    }

    function enoughDecoded() {
        return bufferEnd() >= desiredDecodeEnd();
    }

    function kickDecode() {
        if (decodeTimer || benchmarking) return;
        decodeTimer = setTimeout(decodeStep, 0);
    }

    function decodeStep() {
        decodeTimer = 0;
        if (benchmarking) return;
        try {
            if (enoughDecoded()) {
                maybeBecomeReady();
                return;
            }

            if (!currentSegment) {
                if (!downloadedSegments.length) {
                    kickNetwork();
                    maybeBecomeReady();
                    return;
                }
                openDownloadedSegment(downloadedSegments.shift());
                kickNetwork();
            }

            var operations = 0;
            while (currentSegment && operations < 32 && !enoughDecoded()) {
                var started = performance.now();
                var result = module._player_next_event();
                var elapsed = performance.now() - started;
                if (result === 1) {
                    captureVideo();
                    totalVideoDecodeMs += elapsed;
                    decodedVideoFrames += 1;
                    decodeMetric.textContent = elapsed.toFixed(2) + " ms";
                    averageMetric.textContent = totalVideoDecodeMs > 0
                        ? (decodedVideoFrames / (totalVideoDecodeMs / 1000)).toFixed(1) + " fps"
                        : "— fps";
                } else if (result === 2) {
                    captureAudio();
                } else if (result === 0) {
                    finishCurrentSegment();
                } else {
                    throw new Error(wasmError());
                }
                operations += 1;
            }

            maybeBecomeReady();
            if (!enoughDecoded() && (currentSegment || downloadedSegments.length)) {
                decodeTimer = setTimeout(decodeStep, 0);
            }
        } catch (error) {
            showFatal(error);
        }
    }

    function maybeBecomeReady() {
        if (ready || videoQueue.length === 0) return;
        var enough = bufferEnd() >= prebufferMs;
        var cannotGetMore = streamEnded && !currentSegment && !downloadedSegments.length;
        if (!enough && !cannotGetMore) return;

        renderer.render(videoQueue[0]);
        lastRenderedPts = videoQueue[0].pts;
        hideMessage();
        ready = true;
        setControlsEnabled(true);
        setBadge(streamLive ? "HLS LIVE pronto" : "HLS pronto", "ready");
        setStatus(hasAudio
            ? "HLS MPEG-TS pronto: H.264 e AAC decodificati in WASM."
            : "HLS pronto senza traccia audio.");
    }

    function ensureAudioContext() {
        if (!hasAudio || !AudioContextClass) return Promise.resolve(false);
        if (!audioContext) {
            var requestedSampleRate = audioQueue.length ? audioQueue[0].sampleRate : undefined;
            try {
                audioContext = new AudioContextClass({latencyHint:"playback", sampleRate:requestedSampleRate});
            } catch (error) {
                audioContext = new AudioContextClass();
            }
            gainNode = audioContext.createGain();
            gainNode.gain.value = muted ? 0 : volume;
            gainNode.connect(audioContext.destination);
        }
        return audioContext.resume().then(function () { return true; });
    }

    function takeAudioBatch(maxDurationMs) {
        if (!audioQueue.length) return null;
        var first = audioQueue[0];
        var chunks = [];
        var sampleCount = 0;
        var duration = 0;
        while (audioQueue.length) {
            var candidate = audioQueue[0];
            if (candidate.channels !== first.channels || candidate.sampleRate !== first.sampleRate) break;
            if (chunks.length && duration + candidate.duration > maxDurationMs) break;
            chunks.push(audioQueue.shift());
            sampleCount += candidate.sampleCount;
            duration += candidate.duration;
        }
        var data = new Float32Array(sampleCount * first.channels);
        var destination = 0;
        chunks.forEach(function (chunk) {
            data.set(chunk.data, destination);
            destination += chunk.data.length;
        });
        return {
            pts: first.pts,
            channels: first.channels,
            sampleRate: first.sampleRate,
            sampleCount: sampleCount,
            duration: sampleCount * 1000 / first.sampleRate,
            data: data
        };
    }

    function scheduleBatch(batch) {
        var buffer = audioContext.createBuffer(batch.channels, batch.sampleCount, batch.sampleRate);
        for (var channel = 0; channel < batch.channels; channel += 1) {
            var channelData = buffer.getChannelData(channel);
            for (var sample = 0; sample < batch.sampleCount; sample += 1) {
                channelData[sample] = batch.data[sample * batch.channels + channel];
            }
        }
        var source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(gainNode);
        var minimumStart = audioContext.currentTime + audioStartLeadMs / 1000;
        var when;
        if (!audioTimelineStarted) {
            when = minimumStart;
            audioTimelineStarted = true;
            audioTimelineContextStart = when;
            audioTimelineMediaStart = batch.pts;
        } else {
            when = nextAudioStartTime;
            if (when < audioContext.currentTime + 0.04) {
                when = minimumStart;
                audioTimelineContextStart = when;
                audioTimelineMediaStart = batch.pts;
                audioUnderruns += 1;
            }
        }
        nextAudioStartTime = when + buffer.duration;
        scheduledSources.push(source);
        source.onended = function () {
            var index = scheduledSources.indexOf(source);
            if (index >= 0) scheduledSources.splice(index, 1);
        };
        source.start(when);
    }

    function schedulePendingAudio() {
        if (!playing || !audioContext) return;
        while (audioQueue.length) {
            var batch = takeAudioBatch(audioBatchMs);
            if (!batch) break;
            scheduleBatch(batch);
        }
    }

    function currentMediaTime() {
        if (hasAudio && audioContext && audioTimelineStarted) {
            return audioTimelineMediaStart + Math.max(0, audioContext.currentTime - audioTimelineContextStart) * 1000;
        }
        return playing ? mediaAnchor + (performance.now() - performanceAnchor) : lastRenderedPts;
    }

    function renderDue(mediaTime) {
        var selected = null;
        while (videoQueue.length && videoQueue[0].pts <= mediaTime + 8) selected = videoQueue.shift();
        if (selected) {
            renderer.render(selected);
            lastRenderedPts = selected.pts;
            waitingForData = false;
        } else if (videoQueue.length === 0 && mediaTime > lastVideoPts - 100) {
            waitingForData = true;
        }
    }

    function updateProgress(mediaTime) {
        timeLabel.textContent = formatTime(mediaTime);
        if (streamLive) {
            var ahead = Math.max(0, bufferEnd() - mediaTime);
            progressBar.style.width = Math.min(100, ahead / bufferAheadMs * 100) + "%";
        } else {
            progressBar.style.width = totalTimelineMs > 0
                ? Math.max(0, Math.min(100, mediaTime / totalTimelineMs * 100)) + "%"
                : "0%";
            durationLabel.textContent = formatTime(totalTimelineMs);
        }
    }

    function stopPlaybackLoops() {
        if (animationHandle) cancelAnimationFrame(animationHandle);
        if (pumpTimer) clearTimeout(pumpTimer);
        animationHandle = pumpTimer = 0;
    }

    function pump() {
        pumpTimer = 0;
        if (!playing || benchmarking) return;
        kickDecode();
        kickNetwork();
        schedulePendingAudio();
        if (audioUnderruns > 0 && audioContext) {
            audioMetric.textContent = audioContext.sampleRate + " Hz / underrun " + audioUnderruns;
        }
        pumpTimer = setTimeout(pump, 35);
    }

    function renderLoop() {
        animationHandle = 0;
        if (!playing || benchmarking) return;
        var mediaTime = currentMediaTime();
        renderDue(mediaTime);
        updateProgress(mediaTime);
        if (waitingForData) setBadge("Buffering", "warning");
        else setBadge(streamLive ? "HLS LIVE" : "HLS", "ready");

        if (!streamLive && streamEnded && videoQueue.length === 0 && mediaTime >= totalTimelineMs - 30) {
            playing = false;
            playButton.textContent = "Play";
            setStatus("Riproduzione HLS terminata.");
            return;
        }
        animationHandle = requestAnimationFrame(renderLoop);
    }

    function beginPlayback() {
        if (!ready || benchmarking || playing) return;
        ensureAudioContext().then(function (audioAvailable) {
            playing = true;
            playButton.textContent = "Pausa";
            if (audioAvailable) {
                schedulePendingAudio();
            } else {
                performanceAnchor = performance.now();
                mediaAnchor = lastRenderedPts;
            }
            setStatus(audioAvailable ? "Riproduzione HLS software con audio." : "Riproduzione HLS video; Web Audio non disponibile.");
            stopPlaybackLoops();
            animationHandle = requestAnimationFrame(renderLoop);
            pumpTimer = setTimeout(pump, 0);
        }).catch(function (error) { setStatus("Audio non avviato: " + error.message); });
    }

    function pause() {
        if (!playing) return;
        playing = false;
        playButton.textContent = "Play";
        stopPlaybackLoops();
        if (audioContext && audioContext.state === "running") audioContext.suspend();
        setStatus("Riproduzione in pausa.");
    }

    function resume() {
        if (!ready || benchmarking || playing) return;
        if (hasAudio && audioContext && audioTimelineStarted && scheduledSources.length) {
            audioContext.resume().then(function () {
                playing = true;
                playButton.textContent = "Pausa";
                stopPlaybackLoops();
                animationHandle = requestAnimationFrame(renderLoop);
                pumpTimer = setTimeout(pump, 0);
                setStatus("Riproduzione ripresa.");
            });
        } else {
            beginPlayback();
        }
    }

    function togglePlayback() { playing ? pause() : resume(); }

    function connectStream() {
        pause();
        resetPipeline();
        var localGeneration = generation;
        setBadge("Playlist HLS", "warning");
        showMessage("Caricamento chunklist M3U8…");
        setStatus("Connessione a " + playlistUrl);
        loadInitialPlaylist(localGeneration).catch(showFatal);
    }

    function toggleMute() {
        muted = !muted;
        if (gainNode) gainNode.gain.value = muted ? 0 : volume;
        muteButton.textContent = muted ? "Audio ON" : "Mute";
        setStatus(muted ? "Audio disattivato." : "Audio attivato.");
    }

    function changeVolume(delta) {
        volume = Math.max(0, Math.min(1, volume + delta));
        if (volume > 0) muted = false;
        if (gainNode) gainNode.gain.value = muted ? 0 : volume;
        muteButton.textContent = muted ? "Audio ON" : "Mute";
        setStatus("Volume stream HLS: " + Math.round(volume * 100) + "%.");
    }

    function toggleSize() {
        compact = !compact;
        pipPanel.classList.toggle("compact", compact);
    }

    function openPanel() {
        panelOpen = true;
        launcher.classList.add("hidden");
        pipPanel.classList.remove("hidden");
        pipPanel.classList.toggle("compact", compact);
    }

    function closePanel() {
        panelOpen = false;
        pause();
        pipPanel.classList.add("hidden");
        launcher.classList.remove("hidden");
    }

    function benchmark() {
        if (benchmarking || !ready) return;
        pause();
        benchmarking = true;
        setControlsEnabled(false);
        setBadge("Benchmark HLS", "warning");
        setStatus("Il benchmark usa i frame già decodificati e misura il costo medio osservato.");
        var measured = totalVideoDecodeMs > 0 ? decodedVideoFrames / (totalVideoDecodeMs / 1000) : 0;
        averageMetric.textContent = measured.toFixed(1) + " fps";
        setBadge(measured >= 30 ? "PiP consigliato" : measured >= 25 ? "PiP al limite" : "TV insufficiente", measured >= 30 ? "ready" : measured >= 25 ? "warning" : "error");
        setTimeout(function () {
            benchmarking = false;
            setControlsEnabled(true);
        }, 400);
    }

    function normaliseKey(event) {
        var code = event.keyCode || event.which || 0;
        var key = event.key ? String(event.key).toLowerCase() : "";
        if (key === "r") return KEY.RED;
        if (key === "g") return KEY.GREEN;
        if (key === "y") return KEY.YELLOW;
        if (key === "b") return KEY.BLUE;
        if (key === "m") return 77;
        return code;
    }

    function handleKey(event) {
        var code = normaliseKey(event);
        if (code === KEY.RED) {
            panelOpen ? closePanel() : openPanel();
            event.preventDefault();
            return;
        }
        if (!panelOpen) return;
        if (code === KEY.ENTER || code === KEY.PLAY || code === KEY.PAUSE || code === KEY.SPACE) togglePlayback();
        else if (code === KEY.GREEN) connectStream();
        else if (code === KEY.YELLOW) toggleSize();
        else if (code === KEY.BLUE) benchmark();
        else if (code === 77) toggleMute();
        else if (code === KEY.UP) changeVolume(0.1);
        else if (code === KEY.DOWN) changeVolume(-0.1);
        else if (code === KEY.BACK || code === KEY.ESCAPE) closePanel();
        else return;
        event.preventDefault();
    }

    function showFatal(error) {
        console.error(error);
        ready = false;
        setControlsEnabled(false);
        setBadge("Errore", "error");
        showMessage("Stream HLS non avviato.");
        setStatus(error.message || String(error));
    }

    function start() {
        initialiseHbbTV();
        try { renderer = new SoftwareYuvRenderer(canvas); }
        catch (error) { showFatal(error); return; }

        if (typeof createHlsPlayer !== "function") {
            showFatal(new Error("hls-player.js non generato. Esegui make serve."));
            return;
        }

        createHlsPlayer({locateFile:function(path){return "./" + path;}})
            .then(function (created) {
                module = created;
                if (!(module.HEAPU8 instanceof Uint8Array) || !(module.HEAPF32 instanceof Float32Array)) {
                    throw new Error("Memoria WASM non esportata.");
                }
                connectStream();
            })
            .catch(showFatal);

        if (config.startOpen !== false) openPanel();
    }

    playButton.addEventListener("click", togglePlayback);
    restartButton.addEventListener("click", connectStream);
    benchmarkButton.addEventListener("click", benchmark);
    muteButton.addEventListener("click", toggleMute);
    sizeButton.addEventListener("click", toggleSize);
    closeButton.addEventListener("click", closePanel);
    window.addEventListener("keydown", handleKey, false);
    window.addEventListener("beforeunload", function () {
        generation += 1;
        clearTimers();
        stopAudioSources();
        closeCurrentSegment();
        if (audioContext) audioContext.close();
    });

    start();
}());
