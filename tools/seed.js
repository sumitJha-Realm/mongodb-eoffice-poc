// Seeds 1M realistic eOffice correspondence docs (RFP Appx L #6 corpus).
// ~7% carry scanned attachments with OCR-extracted metadata so FTS + vector
// search can find files by the content of the scan (integrated DMS story).
// Usage: node seed.js [count]   (default 1,000,000; resumable — appends)
import { client, corr, db } from "./lib.js";

const COUNT = Number(process.argv[2] || 1_000_000);
const BATCH = 10_000;

const DIRS = ["Ops", "Maint", "Admin", "Plans", "CIT", "Trg", "Works", "Accts"];
const STATIONS = ["Rajokri", "Palam", "Hindan", "Ambala", "Jodhpur", "Pune", "Jorhat", "Gwalior", "Kalaikunda", "Bidar"];
const RANKS = ["AC", "LAC", "Cpl", "Sgt", "JWO", "WO", "MWO", "Fg Offr", "Flt Lt", "Sqn Ldr", "Wg Cdr", "Gp Capt"];
const NAMES = ["R Sharma", "A Verma", "S Nair", "P Singh", "K Reddy", "M Das", "V Kulkarni", "T Bhatt", "N Gill", "D Rawat", "J Mehta", "H Yadav"];
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// Each scenario: subjects/bodies with paraphrase variety (semantic search wow),
// optional scan types whose OCR text matches the case.
const SCENARIOS = [
  {
    tag: "leave_compassionate",
    subjects: [
      "Application for leave on compassionate grounds — {name}",
      "Request for urgent leave: mother hospitalised — {rank} {name}",
      "Compassionate leave case of {rank} {name}, {station}",
    ],
    bodies: [
      "{rank} {name} of {station} has requested {n} days leave as his mother is seriously unwell and admitted to hospital. Medical documents attached. Recommended for sanction on compassionate grounds.",
      "The individual seeks emergency absence to attend to a critical family medical situation. CO {station} has verified the hospital admission slip and recommends grant of leave.",
    ],
    scans: [["medical_certificate", "Govt Hospital OPD slip. Patient admitted ICU ward {n}. Condition critical. Attendant required. Dr {name}, MD Medicine."]],
  },
  {
    tag: "procurement_ld",
    subjects: [
      "Imposition of Liquidated Damages on M/s {vendor} — delayed delivery",
      "LD recovery for late supply against contract {fileSeq}",
      "Penalty for delivery delay by vendor {vendor}",
    ],
    bodies: [
      "Delivery of stores against the subject contract was completed {n} weeks beyond the contracted delivery period. LD at 0.5% per week, capped at 10% of contract value, is to be recovered per DPM 2025 before release of final payment.",
      "The vendor failed to meet the delivery schedule. Recovery of liquidated damages from the pending invoice is recommended; PBG remains valid for encashment if required.",
    ],
    scans: [["invoice_scan", "TAX INVOICE M/s {vendor}. Contract ref {fileSeq}. Amount Rs {amount}. GSTIN 07AA{n}. Delivery note enclosed. Late delivery acknowledged."]],
  },
  {
    tag: "posting_representation",
    subjects: [
      "Representation against posting order — {rank} {name}",
      "Request for retention at {station} on medical grounds of dependent",
      "Posting review: {rank} {name} to remain at present unit",
    ],
    bodies: [
      "{rank} {name} has represented against transfer citing ongoing treatment of dependent child at {station} service hospital. Spouse employment and school year completion also cited. Case forwarded for consideration by P Staff.",
      "The airman requests cancellation or deferment of posting due to compassionate family circumstances. Unit recommends partial acceptance with six month deferment.",
    ],
    scans: [["medical_certificate", "Service Hospital {station}. Dependent under continuing treatment, paediatric cardiology. Transfer of guardian not advised for {n} months."]],
  },
  {
    tag: "coi",
    subjects: [
      "Convening of Court of Inquiry — loss of service equipment at {station}",
      "COI proceedings: damage to govt property, {station}",
      "Court of Inquiry into vehicle accident involving {rank} {name}",
    ],
    bodies: [
      "A Court of Inquiry is convened to investigate the circumstances of loss/damage reported at {station}. Presiding officer and two members detailed. Proceedings to be completed within {n} days and forwarded with recommendations on regularisation of loss.",
      "COI directed to establish facts, fix responsibility and recommend remedial measures. Witness statements and board proceedings to be appended.",
    ],
    scans: [["court_order_scan", "COURT OF INQUIRY proceedings page {n}. Witness statement recorded. Exhibit marked. Presiding Officer signature affixed."]],
  },
  {
    tag: "cyber_incident",
    subjects: [
      "Cyber security incident report — unauthorised USB usage at {station}",
      "Reporting of malware detection on standalone system, {station}",
      "Breach of cyber security SOP by {rank} {name}",
    ],
    bodies: [
      "EDR alert flagged execution of unauthorised media on an official system. System quarantined, image forwarded to CERT for forensic analysis. Disciplinary aspect being progressed separately per Security Manual provisions.",
      "A phishing attempt targeting unit personnel was reported and contained. All users re-briefed on cyber hygiene; audit of endpoint compliance initiated.",
    ],
    scans: [],
  },
  {
    tag: "mes_works",
    subjects: [
      "Sanction for special repair of runway shoulder — {station}",
      "MES works: urgent repair of technical accommodation at {station}",
      "Budget allotment for authorised works programme {fileSeq}",
    ],
    bodies: [
      "Administrative approval sought for special repairs estimated at Rs {amount}. Works Priority Board has cleared the proposal; funds available under the relevant minor head. Early sanction requested to avoid monsoon damage.",
      "The subject work is operationally essential. Board of officers has verified scales and specifications. Case forwarded for CFA sanction.",
    ],
    scans: [["estimate_scan", "MES ESTIMATE. Serial {n}. Special repair {station}. Amount Rs {amount}. SSR 2024 rates applied. GE signature."]],
  },
  {
    tag: "training",
    subjects: [
      "Detailment for professional course — {rank} {name}",
      "Nomination of personnel for {n} week training at {station}",
      "Training directive: system administration course batch {n}",
    ],
    bodies: [
      "Nominations are invited for the subject course commencing next quarter. Units to forward names of eligible personnel with requisite trade and medical category by the PDC. Reserve nominations also to be indicated.",
      "{rank} {name} is detailed to attend the course. Movement, TA/DA and relief arrangements to be made by parent unit.",
    ],
    scans: [],
  },
  {
    tag: "pension_terminal",
    subjects: [
      "Terminal benefits and pension documentation — {rank} {name} (retd)",
      "Delay in disbursal of retirement dues: {name}",
      "Service pension case forwarded to PCDA — {rank} {name}",
    ],
    bodies: [
      "Pension documents in respect of the individual retiring on superannuation have been forwarded to PCDA. Discrepancy in qualifying service computation observed and clarification sought. Family pension nomination verified.",
      "The veteran has represented regarding non-receipt of commutation arrears for {n} months. Case taken up with the paying agency on priority.",
    ],
    scans: [["pension_form_scan", "PPO application form. Service no verified. Qualifying service {n} years. Commutation opted 50 percent. Bank mandate enclosed."]],
  },
  {
    tag: "ration_quality",
    subjects: [
      "Quality complaint: fresh ration supplied at {station}",
      "Rejection of ration consignment by board of officers",
      "ASC supply irregularity report — {station}",
    ],
    bodies: [
      "The board rejected the consignment on grounds of sub-standard quality. Replacement demanded from the contractor; recovery and risk-purchase provisions of the contract invoked if not replaced within {n} days.",
      "Repeated quality issues with perishables have been reported. Joint inspection with supplier representative scheduled; penalty clause applicability under examination.",
    ],
    scans: [],
  },
  {
    tag: "flight_safety",
    subjects: [
      "Flight safety occurrence report — bird activity at {station}",
      "FOD prevention drive and runway inspection, {station}",
      "Hazard report: wildlife incursion near dispersal area",
    ],
    bodies: [
      "Increased bird activity observed on approach funnel. Bird hazard combat team augmented, garbage disposal around camp area reviewed with civil municipality. All aircrew briefed on revised bird watch condition.",
      "During routine inspection foreign object debris was detected on taxi track. Immediate sweep ordered, tool accounting audit carried out across servicing sections.",
    ],
    scans: [],
  },
];
const VENDORS = ["Bharat InfoSys", "Trident Defence Systems", "Apex Engineering", "Shakti Electronics", "NavTech Solutions"];

function fill(t, ctx) {
  return t.replace(/\{(\w+)\}/g, (_, k) => ctx[k]);
}

async function main() {
  await client.connect();
  const col = corr();
  await col.createIndex({ fileNo: 1 });
  await col.createIndex({ directorate: 1, status: 1, createdAt: -1 });
  await col.createIndex({ subject: "text", body: "text", "attachments.ocr.text": "text" });
  await col.createIndex({ createdAt: -1 });
  await col.createIndex({ scenario: 1 });

  const start = await col.estimatedDocumentCount();
  console.log(`Existing docs: ${start}. Seeding ${COUNT} more...`);
  const t0 = Date.now();

  for (let i = start; i < start + COUNT; i += BATCH) {
    const docs = [];
    for (let j = i; j < Math.min(i + BATCH, start + COUNT); j++) {
      const sc = rand(SCENARIOS);
      const ctx = {
        name: rand(NAMES), rank: rand(RANKS), station: rand(STATIONS), vendor: rand(VENDORS),
        n: randInt(2, 48), amount: (randInt(2, 900) * 100000).toLocaleString("en-IN"), fileSeq: `AIRHQ/C ${randInt(10000, 99999)}/${j}`,
      };
      const doc = {
        fileNo: `AIRHQ/C 17500/${j}/UDAAN`,
        scenario: sc.tag,
        subject: fill(rand(sc.subjects), ctx),
        body: fill(rand(sc.bodies), ctx),
        directorate: rand(DIRS),
        station: ctx.station,
        status: rand(["OPEN", "PENDING", "CLOSED"]),
        priority: rand(["NORMAL", "NORMAL", "NORMAL", "URGENT", "TOP"]),
        classification: rand(["UNCLAS", "UNCLAS", "RESTRICTED", "CONFIDENTIAL"]),
        createdAt: new Date(Date.now() - Math.random() * 3 * 365 * 864e5),
      };
      // ~7% of files carry a scanned attachment with OCR-extracted metadata
      if (sc.scans.length && Math.random() < 0.07 * (SCENARIOS.length / sc.scans.length) / 10 + 0.07) {
        const [type, ocrTpl] = rand(sc.scans);
        doc.attachments = [{
          filename: `${type}_${j}.pdf`,
          type,
          source: "flatbed-scanner",
          pages: randInt(1, 6),
          sizeKB: randInt(80, 2400),
          ocr: {
            engine: "tesseract-5",
            lang: rand(["eng", "eng", "eng+hin"]),
            confidence: +(0.82 + Math.random() * 0.16).toFixed(2),
            text: fill(ocrTpl, ctx),
            extractedAt: new Date(),
          },
        }];
      }
      docs.push(doc);
    }
    await col.insertMany(docs, { ordered: false, writeConcern: { w: 1 } });
    if ((i - start) % 100000 < BATCH) {
      const done = i - start + docs.length;
      console.log(`  ${done.toLocaleString()} / ${COUNT.toLocaleString()}  (${(done / ((Date.now() - t0) / 1000)).toFixed(0)} docs/s)`);
    }
  }

  const total = await col.estimatedDocumentCount();
  const withScans = await col.countDocuments({ attachments: { $exists: true } });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s. Total: ${total.toLocaleString()}, with scanned attachments: ${withScans.toLocaleString()}`);
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
