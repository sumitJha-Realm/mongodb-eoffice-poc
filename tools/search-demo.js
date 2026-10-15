// Side-by-side demo: keyword ($text) vs full-text ($search fuzzy+highlights)
// vs AI ($vectorSearch) vs hybrid ($rankFusion) over the same 1M docs.
// Usage: node search-demo.js "airman wants time off because his mother is unwell"
import { client, corr, voyageEmbed } from "./lib.js";

const q = process.argv.slice(2).join(" ") || "airman wants time off because his mother is unwell";
const proj = { fileNo: 1, subject: 1, directorate: 1, "attachments.type": 1 };
const show = (label, ms, rows) => {
  console.log(`\n=== ${label}  (${ms.toFixed(1)} ms, ${rows.length} hits) ===`);
  rows.forEach((r, i) => console.log(` ${i + 1}. [${r.directorate}] ${r.subject}${r.attachments ? "  📎" + r.attachments.map(a => a.type).join(",") : ""}${r.score != null ? `  score=${r.score.toFixed(3)}` : ""}`));
};
const timed = async (fn) => { const t = performance.now(); const rows = await fn(); return { ms: performance.now() - t, rows }; };

async function main() {
  await client.connect();
  const col = corr();
  console.log(`Query: "${q}"`);

  { // 1. legacy keyword
    const { ms, rows } = await timed(() => col.find({ $text: { $search: q } }, { projection: { ...proj, score: { $meta: "textScore" } } })
      .sort({ score: { $meta: "textScore" } }).limit(5).toArray());
    show("KEYWORD  $text (legacy)", ms, rows);
  }
  { // 2. full-text with fuzzy + OCR content
    const { ms, rows } = await timed(() => col.aggregate([
      { $search: { index: "fts", text: { query: q, path: ["subject", "body", "attachments.ocr.text"], fuzzy: { maxEdits: 1 } } } },
      { $limit: 5 },
      { $project: { ...proj, score: { $meta: "searchScore" } } },
    ]).toArray());
    show("FULL-TEXT  $search (fuzzy, incl. OCR of scans)", ms, rows);
  }
  const { vectors: [qv] } = await voyageEmbed([q], "query");
  { // 3. semantic
    const { ms, rows } = await timed(() => col.aggregate([
      { $vectorSearch: { index: "vec", path: "embedding", queryVector: qv, numCandidates: 200, limit: 5 } },
      { $project: { ...proj, score: { $meta: "vectorSearchScore" } } },
    ]).toArray());
    show("AI  $vectorSearch (voyage-4-large)", ms, rows);
  }
  { // 4. hybrid rank fusion
    const { ms, rows } = await timed(() => col.aggregate([
      {
        $rankFusion: {
          input: {
            pipelines: {
              semantic: [{ $vectorSearch: { index: "vec", path: "embedding", queryVector: qv, numCandidates: 200, limit: 10 } }],
              lexical: [{ $search: { index: "fts", text: { query: q, path: ["subject", "body", "attachments.ocr.text"] } } }, { $limit: 10 }],
            },
          },
        },
      },
      { $limit: 5 },
      { $project: proj },
    ]).toArray());
    show("HYBRID  $rankFusion (lexical + semantic)", ms, rows);
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
