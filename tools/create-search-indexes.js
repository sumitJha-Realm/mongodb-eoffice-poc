// Creates MongoDB Search (mongot) indexes on the Enterprise replica set:
//  - "fts"  : full-text over subject/body + OCR text of scanned attachments
//  - "vec"  : 1024-dim cosine vector index (Voyage embeddings), scalar-quantized
// Usage: node create-search-indexes.js
import { client, corr, EMBED_DIM } from "./lib.js";

async function main() {
  await client.connect();
  const col = corr();

  const existing = (await col.listSearchIndexes().toArray()).map(i => i.name);

  if (!existing.includes("fts")) {
    await col.createSearchIndex({
      name: "fts",
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            subject: { type: "string" },
            body: { type: "string" },
            directorate: { type: "token" },
            status: { type: "token" },
            scenario: { type: "token" },
            attachments: {
              type: "document",
              fields: { ocr: { type: "document", fields: { text: { type: "string" } } } },
            },
          },
        },
      },
    });
    console.log("created search index: fts");
  }

  if (!existing.includes("vec")) {
    await col.createSearchIndex({
      name: "vec",
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBED_DIM, similarity: "cosine", quantization: "scalar" },
          { type: "filter", path: "directorate" },
          { type: "filter", path: "status" },
          { type: "filter", path: "classification" },
        ],
      },
    });
    console.log("created vector index: vec");
  }

  // poll until READY
  for (;;) {
    const idx = await col.listSearchIndexes().toArray();
    const line = idx.map(i => `${i.name}:${i.status}`).join("  ");
    console.log(line);
    if (idx.length >= 2 && idx.every(i => i.status === "READY")) break;
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log("All search indexes READY.");
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
