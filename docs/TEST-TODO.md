# Hermes: cosa provare a mano

Exe da usare: `release\Hermes.exe` (oppure scaricalo dalla release GitHub più recente).
Copialo in una cartella tua (es. `D:\Tools\Hermes\`): al primo avvio crea `hermes-data\` accanto a sé.
Tieni **Eagle aperto** per i test con Eagle.

## 0. Avvio e aggiornamenti
- [ ] Primo avvio: si apre senza console nere; la pagina **Binaries** mostra yt-dlp, gallery-dl, FFmpeg, Real-ESRGAN, DirectML tutti "Working".
- [ ] Riduci / ingrandisci / chiudi dalla barra del titolo; trascina la finestra dalla barra.
- [ ] **Settings → Check now**: dice "latest version" (o propone un aggiornamento se esiste una release più nuova).
- [ ] Aggiornamento app: avvia una versione vecchia (es. la 0.2.0 da GitHub) → banner "Hermes X is available" → Update → si riavvia da sola alla nuova versione.
- [ ] Binaries → **Check for updates**: nessun errore; il toggle "Update yt-dlp automatically" si salva.

## 1. Video Downloader (yt-dlp)
- [ ] Incolla un URL YouTube: l'anteprima parte da sola (miniatura, titolo, canale, durata, risoluzione, peso).
- [ ] **Best quality** su un video 4K: scarica il file nativo (webm/mkv) alla massima risoluzione.
- [ ] **1080p**: file MP4 H.264 quando disponibile.
- [ ] **MP4 Converted** su un video 4K: barra "Converting (NVENC)", file finale `.mp4` H.264 + AAC, nessun `.mkv` rimasto. **Importalo in Premiere** e verifica che si legga e scorra fluido.
- [ ] **Audio only**: MP3 320 kbps con copertina e titolo (controlla in Esplora risorse / un player).
- [ ] **Playlist**: compare come gruppo espandibile in coda, contatore "x / y", ogni traccia scaricata.
- [ ] **Send to Eagle** attivo: il file finisce in Eagle → *Uncategorized* con tag canale + URL e sparisce dalla cartella.
- [ ] Chiudi Eagle, aggiungi un download con Eagle attivo: avviso "Eagle is not running", l'elemento resta "Eagle is closed"; riapri Eagle → si importa da solo entro ~10 s. Prova anche il pulsante "Keep in folder".
- [ ] Cambia cartella con "Save to" e verifica che venga ricordata al riavvio.

## 2. Cookie
- [ ] Chip cookie in alto a destra: con Firefox installato mostra "Firefox cookies".
- [ ] Imposta **Chrome** come sorgente con Chrome aperto e prova un video: deve aprirsi il **modal** con la spiegazione (lettura fallita) mentre l'anteprima continua senza cookie.
- [ ] Esporta i cookie con l'estensione *Get cookies.txt LOCALLY* e trascina il file nel modal: deve dire "Valid … signed in, expires …". Prova anche un file sbagliato (deve rifiutarlo con un messaggio chiaro).
- [ ] Video con limite d'età o solo membri: con i cookie validi si scarica.

## 3. Coda (vale per tutti i moduli)
- [ ] Più download insieme: massimo 3 in contemporanea, barra totale + percentuale + "x / y done".
- [ ] Pausa / riprendi / rimuovi su un elemento in corso; "Pause all"; "Clear finished".
- [ ] Chiudi Hermes durante un download e riaprilo: la coda c'è ancora e il download riparte.
- [ ] Se un sito limita (429): banner "Rate limited" con conto alla rovescia e "Resume now".

## 4. Gallery Downloader (gallery-dl)
- [ ] Incolla una galleria che usi davvero (Instagram / X / Pixiv / Reddit…): griglia di anteprime.
- [ ] Filtri: tipo (immagini/video/GIF), estensioni, risoluzione minima, date, dimensione, "Items to read" (poi Fetch di nuovo).
- [ ] Clic sulle miniature per escludere singoli file; Select all / none; il conteggio "x of y selected" torna.
- [ ] Download: scarica **solo** i file selezionati; con Eagle attivo vanno in Eagle con tag autore + URL.
- [ ] Rilancia la stessa galleria con "Skip already downloaded": non riscarica nulla.
- [ ] Siti con login: se servono cookie, compare "Set up cookies" (stesso modal del video).

## 5. Background Removal (rembg)
- [ ] Al primo accesso: avviso "No model installed". **Models** → spunta i modelli → mostra la dimensione totale → chiede conferma → barre di download.
- [ ] Consigliato da provare: **BiRefNet General** (migliore, ~930 MB), **BiRefNet General Lite**, **ISNet General**.
- [ ] **Batch**: trascina più immagini (anche dal browser/Esplora), "Remove backgrounds" → PNG trasparente; poi **slider prima/dopo** nei Results; con Eagle attivo il risultato va in Eagle.
- [ ] Opzioni: sfondo colore pieno, "Crop to subject".
- [ ] **Compare models**: una foto, spunta 2-4 modelli → griglia con tempi → clic su uno → slider → "Keep" (va in Eagle o nella cartella).
- [ ] Velocità: con la 3060 Ti BiRefNet dovrebbe stare in pochi secondi per immagine (DirectML). Se è molto lento (decine di secondi) dimmelo: vuol dire che sta usando la CPU.
- [ ] Cestino nel gestore modelli: elimina un modello e libera spazio.

## 6. Upscale (Real-ESRGAN)
- [ ] Immagine: modello **Photo** 4× → risultato 4 volte più grande, slider prima/dopo.
- [ ] Illustrazione / anime: modello **Illustration**.
- [ ] Video breve (10-30 s): modello **Video / fast** 2× → MP4 H.264 con audio originale; controlla che `hermes-data\temp` venga svuotata alla fine.
- [ ] Video lungo: verifica tempi e spazio disco (avviso sul consumo di spazio).

## 7. Memoria e strumenti nascosti
- [ ] Settings → Tools: spegni un tool che non usi, sparisce dalla sidebar; riaprendo Hermes resta nascosto.
- [ ] Scrivi un URL, trascina file, cambia schede/opzioni in ogni tool, poi chiudi Hermes (anche con la X) e riaprilo: ritrovi tutto, e le anteprime degli URL si ricaricano da sole.
- [ ] Sposta e ridimensiona la finestra (o massimizzala), chiudi e riapri: torna com'era.

## 8. Audible
- [ ] Audible → scegli il marketplace (Italia) → **Sign in with Amazon**: si apre il browser sulla pagina Amazon.
- [ ] Fai il login (a volte due volte + captcha), arrivi su "Pagina non trovata": copia l'indirizzo completo, incollalo in Hermes → **Connect**.
- [ ] Compare la tua libreria con copertine; prova la ricerca (titolo, autore, narratore, serie).
- [ ] Seleziona 1 libro corto → Download: in coda "Downloading" poi "Converting to M4B"; risultato `Cartella\Autore\Titolo.m4b`.
- [ ] Apri l'M4B in un player (es. VLC o l'app Libri): **capitoli** e **copertina** presenti, audio completo.
- [ ] Il libro risulta "Downloaded" nella lista. Chiudendo e riaprendo resti collegato.
- [ ] Sign out funziona (il dispositivo resta in Amazon → Gestisci contenuti e dispositivi, se vuoi rimuoverlo).

## 9. Stem Separation (Demucs) e Subtitles (faster-whisper)
- [ ] Al primo uso: avviso "needs the AI runtime" → **Install** → conferma con componenti e dimensioni (~2.5 GB) → barra di avanzamento.
- [ ] Demucs: trascina una canzone, **Vocals + instrumental**, MP3 → due file in `Cartella\Stems\htdemucs\`. Prova anche **Fine-tuned** e **6 stems**.
- [ ] Prima volta con un modello: chiede conferma del download del modello.
- [ ] Subtitles: trascina un tuo video in italiano, modello **Large v3 Turbo**, lingua automatica, SRT → controlla tempi e testo; prova "Translate to English".
- [ ] Velocità: con la 3060 Ti una trascrizione di 10 minuti dovrebbe richiedere ~1 minuto. Se dice "using CPU" o è molto lenta, dimmelo.

## 10. Novità del giro di feedback
- [ ] Ogni tool ha **Info** in alto a destra: cosa fa e da quali siti scarica.
- [ ] Sidebar **Activity**: avvia un download di modelli o un'installazione e continua a usare altri tool; la barra in sidebar mostra l'avanzamento, clic → torni al tool.
- [ ] Background Removal: **Ctrl+V** di un'immagine copiata (anche screenshot), o pulsante **Paste**; file copiati in Esplora + Ctrl+V.
- [ ] Il batch mostra miniature con stato; un errore resta nel batch con **Copy error** (incollamelo in chat se succede) e Riprova.
- [ ] Riprova il modello che ti dava `DmlFusedNode_19_64`: ora riprova da solo in "GPU (safe mode)" o "CPU" e lo scrive sul risultato.
- [ ] Compare: avvialo e cambia tool, torna: i risultati ci sono ancora. Clic su un risultato → viewer con schede e ←/→ tra i modelli.
- [ ] Zoom su tutti i prima/dopo (rotella, +/−, Fit, trascina per spostarti; doppio clic 1×/4×). In Upscale anche **Expand** nei Results.
- [ ] Statistiche CPU/RAM/GPU sopra gli strumenti AI; Settings → "Show system stats" per nasconderle.
- [ ] Gallery: elenco testuale di default (titolo/nome, tipo, risoluzione, data), "Show previews" per le miniature, filtri **Title contains / excludes**.
- [ ] Gallery durante il download: in coda clic su "N files" → elenco file per file con ✓/✗ e motivo del server (es. 429, 403).

## 11. Novità (giro 2)
- [ ] **Downloads** nella sidebar (al posto di Activity): tutti i download e lavori di tutti i tool, con il nome del tool; il numerino sulla voce indica quanti sono in corso.
- [ ] In ogni coda clicca la freccia di un elemento: si apre la **console** dal vivo (comando, file scaricati, avvisi, errori del server in rosso).
- [ ] Avvia qualcosa, cambia tool e torna: la barra di progresso è visibile subito.
- [ ] Pulsante **Clear** in alto in ogni tool: svuota coda (tranne ciò che sta girando) e immagini/file.
- [ ] Settings → **Downloads at the same time** (default 6). Pausa dopo un blocco del sito: 1 min, poi 2, 4, 8, max 15. Il timer appare solo se qualcosa sta aspettando.
- [ ] Compare models: il PC non dovrebbe più rallentare (tool a priorità bassa, metà dei core). Dimmi se lo senti ancora.
- [ ] Background Removal / Image Upscale: i risultati sono **sempre** nella cartella scelta (con Eagle ne arriva anche una copia in Eagle).
- [ ] Video Downloader: Best / 2160p / 1440p / 1080p (quelle non disponibili sono grigie), sotto c'è scritto **in che formato** viene salvato; spunta **Convert to MP4 for Premiere**.
- [ ] Link di un **Mix** YouTube (`&list=RD…`): compare la spunta per scaricare tutto il Mix (max 50) invece della sola canzone. Stessa cosa per i video dentro una playlist.
- [ ] **Spotify** (sotto Video Downloader): incolla un link di brano/album/playlist → elenco brani → Download.
- [ ] **Video Converter**: converti in MP4/H.265/ProRes/WebM/GIF/MP3/WAV, cambia risoluzione (anche ingrandire a 1080p/4K), fps e qualità.
- [ ] Gallery: con "Show previews" spento non compare nessun elenco, solo il riepilogo; il dettaglio file per file è nella console dell'elemento in coda.

## 12. Novità (giro 3)
- [ ] **Pallino nella sidebar** accanto a ogni tool: giallo lampeggiante mentre lavora, verde quando ha finito, rosso se qualcosa è fallito. Sparisce quando apri quel tool.
- [ ] Background Removal → **Performance**: *Fast (GPU)* come prima, *Gentle* usa la CPU con 2 core (più lento, ma il PC resta usabile mentre lavori o monti). Prova un batch grande in Fast e dimmi se l'app ora resta fluida.
- [ ] L'app in generale: avvio più veloce (gli strumenti vengono verificati solo se cambiano), anteprime delle immagini più leggere, coda più leggera (la console si carica solo quando la apri).
- [ ] Binaries → **AI models → Check models**: dice se i modelli scaricati (Background Removal, Whisper) hanno una versione nuova, con **Update**. PyTorch/Demucs/faster-whisper sono informativi: si aggiornano con Hermes.
- [ ] **Thumbnail Tester** (nuovo tool): appena lo apri carica video veri da una ricerca YouTube a caso (dado = altro argomento, oppure scrivi la tua nicchia → Search).
  - Trascina/incolla una o più thumbnail, scrivi il titolo (avviso se troppo lungo), durata; occhio per mostrare/nascondere una variante (A/B).
  - Link del tuo canale → Fetch: nome e foto profilo appaiono sui tuoi video. Views e Uploaded modificabili.
  - Dispositivi: Home, Search (con descrizione), Up next, Mobile (cornice telefono). Dark/Light, Mine (bordo sui tuoi), B/W, Squint (sfocato), Watched (barra rossa sugli altri). Shuffle / Reset posizioni.
  - **Size view**: la tua thumbnail a 640, 360, 246, 168, 120 px. Avvisi se è sotto 1280×720 o non 16:9.

## 13. Spotify (giro 4)
- [ ] Incolla il link di **BIRDBRAIN** (o un'altra canzone che ti aveva dato una versione sbagliata): durante la lettura vedi cosa sta facendo, i secondi e **Details** con l'output.
- [ ] Ogni brano ha un'etichetta: **Official**, **Fixed** (la scelta di spotDL era un video di fan/cover, sostituita con quella ufficiale) o **No reliable source** (saltato, a meno che premi *Use anyway*). Clic sull'etichetta = apre la fonte.
- [ ] Una playlist: la barra deve avanzare in modo graduale, non solo alla fine.

## 14. Grafica (giro 4)
- [ ] Apri i menu a tendina di ogni tool: devono avere tutti lo stesso aspetto scuro con il segno di spunta arancione, nessuno quello di Windows.
- [ ] Passa il mouse su un pulsante con suggerimento (per esempio Clear): il riquadro è scuro come il resto dell'app.
- [ ] Le barre di scorrimento sono sottili e scure, senza freccette. Dimmi se vedi ancora qualcosa che sembra "di Windows" o spaziature strane.

## 15. Video Downloader audio (giro 4)
- [ ] Formato **Audio only** con una canzone che ha i sottotitoli ufficiali (es. un video musicale ufficiale): sotto dice "lyrics (en)". Apri l'MP3 in un lettore che mostra i testi (foobar2000, MusicBee, l'app Musica di Windows): ci sono il testo e la copertina quadrata.
- [ ] Spunta **WAV for editing**: il file è un WAV a 48 kHz, in coda ha la pill **WAV · Montaggio**; importalo in Premiere.
- [ ] Chiudi e riapri Hermes: le spunte sono rimaste.

## 16. Feedback e ordine dei tool (giro 4)
- [ ] Incolla un link nel Video Downloader, nella Gallery, cerca nel Thumbnail Tester, carica la libreria Audible, controlla gli aggiornamenti in Binaries: ogni volta vedi cosa sta facendo, i secondi che passano e (quando lo strumento scrive qualcosa) **Details**.
- [ ] Settings → Tools: trascina un tool dalla maniglia ⋮⋮ (o selezionala e usa Alt+↑/↓). La sidebar cambia subito e l'ordine resta dopo il riavvio.

## 17. Thumbnail Tester (giro 4)
- [ ] Cerca la tua nicchia e leggi il tuo canale e un altro: sotto i campi compaiono come scelte rapide (un clic per tornarci). Il dado non riempie la lista.
- [ ] Dopo qualche secondo le date dei video diventano quelle vere ("3 years ago" ecc.).
- [ ] **Outliers**: su ogni video compare visualizzazioni ÷ iscritti; da ×3 in su è evidenziato, gli altri sbiaditi (servono gli iscritti dei canali, arrivano uno alla volta).
- [ ] Scrivi il titolo della tua thumbnail e premi **Find similar**: cerca i video con cui competi.
- [ ] Chiudi e riapri: stessa ricerca, stesse scelte rapide.

## 18. Statistiche d'uso (giro 4)
- [ ] Usa Hermes normalmente per qualche giorno. Poi Settings → **Usage statistics** → **Export…** e mandami il file: dentro ci sono tempi di avvio, durata di lavori e attese, errori, senza nomi di file, link o titoli.
- [ ] Se non vuoi che registri, spegni l'interruttore; **Clear** cancella tutto.

## 19. Image Converter (giro 4)
- [ ] Trascina qualche immagine (anche una foto HEIC del telefono) e convertila in JPG, WebP, AVIF, ICO: i file finiscono nella cartella scelta, l'originale non viene mai sovrascritto.
- [ ] Un PNG con trasparenza in JPG: lo sfondo diventa bianco.
- [ ] **SVG** su un logo: prova Full colour / Black and white e i tre livelli di dettaglio; apri l'SVG in Illustrator o nel browser.

## 20. Document Converter (giro 4)
- [ ] Trascina un Word e scegli **PDF**: la prima volta chiede di scaricare LibreOffice (375 MB); dopo, il PDF ha lo stesso impaginato del Word.
- [ ] Un PDF in **Word (DOCX)** (modificabile), in **Images, one per page** e in **Plain text**.
- [ ] Un file Markdown in Word, HTML, EPUB e PDF; un .tex in PDF (la prima volta LaTeX scarica i suoi pacchetti: qualche minuto).
- [ ] Binaries: LibreOffice, Pandoc, Tectonic, Poppler si possono rimuovere; **Check models** mostra **Delete** su ogni modello e sul runtime AI.

## 21. Pattern Generator (giro 5)
- [ ] Muovi i cursori: l'anteprima cambia subito. Prova i formati 16:9 e 9:16, **Random**, salva un preset e riaprilo.
- [ ] **Export PNG** a 4K con e senza sfondo (senza = trasparente, ottimo come overlay in Premiere) ed **Export SVG** (aprilo in Illustrator).

## 22. Pixel Art (giro 5)
- [ ] Trascina una foto: l'anteprima è subito in pixel art. Muovi **Pixel size**, prova le palette (Game Boy, Pico-8…), **From the image** con pochi colori e il **dithering**.
- [ ] Importa una palette da un link di Lospec (es. lospec.com/palette-list/sweetie-16) o incolla dei codici colore.
- [ ] Più immagini, **Export** in Small, Original e 4K: i pixel restano nitidi; con **Grid** c'è la griglia.

## Pulizia (giro 6)
- [ ] Gallery: incolla un link, cambia tool mentre legge, torna: l'elenco compare senza rileggere.
- [ ] Video Downloader: una playlist con qualche video eliminato si aggiunge alla coda (avviso "N unavailable videos skipped").

## Limiti noti (da sapere mentre provi)
- Serve il **Visual C++ Redistributable 2015-2022** (c'è su quasi tutti i PC; se Hermes non parte su un altro PC, è questo).
- Il primo avvio estrae ~450 MB di strumenti: qualche secondo.
- MP4 Converted usa NVENC: funziona solo con GPU NVIDIA.
- Upscale video: tutti i frame del video stanno su disco durante l'elaborazione (alcuni GB al minuto).
- Gallery: file con lo stesso nome dentro la stessa galleria vengono selezionati/esclusi insieme.
- Audible: togliere il DRM può violare i termini di Audible e la legge sul diritto d'autore (anche per uso personale). Usalo per i tuoi backup.
- Thumbnail Tester: la data dei video degli altri è inventata (la ricerca non la fornisce); le foto profilo degli altri canali arrivano una alla volta.
- Document Converter: PDF → Word è approssimativo sui PDF complessi (colonne, tabelle); LibreOffice occupa 1,5 GB.
- Runtime AI: ~4.5 GB su disco in `hermes-data\python` + i modelli in `hermes-data\models`.

## Test automatici (li lancio io; da sistemare quando vuoi)
- `scripts/t3-test.mjs`: tutto ok tranne il controllo sul testo d'errore di ffmpeg.
- `scripts/t4-test.mjs`: si ferma al 2° download per un bug del test (non dell'app); MP4/1080p/Eagle/playlist non ancora coperti in automatico.
- `scripts/t5-7-test.mjs` con `ONLY=rembg,upscale`: **tutto passato** (download modelli con conferma, PNG trasparente, slider, sfondo pieno + crop, compare con tempi, Keep, upscale immagine 4×, upscale video 2× con audio, pulizia temp).
