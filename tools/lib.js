import dotenv from "dotenv";
import { MongoClient } from "mongodb";

// .env lives in the repo root, one level above tools/
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

export const URI = process.env.MONGO_URL ||
  "mongodb://admin:eoffice123@localhost:27101,localhost:27102,localhost:27103/?replicaSet=eoffice-rs&authSource=admin";
export const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
export const db = () => client.db("poc");
export const corr = () => db().collection("correspondence");

// Atlas-issued model API keys (prefix "al-") authenticate against ai.mongodb.com;
// keys created directly at voyageai.com use api.voyageai.com.
const VOYAGE_URL = process.env.VOYAGE_URL ||
  ((process.env.VOYAGE_API_KEY || "").startsWith("al-")
    ? "https://ai.mongodb.com/v1/embeddings"
    : "https://api.voyageai.com/v1/embeddings");
export const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-4-large";
export const EMBED_DIM = Number(process.env.EMBED_DIM || 1024);

// Embed a batch of texts. inputType: "document" (corpus) | "query" (search time).
export async function voyageEmbed(texts, inputType = "document", retries = 5) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: texts, input_type: inputType, output_dimension: EMBED_DIM }),
    });
    if (r.ok) {
      const j = await r.json();
      return { vectors: j.data.map(d => d.embedding), tokens: j.usage?.total_tokens ?? 0 };
    }
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt <= retries) {
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      console.log(`  voyage ${r.status}, retry ${attempt}/${retries} in ${wait}ms`);
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw new Error(`Voyage API ${r.status}: ${body.slice(0, 300)}`);
  }
}

// OpenAI Responses-compatible gateway call; returns plain text.
export async function llm(input) {
  const r = await fetch(process.env.AI_GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
    body: JSON.stringify({ model: process.env.AI_GATEWAY_MODEL || "gpt-5.5", input }),
  });
  if (!r.ok) throw new Error(`LLM gateway ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (typeof j.output_text === "string") return j.output_text;
  // Responses API: output[] -> message -> content[] -> output_text
  const parts = (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text);
  return parts.join("\n") || JSON.stringify(j).slice(0, 500);
}

export const embedText = (doc) => `${doc.subject}\n${doc.body}`;
