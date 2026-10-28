// Pure: which engine turns a file of one type into another (Document Converter). Imported by tests
// under plain node. null = not possible.

export type Engine = "pandoc" | "tectonic" | "poppler" | "office";

export const TARGETS: Record<string, string> = {
  pdf: "PDF", docx: "Word (DOCX)", odt: "OpenDocument text (ODT)", rtf: "Rich Text (RTF)", md: "Markdown",
  html: "Web page (HTML)", epub: "E-book (EPUB)", tex: "LaTeX", txt: "Plain text", png: "Images, one per page (PNG)", jpg: "Images, one per page (JPG)",
};
const TEXT = ["md", "markdown", "html", "htm", "tex", "epub", "txt", "rst", "org"];
const WORD = ["docx", "odt", "rtf", "doc"];
const OTHER_OFFICE = ["pptx", "ppt", "odp", "xlsx", "xls", "ods"];
export const INPUTS = [...TEXT, ...WORD, ...OTHER_OFFICE, "pdf"];

const same = (ext: string, target: string) => ext === target || (ext === "htm" && target === "html") || (ext === "markdown" && target === "md");

/** Engines that convert `ext` (input extension, lower case) to `target`, in the order they run. */
export function route(ext: string, target: string): Engine[] | null {
  if (same(ext, target)) return null;
  if (ext === "pdf") return ["png", "jpg", "txt"].includes(target) ? ["poppler"] : ["docx", "odt"].includes(target) ? ["office"] : null;
  if (OTHER_OFFICE.includes(ext)) return target === "pdf" ? ["office"] : null;
  if (WORD.includes(ext)) {
    if (target === "pdf" || ["docx", "odt", "rtf"].includes(target)) return ["office"]; // keeps the layout
    if (ext === "doc") return null; // Pandoc can't read .doc: convert it to DOCX first
    return ["md", "html", "epub", "tex", "txt"].includes(target) ? ["pandoc"] : null;
  }
  if (TEXT.includes(ext)) {
    if (target === "pdf") return ext === "tex" ? ["tectonic"] : ["pandoc", "tectonic"];
    return ["docx", "odt", "rtf", "md", "html", "epub", "tex", "txt"].includes(target) ? ["pandoc"] : null;
  }
  return null;
}

/** Why a conversion isn't offered, for the hint. */
export function whyNot(ext: string, target: string): string {
  if (same(ext, target)) return "already that format";
  if (ext === "doc") return "convert old .doc files to DOCX first";
  if (ext === "pdf") return "PDFs become Word, ODT, text or images";
  if (OTHER_OFFICE.includes(ext)) return "slides and spreadsheets become PDF";
  if (["png", "jpg"].includes(target)) return "page images come from PDFs";
  return "not supported";
}
