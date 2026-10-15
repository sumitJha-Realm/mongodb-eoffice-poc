// Continuous w:majority write probe used by scripts/failover-demo.sh.
// Measures the write-stall window across a primary election and verifies
// that every acknowledged write survived the failover (RPO = 0).
import { MongoClient } from "mongodb";
import { URI } from "./lib.js";

const DURATION_MS = Number(process.env.PROBE_MS || 45000);

const client = new MongoClient(URI, { retryWrites: true, serverSelectionTimeoutMS: 5000 });
await client.connect();
const col = client.db("poc").collection("failover_probe");
await col.drop().catch(() => {});

let acked = 0;
let stallStart = 0;
let maxStallMs = 0;
let failed = 0;
let maxWriteLatencyMs = 0;
let maxWriteLatencyAt = null;
const t0 = Date.now();

while (Date.now() - t0 < DURATION_MS) {
  const s = Date.now();
  try {
    await col.insertOne({ i: acked, ts: new Date() }, { writeConcern: { w: "majority" } });
    acked++;
    const lat = Date.now() - s;
    if (lat > maxWriteLatencyMs) {
      maxWriteLatencyMs = lat;
      maxWriteLatencyAt = new Date(s).toISOString();
    }
    if (stallStart) {
      maxStallMs = Math.max(maxStallMs, Date.now() - stallStart);
      stallStart = 0;
    }
  } catch {
    failed++;
    if (!stallStart) stallStart = s;
  }
}

const found = await col.countDocuments();
console.log(JSON.stringify({
  ackedWrites: acked,
  docsFoundAfterFailover: found,
  zeroDataLoss: acked === found,
  // retryable writes absorb the election: it shows up as one slow write, not an error
  electionWindowMs: maxWriteLatencyMs,
  electionWindowAt: maxWriteLatencyAt,
  errorsSurfacedToApp: failed,
  maxWriteStallMs: maxStallMs,
}, null, 2));
await client.close();
