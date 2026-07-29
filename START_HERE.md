# AVVIO RAPIDO HLS

1. Apri `web/config.js` e imposta `hlsUrl`.
2. Per provare senza rete, imposta `useLocalDemo: true`.
3. Esegui:

```bash
make distclean
make serve
```

4. Apri la porta 8080.
5. Premi Play per attivare anche l'audio.

Se compare un errore di rete, controllare CORS e la scadenza del token URL.


Per playlist con `EXT-X-KEY:METHOD=AES-128` non serve ricompilare FFmpeg: la
decifratura viene effettuata prima del demuxing tramite Web Crypto.
