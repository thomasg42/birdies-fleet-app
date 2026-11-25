/**
 * Shop extras: the invoice-side features a mobile shop expects on top of the
 * job clock — vehicle inspection, discount, a payments ledger, billing
 * statuses, owner-only profit, an invoice QR, service reminders, and a
 * customer CSV.
 *
 * Written from our own feature list (operations/00-ARI-GAP.md). Nothing here
 * is copied from another product.
 *
 * Pure functions first (tested in tests/shop-extras.test.mjs), markup and
 * event binding after. app.js owns saving and syncing: every change goes back
 * through api.save(job), which is queueJobSync, so the existing cloud merge
 * carries these fields like any other part of the job.
 *
 * Nothing in this file sends a text, an email or a payment request.
 */
(function (root) {
  "use strict";

  const DAY = 86400000;

  // Our own walkaround list for a mobile mechanic. Kept short enough to finish
  // beside a car in a driveway.
  const INSPECTION_ITEMS = [
    ["Engine", ["Engine oil level and condition", "Coolant level and condition", "Drive belts", "Hoses and clamps", "Air filter", "Visible leaks", "Battery and terminals", "Charging system"]],
    ["Brakes and steering", ["Front brake pads", "Rear brakes", "Brake fluid", "Steering and suspension play", "Shocks and struts"]],
    ["Tires", ["Front tires (tread and wear)", "Rear tires (tread and wear)", "Tire pressure", "Spare tire"]],
    ["Fluids and underside", ["Transmission fluid", "Power steering fluid", "Exhaust system", "CV boots and axles"]],
    ["Lights and safety", ["Headlights and taillights", "Turn signals and brake lights", "Wiper blades", "Windshield", "Horn"]]
  ];

  const RATINGS = { good: "Good", fair: "Watch", poor: "Needs work" };

  const BILLING_COPY = {
    unpaid: "Unpaid",
    partial: "Part paid",
    paid: "Paid",
    past_due: "Past due",
    warranty: "Warranty",
    written_off: "Written off",
    void: "Void"
  };

  const FLAGS = ["", "warranty", "written_off", "void"];
  const TERMS = [0, 7, 15, 30];
  const METHODS = ["Cash", "Card", "Check", "Zelle", "Venmo", "Other"];

  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function cents(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n : 0;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const n = cents(value) / 100;
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function parseMoney(value) {
    const n = Number.parseFloat(String(value ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
  }

  // ---------- Inspection ----------

  function blankInspection() {
    const items = [];
    for (const [group, labels] of INSPECTION_ITEMS) {
      for (const label of labels) items.push({ id: slug(label), group, label, rating: "", note: "", photo: "" });
    }
    return { items, updatedAt: "" };
  }

  /** Always the full list, in our order, keeping whatever was already rated. */
  function normalizeInspection(value) {
    const saved = value && typeof value === "object" && Array.isArray(value.items) ? value.items : [];
    const byId = new Map(saved.filter((item) => item && item.id).map((item) => [String(item.id), item]));
    const base = blankInspection();
    base.items = base.items.map((item) => {
      const prior = byId.get(item.id) || {};
      return {
        ...item,
        rating: RATINGS[prior.rating] ? prior.rating : "",
        note: String(prior.note || ""),
        photo: /^data:image\/(jpeg|png|webp);base64,/.test(String(prior.photo || "")) ? String(prior.photo) : ""
      };
    });
    base.updatedAt = value && value.updatedAt ? String(value.updatedAt) : "";
    return base;
  }

  function hasInspection(job) {
    return Boolean(job && job.inspection && Array.isArray(job.inspection.items)
      && job.inspection.items.some((item) => item && item.rating));
  }

  function inspectionSummary(inspection) {
    const out = { good: 0, fair: 0, poor: 0, unrated: 0 };
    for (const item of normalizeInspection(inspection).items) out[item.rating || "unrated"] += 1;
    return out;
  }

  /** Mark every item not yet rated as good. Ratings already set stay. */
  function markAllGood(inspection) {
    const next = normalizeInspection(inspection);
    next.items = next.items.map((item) => (item.rating ? item : { ...item, rating: "good" }));
    return next;
  }

  /**
   * "Needs work" items become estimate lines at $0 for the mechanic to price.
   * Each is tagged with its inspection id so a second tap adds nothing twice.
   * The AI never prices; neither does this.
   */
  function poorItemsToEstimateLines(inspection, existingLines, makeId) {
    const lines = Array.isArray(existingLines) ? existingLines : [];
    const taken = new Set(lines.map((line) => line && line.inspectionId).filter(Boolean));
    return normalizeInspection(inspection).items
      .filter((item) => item.rating === "poor" && !taken.has(item.id))
      .map((item) => ({
        id: makeId(),
        kind: "part",
        description: item.note ? `${item.label}: ${item.note}` : item.label,
        quantity: 1,
        unitCents: 0,
        inspectionId: item.id
      }));
  }

  /** What the customer may see: ratings and notes, never photos or ids. */
  function portalInspection(inspection) {
    if (!inspection) return null;
    const items = normalizeInspection(inspection).items
      .filter((item) => item.rating)
      .map((item) => ({ group: item.group, label: item.label, rating: item.rating, note: item.note }));
    return items.length ? { items } : null;
  }

  // ---------- Discount ----------

  function normalizeDiscount(value) {
    const kind = value && value.kind === "percent" ? "percent" : "amount";
    const raw = Number(value && value.value);
    const amount = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    return { kind, value: kind === "percent" ? Math.min(100, amount) : Math.round(amount) };
  }

  /** Dollars are stored in cents; percent is 0–100. Never more than the subtotal. */
  function discountCents(subtotalCents, discount) {
    const d = normalizeDiscount(discount);
    const base = Math.max(0, cents(subtotalCents));
    const raw = d.kind === "percent" ? Math.round(base * d.value / 100) : d.value;
    return Math.min(base, Math.max(0, raw));
  }

  // ---------- Payments ----------

  function normalizePayments(list) {
    return (Array.isArray(list) ? list : [])
      .filter((p) => p && typeof p === "object" && p.id)
      .map((p) => ({
        id: String(p.id),
        kind: p.kind === "refund" ? "refund" : "payment",
        amountCents: Math.max(0, cents(p.amountCents)),
        method: String(p.method || ""),
        date: String(p.date || ""),
        note: String(p.note || ""),
        voided: Boolean(p.voided)
      }));
  }

  /**
   * startingBalance is what the filed invoice says is due (total minus any
   * deposit). Payments lower it, refunds raise it. Voided rows stay as
   * tombstones so a sync from another phone cannot bring them back.
   */
  function paymentSummary(startingBalanceCents, payments) {
    let paid = 0;
    let refunded = 0;
    for (const p of normalizePayments(payments)) {
      if (p.voided) continue;
      if (p.kind === "refund") refunded += p.amountCents;
      else paid += p.amountCents;
    }
    const start = Math.max(0, cents(startingBalanceCents));
    return { paidCents: paid, refundedCents: refunded, balanceCents: Math.max(0, start - paid + refunded), creditCents: Math.max(0, paid - refunded - start) };
  }

  function invoiceBalance(job) {
    if (!job || !job.invoice) return null;
    const start = job.invoice.balanceDueCents ?? job.invoice.totalCents ?? 0;
    return paymentSummary(start, job.payments);
  }

  // ---------- Billing status ----------

  function dueDate(job) {
    if (!job || !job.invoice || !job.invoice.createdAt) return null;
    const created = Date.parse(job.invoice.createdAt);
    if (!Number.isFinite(created)) return null;
    const terms = TERMS.includes(Number(job.termsDays)) ? Number(job.termsDays) : 0;
    return new Date(created + terms * DAY);
  }

  /** "" for a job with no filed invoice. A manual flag beats everything. */
  function billingState(job, now = Date.now()) {
    if (!job || job.status !== "invoiced" || !job.invoice) return "";
    if (FLAGS.includes(job.billingFlag) && job.billingFlag) return job.billingFlag;
    const sum = invoiceBalance(job);
    if (sum.balanceCents === 0) return "paid";
    const due = dueDate(job);
    // Past due from the day after the due date, so "due on receipt" is not
    // past due the same afternoon it was filed.
    if (due && now >= due.getTime() + DAY) return "past_due";
    return sum.paidCents > sum.refundedCents ? "partial" : "unpaid";
  }

  function matchesFilter(job, filter, now = Date.now()) {
    if (!filter || filter === "all") return true;
    const state = billingState(job, now);
    if (filter === "unpaid") return state === "unpaid" || state === "partial" || state === "past_due";
    return state === filter;
  }

  // ---------- Profit (owner only, never the portal) ----------

  function profitFigures(job, figures) {
    const source = figures || (job && job.invoice) || {};
    const beforeTax = Math.max(0, cents(source.totalCents) - cents(source.taxCents));
    const partsCost = Math.max(0, cents(source.materialsCents));
    return { beforeTaxCents: beforeTax, partsCostCents: partsCost, keptCents: beforeTax - partsCost };
  }

  // ---------- QR ----------

  /** An SVG QR code made on the phone. No outside service sees the link. */
  function qrSvg(text, size = 132) {
    const Model = root.QRCodeModel;
    const Level = root.QRErrorCorrectLevel;
    if (!Model || !Level || !text) return "";
    const qr = new Model(-1, Level.M);
    qr.addData(String(text));
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4;
    const total = count + quiet * 2;
    let path = "";
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for this invoice"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  // ---------- Service reminders ----------

  function normalizeReminders(list) {
    return (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r === "object" && r.id)
      .map((r) => ({
        id: String(r.id),
        label: String(r.label || "").trim(),
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(r.dueDate || "")) ? String(r.dueDate) : "",
        dueMiles: Number.isFinite(Number(r.dueMiles)) && Number(r.dueMiles) > 0 ? Math.round(Number(r.dueMiles)) : 0,
        done: Boolean(r.done),
        voided: Boolean(r.voided)
      }));
  }

  /**
   * Every open reminder across live jobs, soonest first. Overdue and due
   * within the horizon come first; mileage-only reminders follow, since the
   * phone cannot know today's odometer.
   */
  function remindersDue(jobs, now = Date.now(), horizonDays = 30) {
    const out = [];
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (!job || job.archived) continue;
      for (const r of normalizeReminders(job.serviceReminders)) {
        if (r.done || r.voided || !r.label) continue;
        const time = r.dueDate ? Date.parse(`${r.dueDate}T12:00:00`) : NaN;
        if (Number.isFinite(time) && time > now + horizonDays * DAY) continue;
        out.push({ ...r, jobId: job.id, customerName: String(job.customerName || ""), overdue: Number.isFinite(time) && time < now, time: Number.isFinite(time) ? time : Infinity });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  // ---------- Customer CSV ----------

  function csvCell(value) {
    let text = String(value ?? "");
    // A cell starting with = + - @ runs as a formula in a spreadsheet.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function customersCsv(groups, jobsById = {}) {
    const rows = [["Customer", "Phones", "Vehicles", "Jobs", "Invoiced total", "Balance owed"]];
    for (const g of Array.isArray(groups) ? groups : []) {
      let invoiced = 0;
      let owed = 0;
      for (const ref of g.jobs || []) {
        const job = jobsById[ref.id] || ref;
        if (job.status !== "invoiced" || !job.invoice || job.billingFlag === "void") continue;
        invoiced += cents(job.invoice.totalCents);
        if (!job.billingFlag) owed += invoiceBalance(job).balanceCents;
      }
      rows.push([g.name, (g.phones || []).join(" / "), (g.vehicles || []).join(" / "), (g.jobs || []).length, (invoiced / 100).toFixed(2), (owed / 100).toFixed(2)]);
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  // ---------- Photos ----------

  /** Shrinks a phone photo to a small JPEG so it can ride inside the job. */
  function shrinkPhoto(file, max = 640, quality = 0.6) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That photo could not be read."));
      };
      img.src = url;
    });
  }


  // ---------- Text the invoice ----------

  /**
   * An sms: link that opens the phone's own Messages app with the text
   * written. The owner presses send himself; nothing is sent from here.
   */
  function smsHref(phone, body) {
    let digits = String(phone || "").replace(/[^0-9]/g, "");
    if (digits.length === 10) digits = `1${digits}`;
    const to = digits.length === 11 ? `+${digits}` : "";
    return `sms:${to}?&body=${encodeURIComponent(String(body || ""))}`;
  }

  /** The card link only counts while it is for exactly what is still owed. */
  function payNowUrl(job) {
    const link = job && job.paymentLink;
    if (!link || !/^https:\/\/(buy|checkout)\.stripe\.com\//.test(String(link.url || ""))) return "";
    if (job.billingFlag === "void") return "";
    const sum = invoiceBalance(job);
    if (!sum || !sum.balanceCents) return "";
    return cents(link.invoiceCents) === sum.balanceCents ? String(link.url) : "";
  }

  function invoiceTextBody(job, shopName, portalLink) {
    const first = String(job.customerName || "").trim().split(/\s+/)[0] || "there";
    const sum = invoiceBalance(job);
    const car = [job.vehicleYear, job.vehicleMake, job.vehicleModel].filter(Boolean).join(" ");
    const lines = [`Hi ${first}, this is ${shopName}. Your invoice${car ? ` for the ${car}` : ""} is ready.`];
    if (sum) lines.push(sum.balanceCents ? `Balance due: ${money(sum.balanceCents)}.` : "It's paid in full. Thank you!");
    if (portalLink) lines.push(`View it here: ${portalLink}`);
    const pay = payNowUrl(job);
    if (pay) lines.push(`Pay by card: ${pay}`);
    return lines.join("\n");
  }

  // ---------- Fleet view ----------

  /** One customer's trucks and what they owe across every filed invoice. */
  function fleetSummary(jobs) {
    const units = [];
    const seen = new Set();
    let owed = 0;
    let invoiced = 0;
    let open = 0;
    for (const job of Array.isArray(jobs) ? jobs : []) {
      const car = [job.vehicleYear, job.vehicleMake, job.vehicleModel].filter(Boolean).join(" ");
      const label = [job.vehicleUnit ? `Unit ${job.vehicleUnit}` : "", car, job.vehiclePlate || ""].filter(Boolean).join(" · ");
      const key = String(job.vehicleUnit || job.vehiclePlate || car).toLowerCase();
      if (label && key && !seen.has(key)) {
        seen.add(key);
        units.push(label);
      }
      if (job.status === "invoiced" && job.invoice && job.billingFlag !== "void") {
        invoiced += cents(job.invoice.totalCents);
        if (!job.billingFlag) {
          const due = invoiceBalance(job).balanceCents;
          owed += due;
          if (due) open += 1;
        }
      }
    }
    return { units, owedCents: owed, invoicedCents: invoiced, openInvoices: open };
  }

  /** A one-page printable statement: every filed invoice and what is left. */
  function statementHtml(name, jobs, shop, now = Date.now()) {
    const rows = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job.status === "invoiced" && job.invoice && job.billingFlag !== "void")
      .sort((a, b) => String(a.invoice.createdAt).localeCompare(String(b.invoice.createdAt)));
    const sum = fleetSummary(rows);
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(shop.accent || "")) ? shop.accent : "#171717";
    const date = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
    const body = rows.map((job) => {
      const bal = job.billingFlag ? 0 : invoiceBalance(job).balanceCents;
      const car = [job.vehicleUnit ? `Unit ${job.vehicleUnit}` : "", [job.vehicleYear, job.vehicleMake, job.vehicleModel].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
      return `<tr><td>${escapeHtml(date(job.invoice.createdAt))}</td><td>${escapeHtml(job.invoice.invoiceNumber || job.id)}</td><td>${escapeHtml(car)}</td><td>${money(job.invoice.totalCents)}</td><td>${job.billingFlag ? escapeHtml(BILLING_COPY[job.billingFlag]) : money(bal)}</td></tr>`;
    }).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Statement — ${escapeHtml(name)}</title>
<style>body{margin:0;padding:32px;font:14px/1.5 Arial,sans-serif;color:#171717}main{max-width:820px;margin:0 auto}header{border-bottom:4px solid ${accent};padding-bottom:16px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}h1{margin:0}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{border-bottom:1px solid #ddd;padding:10px 6px;text-align:left}th:nth-child(n+4),td:nth-child(n+4){text-align:right}.owed{font-size:22px;font-weight:800;text-align:right}@media print{body{padding:0}}</style></head>
<body><main><header><div><strong>${escapeHtml(shop.name || "")}</strong>${shop.phoneHtml || ""}<h1>Statement</h1></div><div>${escapeHtml(name)}<br>${escapeHtml(date(new Date(now).toISOString()))}</div></header>
<table><thead><tr><th>Date</th><th>Invoice</th><th>Vehicle</th><th>Total</th><th>Still owed</th></tr></thead><tbody>${body || `<tr><td colspan="5">No filed invoices.</td></tr>`}</tbody></table>
<p class="owed">Total owed: ${money(sum.owedCents)}</p></main></body></html>`;
  }

  function fleetBlock(groupId, jobs) {
    const sum = fleetSummary(jobs);
    return `
      ${sum.units.length ? `<div class="fleet-units">${sum.units.map((u) => `<span>${escapeHtml(u)}</span>`).join("")}</div>` : ""}
      <div class="fleet-owed">
        <span>${sum.owedCents ? `<strong>${money(sum.owedCents)} owed</strong> on ${sum.openInvoices} invoice${sum.openInvoices === 1 ? "" : "s"}` : "Nothing owed"} · ${money(sum.invoicedCents)} billed</span>
        <button type="button" class="button button-quiet button-compact" data-statement="${escapeHtml(groupId)}">Statement</button>
      </div>`;
  }

  // ---------- Markup ----------

  function inspectionCard(job, locked) {
    const inspection = normalizeInspection(job.inspection);
    const sum = inspectionSummary(inspection);
    const groups = INSPECTION_ITEMS.map(([group]) => {
      const rows = inspection.items.filter((item) => item.group === group).map((item) => `
        <div class="inspect-row" data-inspect-id="${escapeHtml(item.id)}">
          <div class="inspect-label">${escapeHtml(item.label)}</div>
          <div class="inspect-choice" role="group" aria-label="${escapeHtml(item.label)}">
            ${Object.entries(RATINGS).map(([key, text]) => `<button type="button" class="inspect-pill inspect-${key}${item.rating === key ? " is-on" : ""}" data-inspect-rate="${key}" aria-pressed="${item.rating === key}" ${locked ? "disabled" : ""}>${text}</button>`).join("")}
          </div>
          ${locked
            ? (item.note ? `<p class="inspect-note-read">${escapeHtml(item.note)}</p>` : "")
            : `<input class="inspect-note" data-inspect-note value="${escapeHtml(item.note)}" placeholder="Note (optional)" aria-label="Note for ${escapeHtml(item.label)}">`}
          <div class="inspect-photo">
            ${item.photo ? `<img src="${item.photo}" alt="Photo of ${escapeHtml(item.label)}">` : ""}
            ${locked ? "" : `<label class="text-button inspect-photo-add">${item.photo ? "Replace photo" : "+ Photo"}<input type="file" accept="image/*" capture="environment" data-inspect-photo hidden></label>
              ${item.photo ? `<button type="button" class="text-button" data-inspect-photo-clear>Remove</button>` : ""}`}
          </div>
        </div>`).join("");
      return `<details class="inspect-group" ${rows.includes("is-on") ? "" : "open"}><summary>${escapeHtml(group)}</summary>${rows}</details>`;
    }).join("");
    return `
      <article class="content-card" id="inspectionCard">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Vehicle inspection</p>
            <h2>Walkaround checklist</h2>
            <p>${sum.good} good · ${sum.fair} watch · ${sum.poor} need work · ${sum.unrated} not checked. The customer sees ratings and notes on their link, not photos.</p>
          </div>
        </div>
        ${locked ? "" : `<div class="save-row">
          <button class="button button-quiet" type="button" data-inspect-all-good>Mark the rest good</button>
          <button class="button button-quiet" type="button" data-inspect-to-estimate ${sum.poor ? "" : "disabled"}>Add "needs work" to estimate</button>
        </div>`}
        ${groups}
      </article>`;
  }

  function vehicleExtrasFields(job) {
    return `
      <label class="field"><span>Odometer</span><input data-job-field="vehicleOdometer" inputmode="numeric" value="${escapeHtml(job.vehicleOdometer || "")}" placeholder="84,210"></label>
      <label class="field"><span>Unit #</span><input data-job-field="vehicleUnit" value="${escapeHtml(job.vehicleUnit || "")}" placeholder="Fleet unit"></label>`;
  }

  function vehicleExtrasReadout(job) {
    return `
      <div class="readout-row"><span class="detail-label">Odometer</span><strong>${escapeHtml(job.vehicleOdometer || "Not entered")}</strong></div>
      ${job.vehicleUnit ? `<div class="readout-row"><span class="detail-label">Unit #</span><strong>${escapeHtml(job.vehicleUnit)}</strong></div>` : ""}`;
  }

  function discountFields(job) {
    const d = normalizeDiscount(job.discount);
    const shown = d.kind === "percent" ? (d.value || "") : (d.value ? (d.value / 100).toFixed(2) : "");
    return `
      <label class="field"><span>Discount</span>
        <span class="money-input discount-input">
          <input id="discountValueInput" inputmode="decimal" value="${escapeHtml(String(shown))}" placeholder="0">
          <select id="discountKindSelect" aria-label="Discount in dollars or percent">
            <option value="amount" ${d.kind === "amount" ? "selected" : ""}>$</option>
            <option value="percent" ${d.kind === "percent" ? "selected" : ""}>%</option>
          </select>
        </span>
      </label>`;
  }

  function readDiscount() {
    const input = document.getElementById("discountValueInput");
    const kind = document.getElementById("discountKindSelect");
    if (!input || !kind) return null;
    const value = kind.value === "percent"
      ? Math.min(100, Math.max(0, Number.parseFloat(input.value || "0") || 0))
      : parseMoney(input.value);
    return { kind: kind.value === "percent" ? "percent" : "amount", value };
  }

  function profitBlock(job, figures) {
    const p = profitFigures(job, figures);
    return `
      <details class="profit-toggle">
        <summary>Owner view: what you keep</summary>
        <div class="invoice-meta">
          <span>Billed before tax · ${money(p.beforeTaxCents)}</span>
          <span>Parts you paid (receipts) · ${money(p.partsCostCents)}</span>
        </div>
        <div class="invoice-total"><span>Kept after parts</span><strong>${money(p.keptCents)}</strong></div>
        <p class="time-edit-note">Never shown to the customer. Parts priced on the estimate have no cost entered, so they count as kept.</p>
      </details>`;
  }

  function paymentsCard(job, now = Date.now()) {
    if (job.status !== "invoiced" || !job.invoice) return "";
    const sum = invoiceBalance(job);
    const state = billingState(job, now);
    const due = dueDate(job);
    const rows = normalizePayments(job.payments).filter((p) => !p.voided);
    const today = new Date(now).toISOString().slice(0, 10);
    return `
      <article class="content-card" id="paymentsCard">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Payments</p>
            <h2>${money(sum.balanceCents)} owed</h2>
            <p>${due ? `Due ${due.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""} · ${money(sum.paidCents)} paid${sum.refundedCents ? ` · ${money(sum.refundedCents)} refunded` : ""}${sum.creditCents ? ` · ${money(sum.creditCents)} overpaid` : ""}</p>
          </div>
          <span class="status-pill billing-${escapeHtml(state)}">${escapeHtml(BILLING_COPY[state] || "")}</span>
        </div>
        ${rows.length ? `<ul class="payment-list">${rows.map((p) => `
          <li><span>${escapeHtml(p.date)} · ${p.kind === "refund" ? "Refund" : escapeHtml(p.method || "Payment")}${p.note ? ` · ${escapeHtml(p.note)}` : ""}</span>
            <strong>${p.kind === "refund" ? "+" : "−"}${money(p.amountCents)}</strong>
            <button type="button" class="text-button" data-payment-void="${escapeHtml(p.id)}" aria-label="Remove this entry">Remove</button></li>`).join("")}</ul>` : `<p class="time-edit-note">No payments recorded yet.</p>`}
        <div class="form-grid payment-form">
          <label class="field"><span>Amount</span><span class="money-input"><b>$</b><input id="paymentAmountInput" inputmode="decimal" placeholder="${(sum.balanceCents / 100).toFixed(2)}"></span></label>
          <label class="field"><span>Method</span><select id="paymentMethodSelect">${METHODS.map((m) => `<option>${m}</option>`).join("")}</select></label>
          <label class="field"><span>Date</span><input id="paymentDateInput" type="date" value="${today}"></label>
          <label class="field"><span>Note</span><input id="paymentNoteInput" placeholder="Check #, last 4…"></label>
        </div>
        <div class="save-row">
          <button class="button button-gold" type="button" data-payment-add="payment">Record payment</button>
          <button class="button button-quiet" type="button" data-payment-mark-paid ${sum.balanceCents ? "" : "disabled"}>Paid in full</button>
          <button class="button button-quiet" type="button" data-payment-add="refund">Record refund</button>
        </div>
        <div class="form-grid">
          <label class="field"><span>Terms</span><select id="termsSelect">${TERMS.map((t) => `<option value="${t}" ${Number(job.termsDays || 0) === t ? "selected" : ""}>${t ? `Net ${t}` : "Due on receipt"}</option>`).join("")}</select></label>
          <label class="field"><span>Mark as</span><select id="billingFlagSelect">${FLAGS.map((f) => `<option value="${f}" ${String(job.billingFlag || "") === f ? "selected" : ""}>${f ? BILLING_COPY[f] : "Normal"}</option>`).join("")}</select></label>
        </div>
        <p class="time-edit-note">This records money you already received. It does not charge a card or message anyone.</p>
        ${profitBlock(job)}
      </article>`;
  }

  function remindersCard(job) {
    const list = normalizeReminders(job.serviceReminders).filter((r) => !r.voided);
    return `
      <article class="content-card" id="remindersCard">
        <div class="card-heading">
          <div>
            <p class="eyebrow">Next service</p>
            <h2>Service reminders</h2>
            <p>Shows on your job board when it comes due. Nothing is sent to the customer.</p>
          </div>
        </div>
        ${list.length ? `<ul class="reminder-list">${list.map((r) => `
          <li class="${r.done ? "is-done" : ""}"><span>${escapeHtml(r.label)}${r.dueDate ? ` · ${escapeHtml(r.dueDate)}` : ""}${r.dueMiles ? ` · ${r.dueMiles.toLocaleString("en-US")} mi` : ""}</span>
            <button type="button" class="text-button" data-reminder-done="${escapeHtml(r.id)}">${r.done ? "Reopen" : "Done"}</button>
            <button type="button" class="text-button" data-reminder-void="${escapeHtml(r.id)}">Remove</button></li>`).join("")}</ul>` : ""}
        <div class="form-grid">
          <label class="field field-wide"><span>What's due</span><input id="reminderLabelInput" placeholder="Oil change"></label>
          <label class="field"><span>Date</span><input id="reminderDateInput" type="date"></label>
          <label class="field"><span>Or at miles</span><input id="reminderMilesInput" inputmode="numeric" placeholder="90,000"></label>
        </div>
        <div class="save-row"><button class="button button-quiet" type="button" data-reminder-add>Add reminder</button></div>
      </article>`;
  }

  function boardRemindersPanel(jobs, now = Date.now()) {
    const due = remindersDue(jobs, now);
    if (!due.length) return "";
    return `
      <section class="reminder-board" aria-label="Service coming due">
        <p class="eyebrow">Service coming due</p>
        ${due.slice(0, 8).map((r) => `
          <button type="button" class="reminder-chip${r.overdue ? " is-overdue" : ""}" data-job-id="${escapeHtml(r.jobId)}">
            <strong>${escapeHtml(r.customerName || "Customer")}</strong> · ${escapeHtml(r.label)}${r.dueDate ? ` · ${escapeHtml(r.dueDate)}` : ""}${r.dueMiles ? ` · ${r.dueMiles.toLocaleString("en-US")} mi` : ""}
          </button>`).join("")}
      </section>`;
  }

  function billingFilterChips(active) {
    const options = [["all", "All"], ["unpaid", "Owed"], ["past_due", "Past due"], ["paid", "Paid"]];
    return `<div class="billing-filter" role="group" aria-label="Filter by payment">${options.map(([key, text]) =>
      `<button type="button" class="board-mode${(active || "all") === key ? " is-active" : ""}" data-billing-filter="${key}" aria-pressed="${(active || "all") === key}">${text}</button>`).join("")}</div>`;
  }

  function billingPill(job, now = Date.now()) {
    const state = billingState(job, now);
    return state ? `<span class="status-pill billing-${escapeHtml(state)}">${escapeHtml(BILLING_COPY[state])}</span>` : "";
  }

  // ---------- Printed invoice pieces ----------

  function invoiceInspectionHtml(job) {
    const view = portalInspection(job.inspection);
    if (!view) return "";
    const flagged = view.items.filter((item) => item.rating !== "good");
    const goodCount = view.items.length - flagged.length;
    return `<div class="notes box"><span class="eyebrow">Inspection</span>
      <p>${goodCount} item${goodCount === 1 ? "" : "s"} checked good.</p>
      ${flagged.length ? `<ul>${flagged.map((item) => `<li><strong>${escapeHtml(RATINGS[item.rating])}:</strong> ${escapeHtml(item.label)}${item.note ? ` — ${escapeHtml(item.note)}` : ""}</li>`).join("")}</ul>` : ""}</div>`;
  }

  function invoicePaymentsHtml(job) {
    const rows = normalizePayments(job.payments).filter((p) => !p.voided);
    if (!rows.length) return "";
    const sum = invoiceBalance(job);
    return `${rows.map((p) => `<div><span>${p.kind === "refund" ? "Refund" : `Paid ${escapeHtml(p.method)}`} ${escapeHtml(p.date)}</span><strong>${p.kind === "refund" ? "+" : "−"}${money(p.amountCents)}</strong></div>`).join("")}
      <div class="total"><span>Now owed</span><span>${money(sum.balanceCents)}</span></div>`;
  }

  function invoiceQrHtml(link) {
    const svg = link ? qrSvg(link, 112) : "";
    return svg ? `<div class="qr">${svg}<small>Scan to view online</small></div>` : "";
  }

  // ---------- Binding ----------

  function bind(rootEl, job, api) {
    if (!rootEl || !job) return;
    const save = (rerender = true) => {
      api.save(job);
      if (rerender) api.rerender();
    };

    const card = rootEl.querySelector("#inspectionCard");
    if (card) {
      const update = (id, patch) => {
        const next = normalizeInspection(job.inspection);
        next.items = next.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
        next.updatedAt = new Date().toISOString();
        job.inspection = next;
      };
      card.addEventListener("click", (event) => {
        const rate = event.target.closest("[data-inspect-rate]");
        if (rate) {
          const id = rate.closest("[data-inspect-id]").dataset.inspectId;
          const current = normalizeInspection(job.inspection).items.find((item) => item.id === id);
          update(id, { rating: current && current.rating === rate.dataset.inspectRate ? "" : rate.dataset.inspectRate });
          save();
          return;
        }
        if (event.target.closest("[data-inspect-photo-clear]")) {
          update(event.target.closest("[data-inspect-id]").dataset.inspectId, { photo: "" });
          save();
          return;
        }
        if (event.target.closest("[data-inspect-all-good]")) {
          job.inspection = { ...markAllGood(job.inspection), updatedAt: new Date().toISOString() };
          save();
          return;
        }
        if (event.target.closest("[data-inspect-to-estimate]")) {
          const added = api.addEstimateLines(job, (existing) => poorItemsToEstimateLines(job.inspection, existing, api.uid));
          api.notify(added ? `Added ${added} line${added === 1 ? "" : "s"} to the estimate at $0. Price them before sending.` : "Those items are already on the estimate.");
          if (added) save();
        }
      });
      card.addEventListener("change", async (event) => {
        const row = event.target.closest("[data-inspect-id]");
        if (!row) return;
        if (event.target.matches("[data-inspect-note]")) {
          update(row.dataset.inspectId, { note: event.target.value.trim() });
          save(false);
          return;
        }
        if (event.target.matches("[data-inspect-photo]") && event.target.files && event.target.files[0]) {
          try {
            update(row.dataset.inspectId, { photo: await shrinkPhoto(event.target.files[0]) });
            save();
          } catch (error) {
            api.notify(error.message, true);
          }
        }
      });
    }

    const pay = rootEl.querySelector("#paymentsCard");
    if (pay) {
      pay.addEventListener("click", (event) => {
        const add = event.target.closest("[data-payment-add]");
        const full = event.target.closest("[data-payment-mark-paid]");
        const remove = event.target.closest("[data-payment-void]");
        if (remove) {
          job.payments = normalizePayments(job.payments).map((p) => (p.id === remove.dataset.paymentVoid ? { ...p, voided: true } : p));
          save();
          return;
        }
        if (!add && !full) return;
        const balance = invoiceBalance(job).balanceCents;
        const typed = parseMoney(rootEl.querySelector("#paymentAmountInput").value);
        const amount = full ? balance : typed;
        if (!amount) {
          api.notify("Enter the amount first.", true);
          return;
        }
        job.payments = [...normalizePayments(job.payments), {
          id: api.uid(),
          kind: add && add.dataset.paymentAdd === "refund" ? "refund" : "payment",
          amountCents: amount,
          method: rootEl.querySelector("#paymentMethodSelect").value,
          date: rootEl.querySelector("#paymentDateInput").value || new Date().toISOString().slice(0, 10),
          note: rootEl.querySelector("#paymentNoteInput").value.trim(),
          voided: false
        }];
        save();
        api.notify(`${money(amount)} recorded.`);
      });
      pay.addEventListener("change", (event) => {
        if (event.target.id === "termsSelect") {
          job.termsDays = Number(event.target.value) || 0;
          save();
        } else if (event.target.id === "billingFlagSelect") {
          job.billingFlag = FLAGS.includes(event.target.value) ? event.target.value : "";
          save();
        }
      });
    }

    const rem = rootEl.querySelector("#remindersCard");
    if (rem) {
      rem.addEventListener("click", (event) => {
        const done = event.target.closest("[data-reminder-done]");
        const remove = event.target.closest("[data-reminder-void]");
        if (done || remove) {
          const id = (done || remove).dataset[done ? "reminderDone" : "reminderVoid"];
          job.serviceReminders = normalizeReminders(job.serviceReminders).map((r) => (r.id !== id ? r : done ? { ...r, done: !r.done } : { ...r, voided: true }));
          save();
          return;
        }
        if (!event.target.closest("[data-reminder-add]")) return;
        const label = rem.querySelector("#reminderLabelInput").value.trim();
        const dueDateValue = rem.querySelector("#reminderDateInput").value;
        const miles = Number(String(rem.querySelector("#reminderMilesInput").value).replace(/[^0-9]/g, ""));
        if (!label || (!dueDateValue && !miles)) {
          api.notify("Say what's due and when (a date or miles).", true);
          return;
        }
        job.serviceReminders = [...normalizeReminders(job.serviceReminders), { id: api.uid(), label, dueDate: dueDateValue, dueMiles: miles || 0, done: false, voided: false }];
        save();
      });
    }
  }

  root.ShopExtras = {
    INSPECTION_ITEMS, RATINGS, BILLING_COPY, TERMS, FLAGS,
    normalizeInspection, hasInspection, inspectionSummary, markAllGood, poorItemsToEstimateLines, portalInspection,
    normalizeDiscount, discountCents, readDiscount,
    normalizePayments, paymentSummary, invoiceBalance,
    dueDate, billingState, matchesFilter,
    profitFigures, qrSvg,
    normalizeReminders, remindersDue,
    customersCsv,
    smsHref, payNowUrl, invoiceTextBody, fleetSummary, statementHtml, fleetBlock,
    inspectionCard, vehicleExtrasFields, vehicleExtrasReadout, discountFields, profitBlock,
    paymentsCard, remindersCard, boardRemindersPanel, billingFilterChips, billingPill,
    invoiceInspectionHtml, invoicePaymentsHtml, invoiceQrHtml,
    bind
  };
})(typeof window !== "undefined" ? window : globalThis);
