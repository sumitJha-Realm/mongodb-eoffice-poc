// Queryable Encryption demo (RFP: KMS, data-at-rest, need-to-know fields).
// serviceNo  -> encrypted, equality-queryable
// annualPay  -> encrypted, range-queryable
// medicalCategory -> encrypted, not queryable (fully hidden)
// KMS: AWS KMS if AWS_KMS_KEY_ARN is set, else a local 96-byte master key (PoC).
// Shows: (1) encrypted client can query exact-match + range,
//        (2) a normal client / DBA / Ops Manager sees only ciphertext.
import "dotenv/config";
import fs from "fs";
import { MongoClient, Binary, Long } from "mongodb";
import { URI } from "./lib.js";

const KEY_VAULT = "encryption.__keyVault";
const DB = "poc", COLL = "personnel_confidential";

function kmsConfig() {
  if (process.env.AWS_KMS_KEY_ARN) {
    // empty aws provider -> driver auto-fetches credentials (EC2 instance role / env)
    return {
      kmsProviders: { aws: {} },
      masterKey: { provider: "aws", key: process.env.AWS_KMS_KEY_ARN, region: process.env.AWS_REGION || "ap-south-1" },
    };
  }
  const path = new URL("./local-master-key.bin", import.meta.url);
  if (!fs.existsSync(path)) fs.writeFileSync(path, Buffer.from(Array.from({ length: 96 }, () => Math.floor(Math.random() * 256))));
  return { kmsProviders: { local: { key: fs.readFileSync(path) } }, masterKey: { provider: "local" } };
}

async function main() {
  const { kmsProviders, masterKey } = kmsConfig();
  console.log(`KMS provider: ${masterKey.provider}${masterKey.key ? " (" + masterKey.key + ")" : ""}`);

  const encryptedFieldsMap = {
    [`${DB}.${COLL}`]: {
      fields: [
        { path: "serviceNo", bsonType: "string", queries: { queryType: "equality" } },
        { path: "annualPay", bsonType: "long", queries: { queryType: "range", min: Long.fromNumber(0), max: Long.fromNumber(100000000), sparsity: Long.fromNumber(1) } },
        { path: "medicalCategory", bsonType: "string" }, // encrypted, NOT queryable — fully hidden
      ],
    },
  };

  // Create the encrypted collection first (plain client): this generates one
  // data key per field, wrapped by the KMS CMK, and stores the schema server-side.
  const keyClient = new MongoClient(URI);
  await keyClient.connect();
  const exists = (await keyClient.db(DB).listCollections({ name: COLL }).toArray()).length;
  if (!exists) {
    const { ClientEncryption } = await import("mongodb");
    const ce = new ClientEncryption(keyClient, { keyVaultNamespace: KEY_VAULT, kmsProviders });
    const { key, region } = masterKey;
    await ce.createEncryptedCollection(keyClient.db(DB), COLL, {
      provider: masterKey.provider,
      createCollectionOptions: { encryptedFields: encryptedFieldsMap[`${DB}.${COLL}`] },
      masterKey: masterKey.provider === "aws" ? { key, region } : {},
    });
    console.log("Created encrypted collection + data keys in key vault.");
  }
  await keyClient.close();

  // No encryptedFieldsMap here: the driver reads the schema (with real keyIds)
  // from the server, so it encrypts with the keys that were actually created.
  const secure = new MongoClient(URI, {
    autoEncryption: {
      keyVaultNamespace: KEY_VAULT,
      kmsProviders,
      extraOptions: { cryptSharedLibPath: process.env.CRYPT_SHARED_PATH || "/opt/mongo/mongo_crypt_v1.so" },
    },
  });
  await secure.connect();
  const sdb = secure.db(DB);

  if (await sdb.collection(COLL).countDocuments() === 0) {
    await sdb.collection(COLL).insertMany([
      { name: "Sgt R Sharma", serviceNo: "774411-K", annualPay: 1260000n, medicalCategory: "A4G4", unit: "UDAAN" },
      { name: "JWO P Singh", serviceNo: "689022-F", annualPay: 1710000n, medicalCategory: "A1G1", unit: "AFS Palam" },
      { name: "Cpl S Nair", serviceNo: "801934-T", annualPay: 980000n, medicalCategory: "A2G2", unit: "AFS Hindan" },
    ]);
    console.log("Inserted 3 personnel records (fields encrypted client-side before leaving the app).");
  }

  console.log("\n--- 1. Equality query on ENCRYPTED serviceNo (authorised app) ---");
  console.log(await sdb.collection(COLL).findOne({ serviceNo: "774411-K" }, { projection: { _id: 0, __safeContent__: 0 } }));

  console.log("\n--- 2. Range query on ENCRYPTED annualPay > 10L ---");
  const rich = await sdb.collection(COLL).find({ annualPay: { $gt: 1000000n } }, { projection: { _id: 0, name: 1, annualPay: 1 } }).toArray();
  console.log(rich);

  console.log("\n--- 3. What a DBA / Ops Manager / mongosh WITHOUT keys sees ---");
  const plain = new MongoClient(URI);
  await plain.connect();
  const raw = await plain.db(DB).collection(COLL).findOne({}, { projection: { _id: 0, name: 1, serviceNo: 1, annualPay: 1, medicalCategory: 1 } });
  for (const [k, v] of Object.entries(raw)) {
    console.log(`  ${k}: ${v instanceof Binary ? `<ciphertext ${v.length()} bytes, subtype 6 — unreadable>` : v}`);
  }
  console.log("\nVerdict: fields are encrypted in memory, on disk, in backups, on the wire and in Ops Manager — yet remain queryable by the authorised application (Queryable Encryption, keys under KMS).");

  await plain.close(); await secure.close();
}
main().catch(e => { console.error(e); process.exit(1); });
