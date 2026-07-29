# HbbTV WASM HLS Software PiP

Questa versione riproduce nel riquadro PiP una playlist HLS `.m3u8` senza usare
un secondo elemento HTML `<video>`.

## Architettura

```text
chunklist.m3u8
      ↓ XMLHttpRequest JavaScript
segmenti MPEG-TS .ts
      ↓ memoria WASM
libavformat MPEG-TS
      ├── H.264 → libavcodec → YUV420P → WebGL
      └── AAC   → libavcodec → PCM float → Web Audio
```

Il programma televisivo principale continua a usare il player hardware
`video/broadcast`. Il PiP usa la CPU tramite FFmpeg/WebAssembly.

## Avvio

```bash
make distclean
make serve
```

Aprire la porta 8080. La prima compilazione di FFmpeg è lenta.

## Selezione dello stream

Modificare `web/config.js`:

```javascript
hlsUrl: "https://server.example/live/chunklist.m3u8"
```

Per il test locale:

```javascript
useLocalDemo: true
```

`make serve` genera automaticamente una playlist locale con segmenti `.ts`.

## Requisito CORS

La pagina deve poter leggere sia la playlist sia ogni segmento. Il CDN deve
restituire un `Access-Control-Allow-Origin` compatibile con l'origine della
applicazione. Un link che funziona in VLC non è automaticamente leggibile da
JavaScript nel browser.

## Formati supportati

- Media Playlist `.m3u8` diretta;
- Master Playlist semplice: viene scelta la variante con bitrate più basso;
- segmenti MPEG-TS `.ts`;
- `EXT-X-KEY:METHOD=AES-128` con chiave `identity`;
- video H.264 YUV420P 8 bit;
- audio AAC o AAC-LATM;
- dirette e playlist VOD;
- aggiornamento periodico della playlist live;
- `EXT-X-MEDIA-SEQUENCE`, `EXTINF`, `EXT-X-ENDLIST`, discontinuità di base.

## Limiti della prima versione

- niente segmenti fMP4/CMAF con `EXT-X-MAP`;
- niente `SAMPLE-AES`, FairPlay o altri `KEYFORMAT` DRM;
- niente `EXT-X-BYTERANGE`;
- niente audio in playlist separata tramite `EXT-X-MEDIA`;
- nessun cambio adattivo di qualità durante la riproduzione;
- i decoder vengono riaperti per ogni segmento: lo stream dovrebbe avere
  segmenti indipendenti o iniziare ogni segmento con keyframe/SPS/PPS;
- la compatibilità CORS dipende dal CDN;
- gli URL firmati con token possono scadere.

## Comandi

```text
OK / Invio       Play/Pausa
VERDE / G        ricarica la playlist e torna al bordo live
GIALLO / Y       cambia dimensione
BLU / B          mostra benchmark osservato
M                mute
SU / GIÙ         volume
ROSSO / R        apre/chiude PiP
```

## Perché non usare hls.js

`hls.js` normalmente alimenta Media Source Extensions e un elemento `<video>`.
Questa applicazione deve evitare il secondo decoder media del televisore, quindi
scarica playlist e segmenti in JavaScript e mantiene la decodifica dentro WASM.


## Playlist cifrate AES-128

Quando la playlist contiene:

```text
#EXT-X-KEY:METHOD=AES-128,URI="..."
```

l'applicazione scarica la chiave da 16 byte, calcola l'IV esplicito oppure lo
deriva da `EXT-X-MEDIA-SEQUENCE`, decifra ciascun segmento con AES-CBC/PKCS#7 e
solo dopo passa il MPEG-TS in chiaro a FFmpeg/WASM.

Sono necessari:

- Web Crypto API (`window.crypto.subtle`);
- CORS valido anche sull'URL della chiave;
- chiave accessibile con il token corrente.

Aprire la playlist direttamente nel browser non equivale a leggerla tramite
JavaScript: il player nativo può gestire internamente chiave e segmenti, mentre
l'applicazione deve poter leggere esplicitamente ogni risposta.

Non sono supportati `METHOD=SAMPLE-AES`, `KEYFORMAT` DRM o FairPlay.
