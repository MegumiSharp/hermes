// Unit check for src/modules/spotify-match.ts on real YouTube data (no app, no network).
// Usage: node scripts/spotify-match-test.mjs
import { distrust, parseMeta } from "../src/modules/spotify-match.ts";
import { check } from "./smoke.mjs";

const meta = parseMeta([
  "5r6_VxEihAA\tosu! Jamie Paige (w/ OK GLASS) - BIRDBRAIN\tNA\tYinchiko\t262",
  "AjMRCfbdYM8\t[] BIRDBRAIN-Jamie Paige / JamieP (w/ OK Glass) feat. Kasane Teto\tNA\tVinCent\t256",
  "dBLzh47wdrU\tBIRDBRAIN (feat. OK Glass)\tJamie Paige, OK Glass\tJamie Paige / JamieP\t257",
  "HzdD8kbDzZA\tTake on Me\ta-ha\ta-ha\t225",
  "QAo_Ycocl1E\tAfrica\tToto\tTOTO\t296",
  "FGBhQbmPwH8\tDaft Punk - One More Time (Official Video)\tNA\tDaft Punk\t321",
  "BSTsnWoslP4\tBohemian Rhapsody\tQueen\tQueen Official\t354",
  "btPJPFnesV4\tSurvivor - Eye Of The Tiger (Official HD Video)\tNA\tSurvivor Band\t245",
  "GPLxqUvexVo\tBIRDBRAIN (Jamie Paige) / vally.exeCOVER\tNA\tvally.exe\t256",
  "not a line",
]);
check(meta.size === 9, "parses yt-dlp lines, skips junk");
const birdbrain = { name: "BIRDBRAIN", artist: "Jamie Paige", artists: ["Jamie Paige", "OK Glass"], album_name: "BIRDBRAIN", duration: 256 };
check(distrust(birdbrain, meta.get("5r6_VxEihAA")) !== null, `osu! upload rejected (${distrust(birdbrain, meta.get("5r6_VxEihAA"))})`);
check(distrust(birdbrain, meta.get("AjMRCfbdYM8")) !== null, `fan upload rejected (${distrust(birdbrain, meta.get("AjMRCfbdYM8"))})`);
check(distrust(birdbrain, meta.get("GPLxqUvexVo")) !== null, `cover rejected (${distrust(birdbrain, meta.get("GPLxqUvexVo"))})`);
check(distrust(birdbrain, meta.get("dBLzh47wdrU")) === null, "official YouTube Music track trusted");
const ok = [
  [{ name: "Take on Me", artist: "a-ha", artists: ["a-ha"], album_name: "Hunting High and Low", duration: 225 }, "HzdD8kbDzZA"],
  [{ name: "Africa", artist: "TOTO", artists: ["TOTO"], album_name: "Toto IV", duration: 295 }, "QAo_Ycocl1E"],
  [{ name: "One More Time", artist: "Daft Punk", artists: ["Daft Punk"], album_name: "Discovery", duration: 320 }, "FGBhQbmPwH8"],
  [{ name: "Bohemian Rhapsody", artist: "Queen", artists: ["Queen"], album_name: "A Night At The Opera", duration: 355 }, "BSTsnWoslP4"],
  [{ name: "Eye of the Tiger", artist: "Survivor", artists: ["Survivor"], album_name: "Rocky IV", duration: 245 }, "btPJPFnesV4"],
];
for (const [t, id] of ok) check(distrust(t, meta.get(id)) === null, `${t.artist} - ${t.name}: official source trusted (${distrust(t, meta.get(id))})`);
const live = { name: "Bohemian Rhapsody - Live Aid", artist: "Queen", artists: ["Queen"], album_name: "Live", duration: 354 };
check(distrust(live, { ...meta.get("BSTsnWoslP4"), title: "Bohemian Rhapsody (Live Aid)" }) === null, "a live upload is fine when the Spotify track is live too");
console.log("SPOTIFY MATCH TEST PASSED");
