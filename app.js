import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, writeBatch, getDoc, arrayUnion, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const SALES_STAFF = ["Silven", "Shivangi", "Saniya", "Yashvi"];
const CURRENCIES = ["INR", "USD", "EUR", "RMB"];

let currentUser = null;      // Firebase Auth user object
let currentRole = null;      // "master" | "manager" | "sales"
let currentName = null;      // display name from users/{uid}
let leads = [];              // live leads array (role-filtered by security rules + query)
let exchangeRates = { USD: 0, EUR: 0, RMB: 0 };
let hoveredLeadId = null;    // tracks which lead row the mouse is over, for F2/F4
let editingLeadId = null;    // lead currently open in the modal (null = creating new)
let leadsUnsub = null;
let usersUnsub = null;
let usersCache = [];
let tasksUnsub = null;
let tasks = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function $(id){ return document.getElementById(id); }
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDays(dateStr, n){
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0,10);
}
function daysSince(dateStr){
  if(!dateStr) return 0;
  const start = new Date(dateStr);
  const now = new Date(todayISO());
  if(isNaN(start)) return 0;
  return Math.floor((now - start) / (1000*60*60*24));
}
const FOLLOWUP_CYCLE_DAYS = 3;   // prompt again every 3 days while a query is open
const LEAD_EXPIRY_DAYS = 15;     // no resolution by day 15 -> auto-marked dead
const OPEN_STATUSES = ["New","Contacted","Quoted","Follow-up","Negotiation"];
let reorderCycleDays = 12;       // default; overridden by Settings > Re-order reminder
function monthKey(dateStr){
  if(!dateStr) return "";
  const d = new Date(dateStr);
  if(isNaN(d)) return "";
  return d.toLocaleString("en-US", { month:"short", year:"numeric" }); // e.g. "Aug 2026"
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function statusBadgeClass(status){
  const map = {
    "New":"new", "Contacted":"contacted", "Quoted":"quoted", "Follow-up":"followup",
    "Negotiation":"negotiation", "Won":"won", "Lost":"lost"
  };
  return map[status] || "new";
}
function computeINR(value, currency){
  const v = Number(value) || 0;
  if(!currency || currency === "INR") return v;
  const rate = Number(exchangeRates[currency]) || 0;
  return Math.round(v * rate * 100) / 100;
}
// If the country isn't India, default the currency dropdown to USD --
// still fully editable afterwards (e.g. for EUR/RMB clients).
function autoCurrencyFromCountry(countryInputId, currencySelectId){
  const countryEl = $(countryInputId);
  const currencyEl = $(currencySelectId);
  const apply = () => {
    const country = countryEl.value.trim().toLowerCase();
    if(!country) return;
    const isIndia = country === "india" || country === "in";
    // Only auto-switch if the user hasn't already picked a non-INR currency
    // themselves for a non-obvious reason -- we only override when it still
    // says the default (INR while country isn't India, or USD while it is).
    if(!isIndia && currencyEl.value === "INR"){
      currencyEl.value = "USD";
    } else if(isIndia && currencyEl.value === "USD"){
      currencyEl.value = "INR";
    }
  };
  countryEl.addEventListener("change", apply);
  countryEl.addEventListener("blur", apply);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$("loginBtn").onclick = async () => {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  $("loginError").textContent = "";
  if(!email || !password){
    $("loginError").textContent = "Enter your email and password.";
    return;
  }
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(err){
    $("loginError").textContent = "Sign-in failed. Check your email and password.";
    console.error(err);
  }
};
$("loginPassword").addEventListener("keydown", e => { if(e.key === "Enter") $("loginBtn").click(); });

$("signOutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  if(!user){
    currentUser = null; currentRole = null; currentName = null;
    if(leadsUnsub) leadsUnsub();
    if(usersUnsub) usersUnsub();
    if(tasksUnsub) tasksUnsub();
    $("loginScreen").classList.remove("hidden");
    $("appScreen").classList.add("hidden");
    return;
  }
  currentUser = user;
  const userDocSnap = await getDoc(doc(db, "users", user.uid));
  if(!userDocSnap.exists()){
    $("loginError").textContent = "Your account isn't set up in the CRM yet. Ask Silven to add you under Users.";
    await signOut(auth);
    return;
  }
  const udata = userDocSnap.data();
  currentRole = udata.role;
  currentName = udata.name || user.email;

  $("loginScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  $("userName").textContent = currentName;
  $("userRoleBadge").textContent = currentRole;
  $("userRoleBadge").className = "role-badge " + currentRole;
  $("usersTabBtn").classList.toggle("hidden", currentRole !== "master");
  $("filterSalesPerson").classList.toggle("hidden", currentRole === "sales");
  $("leadDeleteBtn").classList.toggle("hidden", currentRole === "sales");

  populateSalesPersonSelects();
  attachLeadsListener();
  attachTasksListener();
  if(currentRole === "master") attachUsersListener();
  loadExchangeRates();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-section").forEach(s => s.classList.add("hidden"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.remove("hidden");
    if(btn.dataset.tab === "tasks"){ renderDailyTasks(); renderManualTasks(); }
    if(btn.dataset.tab === "dashboard") renderDashboard();
  };
});

// ---------------------------------------------------------------------------
// Sales-person selects (role-aware)
// ---------------------------------------------------------------------------
function populateSalesPersonSelects(){
  const opts = SALES_STAFF.map(n => `<option value="${n}">${n}</option>`).join("");
  $("f-salesPerson").innerHTML = opts;
  $("b-salesPerson").innerHTML = opts;
  $("t-assignedTo").innerHTML = opts;
  $("filterSalesPerson").innerHTML = `<option value="">All Sales People</option>` + opts;

  if(currentRole === "sales"){
    // Sales reps only ever create/see their own leads
    $("f-salesPerson").value = currentName;
    $("f-salesPerson").disabled = true;
    $("b-salesPerson").value = currentName;
    $("b-salesPerson").disabled = true;
    $("t-assignedTo").value = currentName;
  }
}

// ---------------------------------------------------------------------------
// Leads: live listener + render
// ---------------------------------------------------------------------------
let firstLeadsLoad = true;

function attachLeadsListener(){
  if(leadsUnsub) leadsUnsub();
  // Sales reps' security rule only lets them read leads where salesPerson
  // matches their own name. Firestore requires a *query* that's provably
  // restricted the same way -- an unfiltered "list all leads" query would
  // be rejected outright for them, not just filtered down -- so the query
  // itself needs the matching where() clause, not just a client-side filter.
  const q = currentRole === "sales"
    ? query(collection(db, "leads"), where("salesPerson", "==", currentName), orderBy("inquiryDate", "desc"))
    : query(collection(db, "leads"), orderBy("inquiryDate", "desc"));
  leadsUnsub = onSnapshot(q, snap => {
    leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateMonthFilters();
    renderLeadsTable();
    renderDailyTasks();
    renderDashboard();
    autoExpireStaleLeads();
    refreshTasksTabBadge();
    if(firstLeadsLoad){
      firstLeadsLoad = false;
      announceDueFollowUps();
    }
  }, err => {
    console.error(err);
    toast("Couldn't load leads — check your connection.");
  });
}

// A query with no resolution by day 15 auto-closes as dead, so nothing
// silently sits open forever. Anchored to the inquiry date, and only
// touches leads still in an open status (Won/Lost are left alone).
async function autoExpireStaleLeads(){
  const stale = visibleLeads().filter(l =>
    OPEN_STATUSES.includes(l.leadStatus) && daysSince(l.inquiryDate) >= LEAD_EXPIRY_DAYS
  );
  for(const lead of stale){
    try{
      await updateDoc(doc(db, "leads", lead.id), {
        leadStatus: "Lost",
        leadConsumption: "Consumed",
        remarks: (lead.remarks ? lead.remarks + " " : "") + `[Auto-marked dead: no resolution after ${LEAD_EXPIRY_DAYS} days]`,
        updatedAt: serverTimestamp()
      });
    }catch(err){ console.error("Auto-expire failed for", lead.id, err); }
  }
  if(stale.length) toast(`${stale.length} lead${stale.length===1?"":"s"} auto-marked dead (15+ days, no resolution).`);
}

// One-time heads-up on login for what needs chasing today, rather than an
// intrusive popup every time the leads list refreshes.
function announceDueFollowUps(){
  const today = todayISO();
  const dueToday = visibleLeads().filter(l => l.followUpDate === today && OPEN_STATUSES.includes(l.leadStatus));
  const overdue = visibleLeads().filter(l => l.followUpDate && l.followUpDate < today && OPEN_STATUSES.includes(l.leadStatus));
  const reorderDue = visibleLeads().filter(l => l.leadStatus === "Won" && l.reorderReminderDate && l.reorderReminderDate <= today);
  if(dueToday.length || overdue.length || reorderDue.length){
    const parts = [];
    if(dueToday.length) parts.push(`${dueToday.length} follow-up${dueToday.length===1?"":"s"} due today`);
    if(overdue.length) parts.push(`${overdue.length} overdue`);
    if(reorderDue.length) parts.push(`${reorderDue.length} re-order check-in${reorderDue.length===1?"":"s"} due`);
    toast(parts.join(" · ") + " — check Daily Tasks.");
  }
}

function refreshTasksTabBadge(){
  const today = todayISO();
  const followUpCount = visibleLeads().filter(l =>
    OPEN_STATUSES.includes(l.leadStatus) && l.followUpDate && l.followUpDate <= today
  ).length;
  const reorderCount = visibleLeads().filter(l =>
    l.leadStatus === "Won" && l.reorderReminderDate && l.reorderReminderDate <= today
  ).length;
  const manualCount = visibleTasks().filter(t => !t.done && t.dueDate && t.dueDate <= today).length;
  const count = followUpCount + reorderCount + manualCount;
  const btn = document.querySelector('.tab-btn[data-tab="tasks"]');
  if(!btn) return;
  btn.textContent = count > 0 ? `Daily Tasks (${count})` : "Daily Tasks";
}

function visibleLeads(){
  // Sales reps only see their own leads; manager & master see everyone's.
  if(currentRole === "sales"){
    return leads.filter(l => l.salesPerson === currentName);
  }
  return leads;
}

function populateMonthFilters(){
  const months = [...new Set(leads.map(l => monthKey(l.inquiryDate)).filter(Boolean))];
  months.sort((a,b) => new Date("1 " + b) - new Date("1 " + a));
  const optsHtml = `<option value="">All Months</option>` + months.map(m => `<option>${m}</option>`).join("");
  const currentDashVal = $("dashMonth").value;
  $("filterMonth").innerHTML = optsHtml;
  $("dashMonth").innerHTML = optsHtml;
  if(months.includes(currentDashVal)) $("dashMonth").value = currentDashVal;
  else if(months.length) $("dashMonth").value = months[0];
}

function renderLeadsTable(){
  const search = $("leadSearch").value.trim().toLowerCase();
  const statusFilter = $("filterStatus").value;
  const spFilter = $("filterSalesPerson").value;
  const monthFilter = $("filterMonth").value;

  let rows = visibleLeads().filter(l => {
    if(statusFilter && l.leadStatus !== statusFilter) return false;
    if(spFilter && l.salesPerson !== spFilter) return false;
    if(monthFilter && monthKey(l.inquiryDate) !== monthFilter) return false;
    if(search){
      const hay = [l.clientName, l.partNo, l.city, l.country, l.remarks].join(" ").toLowerCase();
      if(!hay.includes(search)) return false;
    }
    return true;
  });

  $("leadsEmpty").classList.toggle("hidden", rows.length > 0);

  $("leadsBody").innerHTML = rows.map(l => {
    const quotedDisplay = l.quotedValue ? `${l.quotedCurrency||"INR"} ${Number(l.quotedValue).toLocaleString()}` : "—";
    const orderDisplay = l.orderValue ? `${l.orderCurrency||"INR"} ${Number(l.orderValue).toLocaleString()}` : "—";
    const isClosed = l.leadStatus === "Won" || l.leadStatus === "Lost";
    const statusButtons = isClosed
      ? `<button class="icon-btn" data-action="reopen" data-id="${l.id}" title="Undo — back to active">↺ Reopen</button>`
      : `<button class="icon-btn" data-action="mark-won" data-id="${l.id}" title="Won & Order Confirmed (F2)">✓ Won</button>
         <button class="icon-btn" data-action="mark-lost" data-id="${l.id}" title="Lapsed (F4)">✕ Lost</button>`;
    return `
      <tr data-id="${l.id}">
        <td>${escapeHtml(l.inquiryDate||"")}</td>
        <td>${escapeHtml(l.clientName||"")}</td>
        <td>${escapeHtml(l.country||"")}</td>
        <td>${escapeHtml(l.salesPerson||"")}</td>
        <td>${escapeHtml(l.partNo||"")}</td>
        <td>${escapeHtml(l.qty ?? "")}</td>
        <td>${quotedDisplay}</td>
        <td><span class="badge ${statusBadgeClass(l.leadStatus)}">${escapeHtml(l.leadStatus||"New")}</span></td>
        <td>${escapeHtml(l.followUpDate||"—")}</td>
        <td>${orderDisplay}</td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-action="edit" data-id="${l.id}">Open</button>
          ${statusButtons}
        </td>
      </tr>
    `;
  }).join("");

  // Row hover tracking (drives the F2/F4 shortcuts) + click-to-edit
  document.querySelectorAll("#leadsBody tr").forEach(tr => {
    tr.addEventListener("mouseenter", () => { hoveredLeadId = tr.dataset.id; });
    tr.addEventListener("mouseleave", () => { if(hoveredLeadId === tr.dataset.id) hoveredLeadId = null; });
  });
  $("leadsBody").querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.onclick = () => openLeadModal(btn.dataset.id);
  });
  $("leadsBody").querySelectorAll('[data-action="mark-won"]').forEach(btn => {
    btn.onclick = () => markLeadWon(btn.dataset.id);
  });
  $("leadsBody").querySelectorAll('[data-action="mark-lost"]').forEach(btn => {
    btn.onclick = () => markLeadLost(btn.dataset.id);
  });
  $("leadsBody").querySelectorAll('[data-action="reopen"]').forEach(btn => {
    btn.onclick = () => reopenLead(btn.dataset.id);
  });
}

["leadSearch","filterStatus","filterSalesPerson","filterMonth"].forEach(id => {
  $(id).addEventListener("input", renderLeadsTable);
  $(id).addEventListener("change", renderLeadsTable);
});

// Shared status-change logic -- used by both the F2/F4 keyboard shortcuts
// and the click buttons in the table/modal, so they always stay in sync.
async function markLeadWon(leadId){
  const lead = leads.find(l => l.id === leadId);
  if(!lead) return;
  const update = {
    leadStatus: "Won", orderStatus: "Confirmed", leadConsumption: "Converted",
    updatedAt: serverTimestamp()
  };
  if(!lead.reorderReminderDate){
    update.reorderReminderDate = addDays(todayISO(), reorderCycleDays);
    update.reorderLog = [];
  }
  try{
    await updateDoc(doc(db, "leads", leadId), update);
    toast(`${lead.clientName || "Lead"} marked Won & Order Confirmed`);
  }catch(err){
    console.error(err);
    toast("Couldn't update that lead — try again.");
  }
}

async function markLeadLost(leadId){
  const lead = leads.find(l => l.id === leadId);
  if(!lead) return;
  try{
    await updateDoc(doc(db, "leads", leadId), {
      leadStatus: "Lost", leadConsumption: "Consumed", updatedAt: serverTimestamp()
    });
    toast(`${lead.clientName || "Lead"} marked Lapsed`);
  }catch(err){
    console.error(err);
    toast("Couldn't update that lead — try again.");
  }
}

// Undoes a Won or Lost marking, back to a neutral open state -- picks the
// follow-up cadence back up with a fresh 3-day cycle, since the query is
// active again.
async function reopenLead(leadId){
  const lead = leads.find(l => l.id === leadId);
  if(!lead) return;
  try{
    await updateDoc(doc(db, "leads", leadId), {
      leadStatus: "New", orderStatus: "Pending", leadConsumption: "Active",
      followUpDate: addDays(todayISO(), FOLLOWUP_CYCLE_DAYS),
      updatedAt: serverTimestamp()
    });
    toast(`${lead.clientName || "Lead"} reopened as an active query.`);
  }catch(err){
    console.error(err);
    toast("Couldn't reopen that lead — try again.");
  }
}

// ---------------------------------------------------------------------------
// F2 / F4 shortcuts -- act on whichever lead row the mouse is hovering
// ---------------------------------------------------------------------------
document.addEventListener("keydown", async (e) => {
  if(e.key !== "F2" && e.key !== "F4") return;
  const tag = (e.target.tagName || "").toLowerCase();
  if(tag === "input" || tag === "textarea" || tag === "select") return;
  if(!hoveredLeadId) return;
  const lead = leads.find(l => l.id === hoveredLeadId);
  if(!lead) return;
  e.preventDefault();

  const tr = document.querySelector(`#leadsBody tr[data-id="${hoveredLeadId}"]`);
  if(tr){ tr.classList.add("row-flash"); setTimeout(() => tr.classList.remove("row-flash"), 400); }

  if(e.key === "F2") markLeadWon(hoveredLeadId);
  else markLeadLost(hoveredLeadId);
});

// ---------------------------------------------------------------------------
// Lead modal (create / edit)
// ---------------------------------------------------------------------------
const LEAD_FIELD_IDS = {
  inquiryDate:"f-date", clientName:"f-client", clientType:"f-clientType", country:"f-country",
  state:"f-state", city:"f-city", salesPerson:"f-salesPerson", leadSource:"f-leadSource",
  productCategory:"f-category", partNo:"f-partNo", qty:"f-qty", quotedValue:"f-quotedValue",
  quotedCurrency:"f-currency", leadStatus:"f-leadStatus", followUpDate:"f-followUpDate",
  expectedClosingDate:"f-expectedClosing", orderStatus:"f-orderStatus", orderValue:"f-orderValue",
  orderCurrency:"f-orderCurrency", leadConsumption:"f-leadConsumption", remarks:"f-remarks"
};

function openLeadModal(id){
  editingLeadId = id || null;
  const lead = id ? leads.find(l => l.id === id) : null;

  if(currentRole === "sales" && lead && lead.salesPerson !== currentName){
    toast("You can only edit your own leads.");
    return;
  }

  $("leadModalTitle").textContent = lead ? "Edit Lead" : "New Lead";
  $("leadDeleteBtn").classList.toggle("hidden", !lead || currentRole === "sales");

  for(const [field, elId] of Object.entries(LEAD_FIELD_IDS)){
    $(elId).value = lead ? (lead[field] ?? "") : (field === "inquiryDate" ? todayISO() : (field === "clientType" ? "Domestic" : (field === "leadStatus" ? "New" : (field === "orderStatus" ? "Pending" : (field === "leadConsumption" ? "Active" : (field === "quotedCurrency" || field === "orderCurrency" ? "INR" : ""))))));
  }
  if(currentRole === "sales") $("f-salesPerson").value = currentName;
  $("transferHint").textContent = (currentRole === "master" || currentRole === "manager")
    ? "Changing this and saving transfers the lead to that person — it's logged below."
    : "";

  renderTransferLog(lead);
  renderFollowUpLog(lead);
  $("f-followUpNote").value = "";

  const isWon = lead && lead.leadStatus === "Won";
  const isClosed = lead && (lead.leadStatus === "Won" || lead.leadStatus === "Lost");
  $("modalMarkWonBtn").classList.toggle("hidden", !lead || isClosed);
  $("modalMarkLostBtn").classList.toggle("hidden", !lead || isClosed);
  $("modalReopenBtn").classList.toggle("hidden", !lead || !isClosed);

  $("reorderSection").classList.toggle("hidden", !isWon);
  if(isWon){
    renderReorderLog(lead);
    $("reorderNextDateLabel").textContent = lead.reorderReminderDate
      ? `· Next reminder: ${lead.reorderReminderDate}` : "";
    $("f-reorderNote").value = "";
  }

  $("leadOverlay").classList.remove("hidden");
}

function renderReorderLog(lead){
  const log = (lead && lead.reorderLog) || [];
  if(!log.length){
    $("reorderLogList").innerHTML = "<em>No re-order contact logged yet.</em>";
    return;
  }
  $("reorderLogList").innerHTML = log.slice().reverse().map(entry =>
    `<div>• ${escapeHtml(entry.date||"")} (${escapeHtml(entry.by||"")}): ${escapeHtml(entry.note||"")}</div>`
  ).join("");
}

function renderTransferLog(lead){
  const log = (lead && lead.transferLog) || [];
  $("transferHistorySection").style.display = log.length ? "" : "none";
  if(!log.length) return;
  $("transferLogList").innerHTML = log.slice().reverse().map(entry =>
    `<div>• ${escapeHtml(entry.date||"")}: ${escapeHtml(entry.from||"—")} → ${escapeHtml(entry.to||"")} (by ${escapeHtml(entry.by||"")})</div>`
  ).join("");
}

function renderFollowUpLog(lead){
  const log = (lead && lead.followUpLog) || [];
  if(!log.length){
    $("followUpLogList").innerHTML = "<em>No follow-up notes yet.</em>";
    return;
  }
  $("followUpLogList").innerHTML = log.slice().reverse().map(entry =>
    `<div>• <strong>Follow-up #${entry.attempt||"?"}</strong> — ${escapeHtml(entry.date||"")} (${escapeHtml(entry.by||"")}): ${escapeHtml(entry.note||"")}</div>`
  ).join("");
}

$("newLeadBtn").onclick = () => openLeadModal(null);
$("leadCancelBtn").onclick = () => $("leadOverlay").classList.add("hidden");

$("modalMarkWonBtn").onclick = async () => {
  if(!editingLeadId) return;
  await markLeadWon(editingLeadId);
  openLeadModal(editingLeadId);
};
$("modalMarkLostBtn").onclick = async () => {
  if(!editingLeadId) return;
  await markLeadLost(editingLeadId);
  openLeadModal(editingLeadId);
};
$("modalReopenBtn").onclick = async () => {
  if(!editingLeadId) return;
  await reopenLead(editingLeadId);
  openLeadModal(editingLeadId);
};

autoCurrencyFromCountry("f-country", "f-currency");

$("leadSaveBtn").onclick = async () => {
  const data = {};
  for(const [field, elId] of Object.entries(LEAD_FIELD_IDS)){
    const el = $(elId);
    data[field] = el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value.trim();
  }
  if(!data.clientName){ toast("Client name is required."); return; }
  data.month = monthKey(data.inquiryDate);
  data.quotedValueINR = computeINR(data.quotedValue, data.quotedCurrency);
  data.orderValueINR = computeINR(data.orderValue, data.orderCurrency);
  data.updatedAt = serverTimestamp();

  const existingLead = editingLeadId ? leads.find(l => l.id === editingLeadId) : null;
  // Just turned Won (via the dropdown, not just F2) -- start the re-order
  // reminder cycle here too, same as the shortcut does.
  if(data.leadStatus === "Won" && (!existingLead || !existingLead.reorderReminderDate)){
    data.reorderReminderDate = addDays(todayISO(), reorderCycleDays);
    data.reorderLog = existingLead ? (existingLead.reorderLog || []) : [];
  }
  // Sales Person changed on an existing lead -- that's a transfer. Log who
  // moved it, from whom, to whom, and when, so there's a paper trail.
  if(existingLead && data.salesPerson !== existingLead.salesPerson){
    data.transferLog = (existingLead.transferLog || []).concat([{
      date: todayISO(), from: existingLead.salesPerson || "—", to: data.salesPerson, by: currentName
    }]);
  }

  try{
    if(editingLeadId){
      await updateDoc(doc(db, "leads", editingLeadId), data);
      toast("Lead updated.");
    }else{
      // Default the first follow-up to 3 days out if nothing was entered,
      // so every new lead starts on the standard follow-up cadence.
      if(!data.followUpDate) data.followUpDate = addDays(data.inquiryDate || todayISO(), FOLLOWUP_CYCLE_DAYS);
      data.followUpCount = 0;
      data.createdAt = serverTimestamp();
      data.createdBy = currentName;
      data.followUpLog = [];
      await addDoc(collection(db, "leads"), data);
      toast("Lead created. First follow-up prompt set for " + data.followUpDate + ".");
    }
    $("leadOverlay").classList.add("hidden");
  }catch(err){
    console.error(err);
    toast("Couldn't save this lead — try again.");
  }
};

$("leadDeleteBtn").onclick = async () => {
  if(!editingLeadId) return;
  if(!confirm("Delete this lead permanently? This can't be undone.")) return;
  try{
    await deleteDoc(doc(db, "leads", editingLeadId));
    toast("Lead deleted.");
    $("leadOverlay").classList.add("hidden");
  }catch(err){
    console.error(err);
    toast("Couldn't delete this lead — try again.");
  }
};

$("addFollowUpNoteBtn").onclick = async () => {
  const note = $("f-followUpNote").value.trim();
  if(!note) return;
  const lead = editingLeadId ? leads.find(l => l.id === editingLeadId) : null;
  const attemptNumber = ((lead && lead.followUpCount) || 0) + 1;
  const entry = { date: todayISO(), note, by: currentName, attempt: attemptNumber };
  if(editingLeadId){
    try{
      const update = { followUpLog: arrayUnion(entry), followUpCount: increment(1) };
      // Keep the 3-day cadence going only while the query is still open --
      // once it's Won or Lost there's nothing left to chase.
      const stillOpen = lead && OPEN_STATUSES.includes(lead.leadStatus);
      if(stillOpen) update.followUpDate = addDays(todayISO(), FOLLOWUP_CYCLE_DAYS);
      await updateDoc(doc(db, "leads", editingLeadId), update);
      const log = ((lead && lead.followUpLog) || []).concat([entry]);
      renderFollowUpLog({ followUpLog: log });
      $("f-followUpNote").value = "";
      toast(stillOpen
        ? `Follow-up #${attemptNumber} logged. Next one prompts in ${FOLLOWUP_CYCLE_DAYS} days.`
        : `Follow-up #${attemptNumber} logged.`);
    }catch(err){
      console.error(err);
      toast("Couldn't add that note — try again.");
    }
  }else{
    // Not saved yet -- just hold it locally until Save Lead is clicked, by
    // stashing it as the first log entry via a temp array on the form.
    toast("Save the lead first, then add follow-up notes.");
  }
};

$("addReorderNoteBtn").onclick = async () => {
  const note = $("f-reorderNote").value.trim();
  if(!note || !editingLeadId) return;
  const lead = leads.find(l => l.id === editingLeadId);
  const entry = { date: todayISO(), note, by: currentName };
  try{
    // Every logged contact restarts the clock -- keeps this a genuine
    // routine check-in rather than a one-off reminder.
    const nextDate = addDays(todayISO(), reorderCycleDays);
    await updateDoc(doc(db, "leads", editingLeadId), {
      reorderLog: arrayUnion(entry),
      reorderReminderDate: nextDate
    });
    const log = ((lead && lead.reorderLog) || []).concat([entry]);
    renderReorderLog({ reorderLog: log });
    $("reorderNextDateLabel").textContent = `· Next reminder: ${nextDate}`;
    $("f-reorderNote").value = "";
    toast(`Re-order contact logged. Next check-in prompts ${nextDate}.`);
  }catch(err){
    console.error(err);
    toast("Couldn't log that contact — try again.");
  }
};

// ---------------------------------------------------------------------------
// Bulk import: shared inquiry details + a pasted list of part numbers
// ---------------------------------------------------------------------------
$("bulkImportBtn").onclick = () => {
  $("b-date").value = todayISO();
  $("b-clientType").value = "Domestic";
  $("b-currency").value = "INR";
  $("b-partNumbers").value = "";
  if(currentRole === "sales"){
    $("b-salesPerson").value = currentName;
    $("b-salesPerson").disabled = true;
  }
  updateBulkPreviewCount();
  $("bulkOverlay").classList.remove("hidden");
};
$("bulkCancelBtn").onclick = () => $("bulkOverlay").classList.add("hidden");
autoCurrencyFromCountry("b-country", "b-currency");

function parseBulkLines(){
  return $("b-partNumbers").value.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(",");
    const partNo = (parts[0] || "").trim();
    const qty = parts[1] ? Number(parts[1].trim()) || 1 : 1;
    return { partNo, qty };
  });
}
$("b-partNumbers").addEventListener("input", updateBulkPreviewCount);
function updateBulkPreviewCount(){
  const n = parseBulkLines().length;
  $("bulkPreviewCount").textContent = n
    ? `${n} lead${n === 1 ? "" : "s"} will be created — one per line.`
    : "Paste part numbers above, one per line.";
}

$("bulkSaveBtn").onclick = async () => {
  const lines = parseBulkLines();
  if(!lines.length){ toast("Paste at least one part number first."); return; }
  if(!$("b-client").value.trim()){ toast("Client name is required."); return; }

  const shared = {
    inquiryDate: $("b-date").value,
    clientName: $("b-client").value.trim(),
    clientType: $("b-clientType").value,
    country: $("b-country").value.trim(),
    state: $("b-state").value.trim(),
    city: $("b-city").value.trim(),
    salesPerson: $("b-salesPerson").value,
    leadSource: $("b-leadSource").value,
    quotedCurrency: $("b-currency").value,
    leadStatus: "New", orderStatus: "Pending", leadConsumption: "Active",
    orderCurrency: $("b-currency").value,
    followUpDate: addDays($("b-date").value || todayISO(), FOLLOWUP_CYCLE_DAYS),
    followUpCount: 0
  };
  shared.month = monthKey(shared.inquiryDate);

  try{
    const batch = writeBatch(db);
    lines.forEach(({ partNo, qty }) => {
      const ref = doc(collection(db, "leads"));
      batch.set(ref, {
        ...shared,
        partNo, qty,
        quotedValue: null, quotedValueINR: 0, orderValue: null, orderValueINR: 0,
        remarks: "", followUpLog: [],
        createdAt: serverTimestamp(), createdBy: currentName, updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
    toast(`${lines.length} lead${lines.length === 1 ? "" : "s"} created.`);
    $("bulkOverlay").classList.add("hidden");
  }catch(err){
    console.error(err);
    toast("Bulk import failed — try again, or with fewer lines.");
  }
};

// ---------------------------------------------------------------------------
// Daily Tasks tab
// ---------------------------------------------------------------------------
function renderDailyTasks(){
  const today = todayISO();
  const rows = visibleLeads().filter(l => OPEN_STATUSES.includes(l.leadStatus));

  const dueToday = rows.filter(l => l.followUpDate === today);
  const overdue = rows.filter(l => l.followUpDate && l.followUpDate < today);

  const renderList = (list) => {
    if(!list.length) return "<div class='hint-bar'>Nothing here.</div>";
    return list.map(l => {
      const lastNote = (l.followUpLog && l.followUpLog.length)
        ? l.followUpLog[l.followUpLog.length - 1]
        : null;
      const age = daysSince(l.inquiryDate);
      const ageClass = age >= LEAD_EXPIRY_DAYS - 3 ? "lost" : (age >= FOLLOWUP_CYCLE_DAYS * 2 ? "followup" : "new");
      const nextAttempt = (l.followUpCount || 0) + 1;
      return `
        <div style="padding:0.7rem 0; border-bottom:1px solid var(--line);">
          <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap;">
            <strong>${escapeHtml(l.clientName||"")}</strong>
            <span class="badge ${ageClass}">Day ${age} of ${LEAD_EXPIRY_DAYS} · Follow-up #${nextAttempt}</span>
          </div>
          <div class="hint-bar" style="margin:0.2rem 0;">
            ${escapeHtml(l.salesPerson||"")} · ${escapeHtml(l.partNo||"")} · Follow-up due: ${escapeHtml(l.followUpDate||"—")}
          </div>
          ${lastNote ? `<div style="font-size:0.8rem;">Last done: <em>${escapeHtml(lastNote.note)}</em> (${escapeHtml(lastNote.date)})</div>` : "<div style='font-size:0.8rem; color:var(--rust);'>No follow-up logged yet.</div>"}
          <button class="icon-btn" style="margin-top:0.4rem;" data-action="open-task" data-id="${l.id}">Log Follow-up</button>
        </div>
      `;
    }).join("");
  };

  $("tasksToday").innerHTML = renderList(dueToday);
  $("tasksOverdue").innerHTML = renderList(overdue);

  // Won customers whose re-order check-in is due -- a different list since
  // these are closed deals, not open queries.
  const reorderDue = visibleLeads().filter(l =>
    l.leadStatus === "Won" && l.reorderReminderDate && l.reorderReminderDate <= today
  );
  $("tasksReorder").innerHTML = reorderDue.length ? reorderDue.map(l => {
    const lastContact = (l.reorderLog && l.reorderLog.length) ? l.reorderLog[l.reorderLog.length - 1] : null;
    return `
      <div style="padding:0.7rem 0; border-bottom:1px solid var(--line);">
        <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap;">
          <strong>${escapeHtml(l.clientName||"")}</strong>
          <span class="badge won">Reminder due ${escapeHtml(l.reorderReminderDate||"")}</span>
        </div>
        <div class="hint-bar" style="margin:0.2rem 0;">
          ${escapeHtml(l.salesPerson||"")} · Last order: ${escapeHtml(l.partNo||"")} on ${escapeHtml(l.inquiryDate||"")}
        </div>
        ${lastContact ? `<div style="font-size:0.8rem;">Last check-in: <em>${escapeHtml(lastContact.note)}</em> (${escapeHtml(lastContact.date)})</div>` : "<div style='font-size:0.8rem; color:var(--ink-soft);'>No re-order check-in logged yet.</div>"}
        <button class="icon-btn" style="margin-top:0.4rem;" data-action="open-task" data-id="${l.id}">Log Check-in</button>
      </div>
    `;
  }).join("") : "<div class='hint-bar'>Nothing here.</div>";

  document.querySelectorAll('[data-action="open-task"]').forEach(btn => {
    btn.onclick = () => openLeadModal(btn.dataset.id);
  });
}

// ---------------------------------------------------------------------------
// Manual tasks -- standalone reminders not tied to any lead
// ---------------------------------------------------------------------------
function attachTasksListener(){
  if(tasksUnsub) tasksUnsub();
  // Same reasoning as the leads query: sales reps' security rule only lets
  // them read tasks assigned to themselves, so the query itself needs that
  // constraint or Firestore rejects the whole "list" outright.
  const q = currentRole === "sales"
    ? query(collection(db, "tasks"), where("assignedTo", "==", currentName), orderBy("dueDate", "asc"))
    : query(collection(db, "tasks"), orderBy("dueDate", "asc"));
  tasksUnsub = onSnapshot(q, snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderManualTasks();
    refreshTasksTabBadge();
  }, err => {
    console.error(err);
    toast("Couldn't load tasks — check your connection.");
  });
}

function visibleTasks(){
  if(currentRole === "sales") return tasks.filter(t => t.assignedTo === currentName);
  return tasks;
}

function renderManualTasks(){
  const today = todayISO();
  const open = visibleTasks().filter(t => !t.done).sort((a,b) => (a.dueDate||"").localeCompare(b.dueDate||""));
  if(!open.length){
    $("tasksManual").innerHTML = "<div class='hint-bar'>Nothing here — add one above.</div>";
    return;
  }
  $("tasksManual").innerHTML = open.map(t => {
    const overdue = t.dueDate && t.dueDate < today;
    const dueLabel = t.dueDate === today ? "Today" : (overdue ? `Overdue since ${t.dueDate}` : t.dueDate);
    return `
      <div style="padding:0.7rem 0; border-bottom:1px solid var(--line);">
        <div style="display:flex; justify-content:space-between; gap:0.6rem; flex-wrap:wrap;">
          <strong>${escapeHtml(t.title||"")}</strong>
          <span class="badge ${overdue ? "lost" : "new"}">${escapeHtml(dueLabel||"No date")}</span>
        </div>
        <div class="hint-bar" style="margin:0.2rem 0;">Assigned to ${escapeHtml(t.assignedTo||"")}${t.notes ? " · " + escapeHtml(t.notes) : ""}</div>
        <button class="icon-btn" data-action="task-done" data-id="${t.id}">✓ Mark Done</button>
        ${(currentRole === "master" || currentRole === "manager") ? `<button class="icon-btn" data-action="task-delete" data-id="${t.id}" style="margin-left:0.4rem;">Delete</button>` : ""}
      </div>
    `;
  }).join("");

  $("tasksManual").querySelectorAll('[data-action="task-done"]').forEach(btn => {
    btn.onclick = async () => {
      try{ await updateDoc(doc(db, "tasks", btn.dataset.id), { done: true, doneAt: serverTimestamp() }); }
      catch(err){ console.error(err); toast("Couldn't update that task — try again."); }
    };
  });
  $("tasksManual").querySelectorAll('[data-action="task-delete"]').forEach(btn => {
    btn.onclick = async () => {
      if(!confirm("Delete this task?")) return;
      try{ await deleteDoc(doc(db, "tasks", btn.dataset.id)); }
      catch(err){ console.error(err); toast("Couldn't delete that task — try again."); }
    };
  });
}

$("addTaskBtn").onclick = () => {
  $("t-title").value = "";
  $("t-dueDate").value = todayISO();
  $("t-notes").value = "";
  if(currentRole === "sales") $("t-assignedTo").value = currentName;
  $("taskError").textContent = "";
  $("taskOverlay").classList.remove("hidden");
};
$("taskCancelBtn").onclick = () => $("taskOverlay").classList.add("hidden");

$("taskSaveBtn").onclick = async () => {
  const title = $("t-title").value.trim();
  if(!title){ $("taskError").textContent = "Enter what needs doing."; return; }
  try{
    await addDoc(collection(db, "tasks"), {
      title,
      dueDate: $("t-dueDate").value || todayISO(),
      assignedTo: $("t-assignedTo").value,
      notes: $("t-notes").value.trim(),
      done: false,
      createdBy: currentName,
      createdAt: serverTimestamp()
    });
    toast("Task added.");
    $("taskOverlay").classList.add("hidden");
  }catch(err){
    console.error(err);
    $("taskError").textContent = "Couldn't save that task — try again.";
  }
};

// ---------------------------------------------------------------------------
// Dashboard tab
// ---------------------------------------------------------------------------
$("dashMonth").addEventListener("change", renderDashboard);
function renderDashboard(){
  const month = $("dashMonth").value;
  const rows = visibleLeads().filter(l => !month || monthKey(l.inquiryDate) === month);

  const total = rows.length;
  const quoted = rows.filter(l => l.leadStatus === "Quoted" || l.leadStatus === "Negotiation" || l.leadStatus === "Follow-up").length;
  const won = rows.filter(l => l.leadStatus === "Won").length;
  const lost = rows.filter(l => l.leadStatus === "Lost").length;
  const orderValueINR = rows.filter(l => l.leadStatus === "Won").reduce((s,l) => s + (Number(l.orderValueINR)||0), 0);

  $("statTotal").textContent = total;
  $("statQuoted").textContent = quoted;
  $("statWon").textContent = won;
  $("statLost").textContent = lost;
  $("statOrderValue").textContent = "₹" + orderValueINR.toLocaleString();
}

// ---------------------------------------------------------------------------
// Users tab (master only)
// ---------------------------------------------------------------------------
function attachUsersListener(){
  if(usersUnsub) usersUnsub();
  usersUnsub = onSnapshot(collection(db, "users"), snap => {
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    usersCache = users;
    $("usersBody").innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.name||"")}</td>
        <td>${escapeHtml(u.email||"")}</td>
        <td><span class="role-badge ${u.role}">${escapeHtml(u.role||"")}</span></td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-action="edit-user" data-id="${u.id}">Edit</button>
          ${u.id === currentUser.uid ? "" : `<button class="icon-btn" data-action="remove-user" data-id="${u.id}">Remove Access</button>`}
        </td>
      </tr>
    `).join("");
    $("usersBody").querySelectorAll('[data-action="edit-user"]').forEach(btn => {
      btn.onclick = () => openUserEditModal(btn.dataset.id);
    });
    $("usersBody").querySelectorAll('[data-action="remove-user"]').forEach(btn => {
      btn.onclick = async () => {
        if(!confirm("Remove this person's access to the CRM? (Their login will stop working; this doesn't delete their historical leads.)")) return;
        try{
          await deleteDoc(doc(db, "users", btn.dataset.id));
          toast("Access removed.");
        }catch(err){
          console.error(err);
          toast("Couldn't remove access — try again.");
        }
      };
    });
  });
}

let editingUserId = null;

function openUserEditModal(uid){
  editingUserId = uid;
  const userDoc = usersCache.find(u => u.id === uid);
  if(!userDoc) return;
  $("eu-name").value = userDoc.name || "";
  $("eu-email").value = userDoc.email || "";
  $("eu-role").value = userDoc.role || "sales";
  $("userEditError").textContent = "";
  $("userEditOverlay").classList.remove("hidden");
}
$("userEditCancelBtn").onclick = () => $("userEditOverlay").classList.add("hidden");

$("userEditSaveBtn").onclick = async () => {
  if(!editingUserId) return;
  const name = $("eu-name").value.trim();
  const role = $("eu-role").value;
  if(!name){ $("userEditError").textContent = "Name can't be empty."; return; }
  try{
    await updateDoc(doc(db, "users", editingUserId), { name, role });
    toast("Team member updated.");
    $("userEditOverlay").classList.add("hidden");
  }catch(err){
    console.error(err);
    $("userEditError").textContent = "Couldn't save — try again.";
  }
};

$("sendResetEmailBtn").onclick = async () => {
  const email = $("eu-email").value.trim();
  if(!email) return;
  try{
    await sendPasswordResetEmail(auth, email);
    toast(`Password reset email sent to ${email}.`);
  }catch(err){
    console.error(err);
    $("userEditError").textContent = "Couldn't send that email — check the address is correct.";
  }
};

// Creates a new team member's login WITHOUT signing the master out of their
// own session -- done via a throwaway secondary Firebase app instance.
$("addUserBtn").onclick = async () => {
  const name = $("newUserName").value.trim();
  const email = $("newUserEmail").value.trim();
  const password = $("newUserPassword").value;
  const role = $("newUserRole").value;
  $("userError").textContent = "";

  if(!name || !email || !password){
    $("userError").textContent = "Fill in name, email and a temporary password.";
    return;
  }
  if(password.length < 6){
    $("userError").textContent = "Password needs to be at least 6 characters (Firebase minimum).";
    return;
  }

  const secondaryApp = initializeApp(firebaseConfig, "Secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try{
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);
    await setDoc(doc(db, "users", uid), { name, email, role, createdAt: serverTimestamp() });
    toast(`${name} added as ${role}.`);
    $("newUserName").value = ""; $("newUserEmail").value = ""; $("newUserPassword").value = "";
  }catch(err){
    console.error(err);
    $("userError").textContent = err.code === "auth/email-already-in-use"
      ? "That email already has a login. Ask them to sign in directly, or remove the old entry first."
      : "Couldn't create that login — check the details and try again.";
    try{ await deleteApp(secondaryApp); }catch(e){}
  }
};

// ---------------------------------------------------------------------------
// Settings tab: exchange rates
// ---------------------------------------------------------------------------
async function loadExchangeRates(){
  try{
    const snap = await getDoc(doc(db, "settings", "exchangeRates"));
    if(snap.exists()){
      exchangeRates = snap.data();
      $("rateUSD").value = exchangeRates.USD || "";
      $("rateEUR").value = exchangeRates.EUR || "";
      $("rateRMB").value = exchangeRates.RMB || "";
    }
  }catch(err){ console.error(err); }
  try{
    const snap2 = await getDoc(doc(db, "settings", "reminders"));
    if(snap2.exists() && snap2.data().reorderCycleDays){
      reorderCycleDays = Number(snap2.data().reorderCycleDays);
    }
    $("reorderCycleDaysInput").value = reorderCycleDays;
  }catch(err){ console.error(err); }
}

$("saveRatesBtn").onclick = async () => {
  const rates = {
    USD: Number($("rateUSD").value) || 0,
    EUR: Number($("rateEUR").value) || 0,
    RMB: Number($("rateRMB").value) || 0
  };
  try{
    await setDoc(doc(db, "settings", "exchangeRates"), rates);
    exchangeRates = rates;
    $("ratesSavedMsg").textContent = "Saved.";
    setTimeout(() => $("ratesSavedMsg").textContent = "", 2000);
  }catch(err){
    console.error(err);
    toast("Couldn't save exchange rates — try again.");
  }
};

$("saveReorderBtn").onclick = async () => {
  const days = Number($("reorderCycleDaysInput").value) || 12;
  try{
    await setDoc(doc(db, "settings", "reminders"), { reorderCycleDays: days });
    reorderCycleDays = days;
    $("reorderSavedMsg").textContent = "Saved.";
    setTimeout(() => $("reorderSavedMsg").textContent = "", 2000);
  }catch(err){
    console.error(err);
    toast("Couldn't save that setting — try again.");
  }
};
