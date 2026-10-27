// Hermes-styled tooltips for every element with a `title` (native ones are drawn by Windows). The title
// moves to `data-tip` on hover so the native tooltip never shows; code may keep setting `title` freely.
import { h } from "./core";

const tip = document.body.appendChild(h(`<div class="tip" role="tooltip" hidden></div>`));
let target: HTMLElement | null = null;
let timer = 0;

function hide() {
  clearTimeout(timer);
  target = null;
  tip.hidden = true;
}

function show(el: HTMLElement) {
  if (!el.isConnected || !el.dataset.tip) return;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const below = r.bottom + 8 + t.height < innerHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${below ? r.bottom + 8 : r.top - t.height - 8}px`;
}

document.addEventListener("mouseover", (e) => {
  const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[title], [data-tip]") : null;
  if (el?.title) {
    el.dataset.tip = el.title;
    el.removeAttribute("title");
  }
  if (el === target) return;
  hide();
  if (!el?.dataset.tip) return;
  target = el;
  timer = window.setTimeout(() => show(el), 350);
});
document.addEventListener("mouseout", (e) => {
  if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) hide();
});
for (const ev of ["mousedown", "keydown", "wheel", "blur"]) addEventListener(ev, hide, true);
