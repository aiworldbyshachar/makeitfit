// Building PDFs with pdf-lib: photos (JPEGs) into one PDF, one image per page.
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const A4_LONG = 841.89; // points

/** Bytes a PDF adds around its images (catalog, pages, xref, per-page objects) - measured, rounded up. */
export function imagePdfOverhead(pages) {
  return 900 + 360 * pages;
}

/** Page size in points for a photo: the long side as long as A4's, same proportions. */
export function photoPageSize(width, height) {
  const scale = A4_LONG / Math.max(width, height);
  return { width: width * scale, height: height * scale };
}

/** Sets neutral document info (no names, no dates from the original). */
export function stampInfo(doc) {
  doc.setProducer('MakeItFit');
  doc.setCreator('MakeItFit');
}

/**
 * pages: [{ jpeg: Uint8Array, width, height, pageWidth?, pageHeight? }]
 * pageWidth/pageHeight (points) keep a rendered page's original size; otherwise photoPageSize is used.
 */
export async function buildImagePdf(pages) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  stampInfo(doc);
  for (const p of pages) {
    const img = await doc.embedJpg(p.jpeg);
    const size = p.pageWidth ? { width: p.pageWidth, height: p.pageHeight } : photoPageSize(p.width, p.height);
    const page = doc.addPage([size.width, size.height]);
    page.drawImage(img, { x: 0, y: 0, width: size.width, height: size.height });
  }
  return doc.save({ useObjectStreams: true });
}

/** Copies a run of pages [start, end) of a loaded pdf-lib document into a new PDF. */
export async function copyPageRun(srcDoc, start, end) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  stampInfo(doc);
  const indices = Array.from({ length: end - start }, (_, i) => start + i);
  const pages = await doc.copyPages(srcDoc, indices);
  for (const p of pages) doc.addPage(p);
  return doc.save({ useObjectStreams: true });
}
