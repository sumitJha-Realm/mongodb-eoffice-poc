// RAG: question -> Voyage query embedding -> $vectorSearch top-k -> grounded
// answer with fileNo citations via the LLM gateway (gpt-5.5).
// Usage: node ask.js "what is the process when a vendor delivers late?"
import { client, corr, voyageEmbed, llm } from "./lib.js";

const q = process.argv.slice(2).join(" ") || "what happens when a vendor delivers stores late?";

async function main() {
  await client.connect();
  const { vectors: [qv] } = await voyageEmbed([q], "query");
  const t = performance.now();
  const hits = await corr().aggregate([
    { $vectorSearch: { index: "vec", path: "embedding", queryVector: qv, numCandidates: 300, limit: 5 } },
    { $project: { fileNo: 1, subject: 1, body: 1, directorate: 1, "attachments.ocr.text": 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
  const ms = performance.now() - t;

  console.log(`Retrieved ${hits.length} docs in ${ms.toFixed(1)} ms:\n`);
  hits.forEach((h, i) => console.log(` [${i + 1}] ${h.fileNo} — ${h.subject} (score ${h.score.toFixed(3)})`));

  const context = hits.map((h, i) =>
    `[${i + 1}] fileNo=${h.fileNo} dir=${h.directorate}\nSubject: ${h.subject}\nBody: ${h.body}${h.attachments?.[0]?.ocr?.text ? "\nScanned attachment (OCR): " + h.attachments[0].ocr.text : ""}`
  ).join("\n\n");

  const prompt = `You are the eOffice assistant for the Indian Air Force. Answer the question using ONLY the retrieved files below. Cite file numbers like [1], [2]. If the answer is not in the files, say so.\n\nRETRIEVED FILES:\n${context}\n\nQUESTION: ${q}\n\nANSWER:`;
  console.log("\n--- LLM answer (grounded, with citations) ---\n");
  console.log(await llm(prompt));
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
