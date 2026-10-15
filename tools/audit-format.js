// Formats MongoDB Enterprise audit records (stdin, one JSON object per line)
// into a readable table for the demo. Internal __system auth noise is dropped.
const INTERESTING = new Set([
  "authenticate", "createUser", "dropUser", "createRole", "dropRole",
  "grantRolesToUser", "revokeRolesFromUser",
  "createCollection", "dropCollection", "createIndex", "dropIndex",
  "insert", "update", "remove", "shutdown",
]);

let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", () => {
  const rows = [];
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!INTERESTING.has(r.atype)) continue;
    const user = r.users?.[0] ? `${r.users[0].user}@${r.users[0].db}` : (r.param?.user ? `${r.param.user}@${r.param.db}` : "-");
    if (user.startsWith("__system@")) continue;
    rows.push({
      ts: (r.ts?.$date || "").replace("T", " ").slice(0, 23),
      atype: r.atype,
      user,
      source: r.remote?.ip || "-",
      target: r.param?.ns || r.param?.db || "-",
      result: r.result === 0 ? "SUCCESS" : `DENIED(${r.result})`,
    });
  }

  const limit = Number(process.argv[2] || 12);
  // Routine successful logins are high-volume; surface privileged actions and
  // denied attempts first so the security story is visible at a glance.
  const privileged = rows.filter((r) => r.atype !== "authenticate" || r.result !== "SUCCESS");
  const routine = rows.filter((r) => r.atype === "authenticate" && r.result === "SUCCESS");
  const show = [...privileged.slice(-limit), ...routine.slice(-Math.max(0, limit - privileged.length))]
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (!show.length) {
    console.log("  (no user-level audit records in this window)");
    return;
  }
  const cols = ["ts", "atype", "user", "source", "target", "result"];
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...show.map((r) => String(r[c]).length))]));
  const line = (r) => "  " + cols.map((c) => String(r[c]).padEnd(w[c])).join("  ");
  console.log(line(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  console.log("  " + cols.map((c) => "-".repeat(w[c])).join("  "));
  show.forEach((r) => console.log(line(r)));
});
