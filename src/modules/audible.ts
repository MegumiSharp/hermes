// Audible module (SPEC 10). Backend: src-tauri/src/audible.rs (audible-cli + ffmpeg → M4B).
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { binariesReady } from "../binaries";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, watchJobs } from "../queue";
import { folderField, liveStatus } from "./common";

const COUNTRIES: Record<string, string> = {
  it: "Italy", us: "United States", uk: "United Kingdom", de: "Germany", fr: "France", es: "Spain",
  ca: "Canada", au: "Australia", in: "India", jp: "Japan", br: "Brazil",
};

/** Fields we use from `audible library export -f json` (names vary a little between versions). */
type Book = Record<string, any>;
const str = (v: unknown) => (Array.isArray(v) ? v.map((x) => x?.name ?? x).join(", ") : typeof v === "string" ? v : "");
const bookTitle = (b: Book) => [str(b.title), str(b.subtitle)].filter(Boolean).join(": ") || b.asin;
const bookAuthor = (b: Book) => str(b.authors) || "Unknown author";
const minutes = (b: Book) => Number(b.runtime_length_min) || 0;
const hm = (m: number) => (m ? `${Math.floor(m / 60)} h ${m % 60} min` : "");

export function renderAudible(view: HTMLElement) {
  const { state, save } = memory("audible", {
    folder: "", country: "it", search: "", selected: [] as string[], pendingUrl: "", loginStarted: false,
  });

  clearers.set("audible", () => { Object.assign(state, { search: "", selected: [] }); save(); });

  const page = h(`<div class="page audible">
    <div class="head"><div><h3>Audible</h3><div class="sub">Your purchased audiobooks as M4B files with chapters and cover</div></div>
      <div class="right"><span id="a-actions" style="display: contents"></span></div></div>
    <div id="a-body"></div>
  </div>`);
  const body = page.querySelector<HTMLElement>("#a-body")!;
  const actions = page.querySelector<HTMLElement>("#a-actions")!;

  async function render() {
    await binariesReady;
    const status = await invoke<{ loggedIn: boolean; country?: string }>("audible_status");
    actions.replaceChildren();
    if (!status.loggedIn) return renderLogin();
    const refresh = h(`<button class="btn sm" id="a-refresh">${icon("refresh")}Refresh library</button>`);
    const out = h(`<button class="btn sm ghost" id="a-logout">Sign out</button>`);
    refresh.onclick = () => renderLibrary(true);
    out.onclick = async () => { await invoke("audible_logout"); render(); };
    actions.append(refresh, out);
    renderLibrary(false);
  }

  // ----- sign in -----
  function renderLogin() {
    body.replaceChildren(h(`<div class="card a-login">
      <div class="row"><div><div class="v"><b>Connect your Audible account</b></div>
        <div class="sub">You sign in on Amazon's own page in your browser. Hermes only keeps the device token in hermes-data\\audible, never your password.</div></div></div>
      <div class="row"><div><span class="field-label">Marketplace</span><select class="select" id="a-country">
        ${Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <button class="btn primary" id="a-start">${icon("link")}Sign in with Amazon</button></div>
      <div class="row a-step2" ${state.loginStarted ? "" : "hidden"}><div>
        <ol class="steps"><li>Sign in in the browser tab that opened (you may be asked twice and for a captcha).</li>
          <li>You will land on a <b>"Page not found"</b> page: that is expected.</li>
          <li>Copy the full address from the browser's address bar and paste it here.</li></ol>
        <label class="field">${icon("link")}<input id="a-url" placeholder="https://www.amazon…/ap/maplanding?…" autocomplete="off" spellcheck="false"></label></div>
        <button class="btn primary" id="a-finish">Connect</button></div>
      <div class="a-error ck-result bad" id="a-error"></div>
    </div>`));
    const country = body.querySelector<HTMLSelectElement>("#a-country")!;
    const url = body.querySelector<HTMLInputElement>("#a-url")!;
    const errBox = body.querySelector("#a-error")!;
    country.value = state.country;
    country.onchange = () => { state.country = country.value; save(); };
    url.value = state.pendingUrl;
    url.oninput = () => { state.pendingUrl = url.value; save(true); };
    body.querySelector<HTMLButtonElement>("#a-start")!.onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      errBox.textContent = "";
      const wait = liveStatus("audible-signin");
      b.after(wait.el);
      wait.set("Preparing Amazon's sign-in page");
      try {
        const link = await invoke<string>("audible_login_start", { country: country.value });
        wait.done();
        await openUrl(link);
        state.loginStarted = true;
        save();
        body.querySelector<HTMLElement>(".a-step2")!.hidden = false;
        url.focus();
      } catch (er) {
        wait.done();
        errBox.textContent = String(er);
      }
      b.disabled = false;
    };
    body.querySelector<HTMLButtonElement>("#a-finish")!.onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (!url.value.includes("amazon")) { errBox.textContent = "Paste the full address of the \"Page not found\" page."; return; }
      b.disabled = true;
      errBox.textContent = "";
      const wait = liveStatus("audible-connect");
      b.after(wait.el);
      wait.set("Connecting your Audible account");
      try {
        await invoke("audible_login_finish", { url: url.value });
        wait.done();
        Object.assign(state, { pendingUrl: "", loginStarted: false });
        save();
        banner({ id: "audible", icon: "check", text: "Audible account connected." });
        render();
      } catch (er) {
        // the sign-in session ended with the attempt: the user restarts from step 1
        wait.done();
        errBox.textContent = `${er}. Click "Sign in with Amazon" to try again.`;
        state.loginStarted = false;
        save();
      }
      b.disabled = false;
    };
  }

  // ----- library -----
  async function renderLibrary(refresh: boolean) {
    const wait = liveStatus("audible-library");
    body.replaceChildren(wait.el);
    wait.set(refresh ? "Downloading your library from Audible (large libraries take a minute)" : "Loading your library");
    let books: Book[];
    try {
      const data = await invoke<Book[] | { items: Book[] }>("audible_library", { refresh });
      wait.done();
      books = (Array.isArray(data) ? data : data.items ?? []).filter((b) => b.asin);
    } catch (e) {
      body.replaceChildren(h(`<div class="g-error">${icon("alert")}<span></span></div>`));
      body.querySelector(".g-error span")!.textContent = `Could not read the library: ${e}`;
      return;
    }
    const lib = h(`<div class="a-lib">
      <div class="a-bar"><label class="field">${icon("search")}<input id="a-search" placeholder="Search title, author, narrator, series" autocomplete="off"></label>
        <span class="sub" id="a-count"></span>
        <button class="btn sm ghost" id="a-all">Select shown</button><button class="btn sm ghost" id="a-none">Clear</button></div>
      <div class="a-list" id="a-list"></div>
    </div>`);
    const opts = h(`<div class="opts one"></div>`);
    opts.append(folderField(state, save, "a-folder"));
    const row = h(`<div class="row2"><span class="sub">For personal backups of books you own.</span><button class="btn primary" id="a-go" disabled>${icon("download")}Download</button></div>`);
    body.replaceChildren(lib, opts, row);

    const search = lib.querySelector<HTMLInputElement>("#a-search")!;
    const list = lib.querySelector<HTMLElement>("#a-list")!;
    const go = row.querySelector<HTMLButtonElement>("#a-go")!;
    let done = new Set<string>();
    search.value = state.search;

    const shown = () => {
      const q = state.search.trim().toLowerCase();
      return books.filter((b) => !q || [bookTitle(b), bookAuthor(b), str(b.narrators), str(b.series_title)].join(" ").toLowerCase().includes(q));
    };
    function draw() {
      const s = shown();
      lib.querySelector("#a-count")!.textContent = `${s.length} of ${books.length} books · ${state.selected.length} selected`;
      list.replaceChildren(...s.map((b) => {
        const el = h(`<label class="a-book">
          <input type="checkbox" data-asin="${b.asin}" ${state.selected.includes(b.asin) ? "checked" : ""}>
          <span class="a-cover">${b.cover_url ? `<img alt="" loading="lazy">` : icon("music")}</span>
          <span class="a-meta"><b></b><span class="sub a-by"></span><span class="sub mono a-len"></span></span>
          ${done.has(b.asin) ? `<span class="chip">Downloaded</span>` : ""}</label>`);
        if (b.cover_url) el.querySelector("img")!.src = b.cover_url;
        el.querySelector("b")!.textContent = bookTitle(b);
        el.querySelector(".a-by")!.textContent = [bookAuthor(b), str(b.narrators) && `read by ${str(b.narrators)}`].filter(Boolean).join(" · ");
        el.querySelector(".a-len")!.textContent = [hm(minutes(b)), str(b.series_title) && `${str(b.series_title)} ${b.series_sequence ?? ""}`.trim()].filter(Boolean).join(" · ");
        return el;
      }));
      go.disabled = !state.selected.length;
      go.lastChild!.textContent = state.selected.length > 1 ? `Download ${state.selected.length} books` : "Download";
    }
    search.oninput = () => { state.search = search.value; save(true); draw(); };
    list.onchange = (e) => {
      const c = e.target as HTMLInputElement;
      state.selected = c.checked ? [...new Set([...state.selected, c.dataset.asin!])] : state.selected.filter((a) => a !== c.dataset.asin);
      save();
      draw();
    };
    lib.querySelector<HTMLButtonElement>("#a-all")!.onclick = () => { state.selected = [...new Set([...state.selected, ...shown().map((b) => b.asin)])]; save(); draw(); };
    lib.querySelector<HTMLButtonElement>("#a-none")!.onclick = () => { state.selected = []; save(); draw(); };
    watchJobs((jobs) => {
      done = new Set(jobs.filter((j) => j.module === "audible" && j.state === "done").map((j) => j.source));
      if (list.isConnected) draw();
    }, () => list.isConnected || !list.parentElement);

    go.onclick = async () => {
      const picked = books.filter((b) => state.selected.includes(b.asin));
      await addJobs(picked.map((b) => ({
        module: "audible", title: bookTitle(b), pill: "M4B", source: b.asin,
        steps: [{ type: "audible", asin: b.asin, title: bookTitle(b), author: bookAuthor(b), duration: minutes(b) * 60, folder: state.folder }],
      })));
      state.selected = [];
      save();
      draw();
    };
    draw();
  }

  render();
  mountQueue(page, "audible");
  view.append(page);
}
