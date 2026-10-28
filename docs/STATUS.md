# Hermes: fatto e da fare

Aggiornato a ogni tranche. Le prove a mano sono in [TEST-TODO.md](TEST-TODO.md), le regole tecniche in
[../CLAUDE.md](../CLAUDE.md), la specifica in [SPEC.md](SPEC.md).

## Fatto

| Tranche | Cosa | Release |
|---|---|---|
| T0-T7 | Base dell'app, aggiornamenti, coda, Eagle, Video Downloader, Gallery, Background Removal, Upscale | v0.3.0 |
| T8-T12 | Tool nascondibili, tutto ricordato alla chiusura, Audible, Demucs, Subtitles, giro di feedback (info, statistiche, viewer...) | v0.4.0 |
| T13 | Pagina Downloads, console per ogni lavoro, Clear, download in parallelo, Spotify, Video Converter, risoluzioni/Premiere/Mix | v0.5.0 |
| T14 | Pallini nella sidebar, app più leggera, modalità Gentle, controllo aggiornamenti modelli AI, Thumbnail Tester | v0.6.0 |
| fix | Impostazioni non più perse riaprendo un tool durante un'operazione (tutti i tool) | v0.6.0 |
| T15 | Spotify: ogni fonte verificata (niente osu!/cover/fan upload), feedback durante la lettura del link, barra graduale | v0.6.0 |
| T16 | Video Downloader audio: copertina quadrata, testi ufficiali incorporati nell'MP3, WAV 48 kHz con pill "Montaggio" | v0.6.0 |
| T17a | Menu a tendina, tooltip, barre di scorrimento, campi numero/data/colore nello stile di Hermes; screenshot di ogni pagina controllati; regola UI in CLAUDE.md | v0.6.0 |
| T17b | Feedback dal vivo in ogni attesa (Video, Gallery, Thumbnail Tester, Audible, Binaries); ordine dei tool trascinabile nei Settings | v0.6.0 |
| T18 | Thumbnail Tester: ultimi canali e ricerche come scelte rapide, date vere dei video, Outliers (visualizzazioni ÷ iscritti), Find similar | v0.6.0 |
| T19 | Statistiche d'uso solo locali, esportabili da Settings per l'ottimizzazione, senza dati personali | v0.6.0 |
| T20a | Image Converter: PNG/JPG/WebP/AVIF/TIFF/BMP/GIF/ICO in tutte le direzioni, ridimensionamento, immagine → SVG vettoriale | v0.6.0 |
| T20b | Document Converter: DOCX, PDF, Markdown, LaTeX, HTML, EPUB, ODT, RTF, PPTX, XLSX in tutte le direzioni utili, PDF in immagini/testo; componenti scaricati solo con conferma; modelli e componenti eliminabili da Binaries | v0.6.0 |
| T21 | Pattern Generator: griglia di punti a onde (idea da Durves, scritto da zero), formati 1:1/16:9/9:16/4:5, Random, preset, PNG fino a 4K con o senza sfondo, SVG | v0.7.0 |
| T22 | Pixel Art: dimensione pixel, luminosità/contrasto/saturazione, palette incluse / Lospec / incollate / dall'immagine, dithering, griglia, export piccolo o fino a 4K, più immagini insieme | v0.7.0 |
| pulizia | Gallery: uscendo e rientrando durante la lettura l'elenco ora compare; playlist con video non disponibili ora si aggiungono (prima "Add to queue" non faceva niente); un solo avviso cookie invece di tre; errori di ffmpeg con il nome del file; test più affidabili (galleria locale) | v0.7.0 |
| fix | Pattern Generator: onde come su Durves (ogni punto si sposta di tutta l'ampiezza, il rumore decide solo la direzione; stessa scala di Durves, quindi gli stessi numeri danno lo stesso risultato) | da pubblicare |

Provato e scartato: FLAC da SpotiFLAC (server non funzionanti), Mornye (app per telefono, estensioni di terzi).
FLAC abbandonato per scelta (ottobre 2026).

## Da fare (in ordine)

Niente in coda: dimmi tu il prossimo tool o le correzioni.
