// Resumable batch embedding of the whole corpus with Voyage (voyage-4-large).
// Embeds subject + body + OCR text of scanned attachments, so vector search
// finds files by the content *inside* the scan.
// Usage: node embed.js [--limit N]   (re-run anytime; skips docs that already have embeddings)
import { client, corr, voyageEmbed, VOYAGE_MODEL, EMBED_DIM } from "./lib.js";

const BATCH = 128;          // texts per Voyage call
const PARALLEL = 6;         // concurrent Voyage calls
const LIMIT = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity;

const textOf = (d) => {
  const ocr = (d.attachments || []).map(a => a.ocr?.text).filter(Boolean).join("\n");
  return `${d.subject}\n${d.body}${ocr ? "\nSCANNED DOCUMENT CONTENT:\n" + ocr : ""}`.slice(0, 4000);
};

async function main() {
  await client.connect();
  const col = corr();
  const pending = await col.countDocuments({ embedding: { $exists: false } });
  console.log(`Model=${VOYAGE_MODEL} dim=${EMBED_DIM}. Docs without embedding: ${pending.toLocaleString()}`);

  let done = 0, tokens = 0;
  const t0 = Date.now();
  while (done < LIMIT) {
    // grab PARALLEL*BATCH unembedded docs
    const docs = await col.find({ embedding: { $exists: false } },
      { projection: { subject: 1, body: 1, "attachments.ocr.text": 1 } })
      .limit(BATCH * PARALLEL).toArray();
    if (!docs.length) break;

    const chunks = [];
    for (let i = 0; i < docs.length; i += BATCH) chunks.push(docs.slice(i, i + BATCH));

    await Promise.all(chunks.map(async (chunk) => {
      const { vectors, tokens: tk } = await voyageEmbed(chunk.map(textOf), "document");
      tokens += tk;
      await col.bulkWrite(chunk.map((d, i) => ({
        updateOne: { filter: { _id: d._id }, update: { $set: { embedding: vectors[i], embeddingModel: VOYAGE_MODEL } } },
      })), { ordered: false });
    }));

    done += docs.length;
    const rate = done / ((Date.now() - t0) / 1000);
    const eta = ((pending - done) / rate / 60).toFixed(0);
    console.log(`  embedded ${done.toLocaleString()}  (${rate.toFixed(0)} docs/s, ~${tokens.toLocaleString()} tokens, ETA ${eta} min)`);
  }
  console.log(`Finished. Embedded ${done.toLocaleString()} docs, ${tokens.toLocaleString()} tokens.`);
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
