"use strict";

window.PIP_CONFIG = {
    /*
     * Link HLS richiesto. È una Media Playlist/chunklist, non un file MP4.
     * I parametri tk2/tend possono essere temporanei: sostituire l'URL quando
     * il CDN genera un nuovo token.
     */
    hlsUrl: "https://streamcdnr8-8e7439fdb1694c8da3a0fd63e4dda518.msvdn.net/raiuno1/hls/rai1_1200/chunklist.m3u8?baseuri=%2Fraiuno1%2Fhls%2F&tstart=0&tend=1785402814&tk2=e6bb580a7b032483aeaccf97879c33019d9454022cc507977669b9111d903fbe",

    /* Per test locale, usare invece: "./media/hls/demo.m3u8" */
    localDemoUrl: "./media/hls/demo.m3u8",
    useLocalDemo: false,

    startOpen: true,
    compactByDefault: true,
    volume: 0.65,
    muted: false,

    /* In una diretta si parte alcuni segmenti dietro il bordo live. */
    liveBackSegments: 3,

    /* Download e decodifica anticipata. */
    prebufferMs: 4500,
    bufferAheadMs: 9000,
    maxDownloadedSegments: 3,
    maxQueuedSegments: 12,

    /* Audio PCM continuo. */
    audioBatchMs: 1800,
    audioStartLeadMs: 350,

    /* Playlist live: 0 = intervallo ricavato da EXT-X-TARGETDURATION. */
    playlistReloadMs: 0,

    benchmarkVideoFrames: 100
};
