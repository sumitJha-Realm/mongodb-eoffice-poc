const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let state = { ready: false, rows: [], page: 1 };
let selectedId = null;
let busy = false;
let currentPage = 1;
const selected = () => state.rows.find(row => row._id === selectedId);
const date = value => new Date(value).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
async function api(path, body) {
  const response = await fetch(`/api/workflow/${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function controls() {
  byId("prepare").disabled = busy || state.ready;
  byId("constraints").disabled = busy || !state.ready;
  document.querySelectorAll(".file-action").forEach(button => { button.disabled = busy || !selected() || (selected().status === "COMPLETED" && button.id !== "reset"); });
  byId("prev").disabled = busy || currentPage <= 1;
  byId("next").disabled = busy || !state.ready || currentPage * 20 >= state.total;
  document.querySelector("#search button").disabled = busy;
  document.querySelectorAll(".file-link").forEach(button => { button.disabled = busy; });
}
function renderSelected() {
  const row = selected();
  byId("version").textContent = row ? `Version ${row.version}` : "No selection";
  byId("selected").innerHTML = row ? `<strong>${escapeHtml(row.fileNo)}</strong><p>${escapeHtml(row.correspondence[0]?.subject || "Source file unavailable")}</p><p>${escapeHtml(row.directorateDetails[0]?.name)} | ${escapeHtml(row.status)}</p><p>Source registry status: ${escapeHtml(row.correspondence[0]?.status)}</p>` : '<p class="muted">No file selected.</p>';
  byId("stages").innerHTML = row ? row.tasks.map(task => {
    const officer = row.officers.find(item => item._id === task.officerId);
    return `<li class="${escapeHtml(task.status)}">${escapeHtml(state.stages[task.stage])} <span class="badge">${escapeHtml(task.status)}</span><small>${escapeHtml(officer?.name)} | ${escapeHtml(date(task.dueAt))}</small></li>`;
  }).join("") : "";
  document.querySelectorAll("#rows tr").forEach(element => element.classList.toggle("selected", element.dataset.id === selectedId));
  controls();
}
async function load() {
  state = await api(`queue?page=${currentPage}&q=${encodeURIComponent(byId("query").value)}`);
  if (!state.rows.some(row => row._id === selectedId)) selectedId = state.rows[0]?._id;
  byId("prepare").textContent = state.ready ? "5,000 Files Prepared" : "Prepare 5,000 Files";
  byId("files").textContent = (state.meta?.fileCount || 0).toLocaleString();
  byId("tasks").textContent = (state.meta?.taskCount || 0).toLocaleString();
  byId("pending").textContent = (state.report || []).reduce((total, row) => total + row.pending, 0).toLocaleString();
  byId("overdue").textContent = (state.report || []).reduce((total, row) => total + row.overdue, 0).toLocaleString();
  byId("completed").textContent = (state.completed || 0).toLocaleString();
  byId("range").textContent = state.total ? `${(currentPage - 1) * 20 + 1}-${Math.min(currentPage * 20, state.total)} of ${state.total.toLocaleString()}` : "0 files";
  byId("rows").innerHTML = state.rows.map(row => {
    const task = row.tasks.find(item => item.status === "PENDING");
    const officer = row.officers.find(item => item._id === task?.officerId);
    return `<tr data-id="${escapeHtml(row._id)}"><td><button class="file-link" data-id="${escapeHtml(row._id)}">${escapeHtml(row.fileNo)}</button><small>${escapeHtml(row.correspondence[0]?.subject || "Source file unavailable")}</small></td><td>${escapeHtml(row.directorateDetails[0]?.name)}<small>${escapeHtml(row.correspondence[0]?.priority)}</small></td><td>${escapeHtml(officer?.name || "Completed")}<small>${escapeHtml(officer?.designation || "")}</small></td><td>${escapeHtml(task ? state.stages[task.stage] : "Completed")}<small>${task ? escapeHtml(date(task.dueAt)) : "All stages approved"}</small></td></tr>`;
  }).join("") || '<tr><td colspan="4">No files found.</td></tr>';
  byId("rows").querySelectorAll("button").forEach(button => { button.onclick = () => { selectedId = button.dataset.id; renderSelected(); }; });
  byId("pipeline").textContent = JSON.stringify(state.pipeline || [], null, 2);
  const officers = new Map((state.officers || []).map(officer => [officer._id, officer]));
  byId("workload").innerHTML = (state.report || []).map(row => `<div><strong>${escapeHtml(officers.get(row._id)?.name || row._id)}</strong><span>${row.pending} pending / ${row.overdue} overdue</span></div>`).join("");
  renderSelected();
}
function showResult(data) {
  byId("verdict").textContent = data.passed ? "PASS" : "FAIL";
  byId("verdict").className = `badge ${data.passed ? "pass" : "fail"}`;
  byId("raw").textContent = JSON.stringify(data, null, 2);
  if (data.tests) {
    byId("result").innerHTML = `<div class="checks">${data.tests.map(test => `<div class="check ${test.passed ? "" : "failed"}"><strong>${test.passed ? "PASS" : "FAIL"}</strong><span>${escapeHtml(test.name)}</span><span class="badge">${escapeHtml(test.code || "Accepted")}</span></div>`).join("")}</div>`;
  } else if (data.before) {
    const summary = (label, snapshot) => `<div><h3>${label}</h3><p>Version <b>${snapshot.file.version}</b> | ${escapeHtml(snapshot.file.status)}</p><ul>${snapshot.tasks.map(task => `<li>${escapeHtml(state.stages[task.stage])}: <b>${escapeHtml(task.status)}</b></li>`).join("")}</ul></div>`;
    const attempts = data.attempts ? data.attempts.map(attempt => `<p>Officer ${attempt.officer}: <b>${attempt.accepted ? "COMMITTED" : "REJECTED"}</b> ${escapeHtml(attempt.accepted ? "" : attempt.detail)}</p>`).join("") : "";
    byId("result").innerHTML = `<p><strong>${escapeHtml({ rollback: "Transaction rolled back", commit: "Approval committed", concurrency: "Concurrent approval results" }[data.mode])}</strong></p><div class="compare">${summary("BEFORE", data.before)}${summary("AFTER", data.after)}</div>${attempts}`;
  } else byId("result").innerHTML = `<p><strong>${data.mode === "reset" ? "Selected workflow reset" : "Workbench prepared"}</strong></p>`;
}
async function run(label, work) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  controls();
  byId("status").textContent = label;
  try {
    const data = await work();
    if (data) showResult(data);
    await load();
    byId("status").textContent = state.ready ? "Connected | 5,000 linked files | Correspondence and embeddings unchanged" : "Workbench not prepared";
  } catch (error) {
    byId("status").textContent = error.message;
    byId("verdict").textContent = "ERROR";
    byId("verdict").className = "badge fail";
    byId("result").textContent = error.message;
    byId("raw").textContent = JSON.stringify({ error: error.message }, null, 2);
    await load().catch(() => {});
  } finally { busy = false; document.body.classList.remove("busy"); controls(); }
}
byId("prepare").onclick = () => run("Preparing 5,000 linked files and 15,000 tasks...", async () => ({ ...await api("setup", {}), passed: true }));
byId("constraints").onclick = () => run("Testing database validators and unique index...", () => api("constraints", {}));
for (const mode of ["rollback", "commit", "concurrency", "reset"]) {
  byId(mode).onclick = () => {
    const row = selected();
    if (row) run(`Executing ${mode}...`, () => api(`${row._id}/action`, { mode, version: row.version }));
  };
}
byId("search").onsubmit = event => { event.preventDefault(); currentPage = 1; run("Loading queue...", async () => {}); };
byId("prev").onclick = () => { currentPage--; run("Loading queue...", async () => {}); };
byId("next").onclick = () => { currentPage++; run("Loading queue...", async () => {}); };
run("Connecting...", async () => {});