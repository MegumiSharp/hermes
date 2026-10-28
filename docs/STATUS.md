# Hermes: fatto e da fare

Aggiornato a ogni tranche. Le prove a mano sono in [TEST-TODO.md](TEST-TODO.md), le regole tecniche in
[../CLAUDE.md](../CLAUDE.md), la specifica in [SPEC.md](SPEC.md).

## Fatto

| Tranche | Cosa | Release |
|---|---|---|
| T0-T7 | Base dell'app, aggiornamenti, coda, Eagle, Video Downloader, Gallery, Background Removal, Upscale | v0.3.0 |
| T8-T12 | Tool nascondibili, tutto ricordato alla chiusura, Audible, Demucs, Subtitles, giro di feedback (info, statistiche, viewer...) | v0.4.0 |
| T13 | Pagina Downloads, console per ogni lavoro, Clear, download in parallelo, Spotify, Video Converter, risoluzioni/Premiere/Mix | v0.5.0 |
| T14 | Pallini nella sidebar, app più leggera, modalità Gentle, controllo aggiornamenti modelli AI, Thumbnail Tester | non pubblicata |
| fix | Impostazioni non più perse riaprendo un tool durante un'operazione (tutti i tool) | non pubblicata |
| T15 | Spotify: ogni fonte verificata (niente osu!/cover/fan upload), feedback durante la lettura del link, barra graduale | non pubblicata |
| T16 | Video Downloader audio: copertina quadrata, testi ufficiali incorporati nell'MP3, WAV 48 kHz con pill "Montaggio" | non pubblicata |
| T19 | Statistiche d'uso solo locali, esportabili da Settings per l'ottimizzazione, senza dati personali | non pubblicata |
| T18 | Thumbnail Tester: ultimi canali e ricerche come scelte rapide, date vere dei video, Outliers (visualizzazioni ÷ iscritti), Find similar | non pubblicata |
| T17b | Feedback dal vivo in ogni attesa (Video, Gallery, Thumbnail Tester, Audible, Binaries); ordine dei tool trascinabile nei Settings | non pubblicata |
| T17a | Menu a tendina, tooltip, barre di scorrimento, campi numero/data/colore nello stile di Hermes; screenshot di ogni pagina controllati; regola UI in CLAUDE.md | non pubblicata |

Provato e scartato: FLAC da SpotiFLAC (server non funzionanti), Mornye (app per telefono, estensioni di terzi).
FLAC abbandonato per scelta (ottobre 2026).

## Da fare (in ordine)

1. **T20 Convertitore**: documenti (DOCX, PDF, Markdown, LaTeX, HTML, EPUB, ODT), PDF in immagini/testo, immagini
   (JPG, PNG, WebP...), immagine in vettoriale (PNG → SVG). Componenti pesanti scaricati solo se confermi;
   in ogni tool si possono eliminare modelli e componenti non più usati.
2. **T21 Pattern Generator** (idea da durves.com, scritto da zero): griglia di punti deformata a onde con matrice,
   dimensione, raggio, ampiezza, onde, frequenza, colori; formati 1:1 / 16:9 / 9:16 / 4:5; sfondo trasparente o colore;
   dado per motivi casuali e preset; export PNG fino a 4K e SVG vettoriale, invio a Eagle; tutto ricordato alla chiusura.
3. **Pulizia**: Gallery che non mostra l'elenco se esci e rientri durante la lettura; test t3 (testo errore ffmpeg),
   t4 (bug del test), galleria dei test su un sito diverso da Wikimedia; verifica del secondo schermo quando è collegato.
4. **Release** v0.6.0 quando dici tu.
