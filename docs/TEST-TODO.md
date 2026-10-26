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

## Limiti noti (da sapere mentre provi)
- Serve il **Visual C++ Redistributable 2015-2022** (c'è su quasi tutti i PC; se Hermes non parte su un altro PC, è questo).
- Il primo avvio estrae ~450 MB di strumenti: qualche secondo.
- MP4 Converted usa NVENC: funziona solo con GPU NVIDIA.
- Upscale video: tutti i frame del video stanno su disco durante l'elaborazione (alcuni GB al minuto).
- Gallery: file con lo stesso nome dentro la stessa galleria vengono selezionati/esclusi insieme.

## Test automatici (li lancio io; da sistemare quando vuoi)
- `scripts/t3-test.mjs`: tutto ok tranne il controllo sul testo d'errore di ffmpeg.
- `scripts/t4-test.mjs`: si ferma al 2° download per un bug del test (non dell'app); MP4/1080p/Eagle/playlist non ancora coperti in automatico.
- `scripts/t5-7-test.mjs` con `ONLY=rembg,upscale`: **tutto passato** (download modelli con conferma, PNG trasparente, slider, sfondo pieno + crop, compare con tempi, Keep, upscale immagine 4×, upscale video 2× con audio, pulizia temp).
- `scripts/t5-7-test.mjs` sezione gallery: anteprima, filtri (estensioni, risoluzione), selezione/deselezione **ok**; il download non è stato verificato fino in fondo perché Wikimedia ha limitato il mio IP (429) dopo molti test. Hermes ha reagito correttamente con la pausa da 5 e poi 10 minuti. Da riprovare con una tua galleria.
