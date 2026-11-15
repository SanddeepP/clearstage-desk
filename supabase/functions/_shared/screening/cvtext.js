// CV file → text, with proven libraries only (CTO Tech Decisions §1.1): unpdf for PDF, mammoth for DOCX,
// fflate for ZIP (in the uploader). No OCR: a scanned or image-only CV has no text layer, gets the label
// "needs a human look", no AI call and no rejection.
// The libraries are passed in, so the same code runs in the browser (vendored builds), Node tests and Deno.

export const MIN_TEXT_CHARS = 200;        // less than this after extraction = treat as unreadable
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED = /\.(pdf|docx)$/i;

/**
 * @param bytes  Uint8Array of the file
 * @param name   file name (decides the parser)
 * @param libs   { unpdf: { getDocumentProxy, extractText }, mammoth: { extractRawText } }
 * @returns { readable, text, reason? }
 */
export async function cvText(bytes, name, libs) {
  if (!ACCEPTED.test(name)) return { readable: false, text: "", reason: "Only PDF and DOCX CVs can be read" };
  if (bytes.byteLength > MAX_FILE_BYTES) return { readable: false, text: "", reason: "File is larger than 5 MB" };
  let text = "";
  try {
    if (/\.pdf$/i.test(name)) {
      const pdf = await libs.unpdf.getDocumentProxy(new Uint8Array(bytes));
      const pages = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let line = "", out = [];
        for (const it of content.items) { line += it.str; if (it.hasEOL) { out.push(line); line = ""; } }
        if (line) out.push(line);
        pages.push(out.join("\n"));
      }
      text = pages.join("\n");
    } else {
      const r = await libs.mammoth.extractRawText(typeof Buffer !== "undefined" && libs.node ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      text = r.value;
    }
  } catch (e) {
    return { readable: false, text: "", reason: "The file couldn't be opened (damaged or password-protected)" };
  }
  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) return { readable: false, text, reason: "No readable text: looks scanned or image-only" };
  return { readable: true, text };
}
