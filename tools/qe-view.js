// JSON view of Queryable Encryption for the dashboard's KMS page.
// Usage: node qe-view.js [--serviceNo 774411-K] [--minPay 1000000]
import "dotenv/config";
import { MongoClient } from "mongodb";
import { URI } from "./lib.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const serviceNo = arg("serviceNo", "774411-K");
const minPay = BigInt(arg("minPay", "1000000"));
const KEY_VAULT = "encryption.__keyVault";
const DB = "poc", COLL = "personnel_confidential";

const masterKey = process.env.AWS_KMS_KEY_ARN
  ? { provider: "aws", key: process.env.AWS_KMS_KEY_ARN, region: process.env.AWS_REGION || "ap-south-1" }
  : null;
if (!masterKey) throw new Error("AWS_KMS_KEY_ARN not set");

// What a DBA / mongosh / Ops Manager user sees: binary blobs are summarised, never decoded.
const redact = (v) => {
  if (v && v._bsontype === "Binary") {
    const b = Buffer.from(v.buffer);
    return { $binary: `subtype ${v.sub_type}`, bytes: b.length, hex: b.subarray(0, 20).toString("hex") + "…" };
  }
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object" && v.constructor?.name === "Object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return typeof v === "bigint" ? Number(v) : v;
};
const strip = (d) => { const { __safeContent__, ...rest } = d; return { ...rest, __safeContent__: `[${__safeContent__?.length ?? 0} blind-index tags]` }; };

const plain = new MongoClient(URI);
const secure = new MongoClient(URI, {
  autoEncryption: {
    keyVaultNamespace: KEY_VAULT,
    kmsProviders: { aws: {} },
    extraOptions: { cryptSharedLibPath: process.env.CRYPT_SHARED_PATH || "/opt/mongo/mongo_crypt_v1.so" },
  },
});

try {
  await Promise.all([plain.connect(), secure.connect()]);
  const pcol = plain.db(DB).collection(COLL);
  const scol = secure.db(DB).collection(COLL);

  const raw = (await pcol.find({}).toArray()).map((d) => redact(strip(d)));
  const decrypted = (await scol.find({}, { projection: { __safeContent__: 0 } }).toArray()).map((d) => redact(d));

  const t1 = performance.now();
  const eq = await scol.find({ serviceNo }, { projection: { _id: 0, __safeContent__: 0 } }).toArray();
  const eqMs = performance.now() - t1;
  const t2 = performance.now();
  const range = await scol.find({ annualPay: { $gt: minPay } }, { projection: { _id: 0, name: 1, annualPay: 1 } }).toArray();
  const rangeMs = performance.now() - t2;

  const dbaEq = await pcol.countDocuments({ serviceNo });
  const dbaRegex = await pcol.countDocuments({ serviceNo: { $regex: "^7744" } });

  const keys = (await plain.db("encryption").collection("__keyVault").find({}).toArray()).map((k) => ({
    _id: String(k._id.toString("hex")),
    wrappedBy: k.masterKey,
    encryptedKeyMaterialBytes: k.keyMaterial?.buffer?.length ?? 0,
  }));

  const coll = (await plain.db(DB).listCollections({ name: COLL }).toArray())[0];
  const encryptedFields = coll?.options?.encryptedFields?.fields?.map((f) => ({
    path: f.path, bsonType: f.bsonType, queries: f.queries ?? "none (stored encrypted, not queryable)",
  }));

  console.log(JSON.stringify(redact({
    kms: masterKey,
    encryptedFields,
    keyVault: keys,
    raw,
    decrypted,
    equality: { filter: { serviceNo }, ms: +eqMs.toFixed(1), result: eq.map(redact) },
    range: { filter: { annualPay: { $gt: Number(minPay) } }, ms: +rangeMs.toFixed(1), result: range.map(redact) },
    dba: { equalityOnPlainClient: { filter: { serviceNo }, matches: dbaEq }, regexOnPlainClient: { filter: { serviceNo: { $regex: "^7744" } }, matches: dbaRegex } },
  })));
} finally {
  await Promise.allSettled([plain.close(), secure.close()]);
}
