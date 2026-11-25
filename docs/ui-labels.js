/* Supplement visible labels with native hover hints, including dynamic controls.
   Titles never replace visible text or accessible names. No data/network access. */
(() => {
  const hints = {
    saveAllButton: "Save changes to the cloud ledger",
    portalLink: "Open the customer invoice portal",
    boardModeJobs: "Show work orders by job",
    boardModeCustomers: "Show every customer's jobs and vehicles",
    newJobButton: "Create a work order and invoice",
    syncButton: "Sync this device with the cloud ledger",
    backupButton: "Download a backup of your records",
    restoreButton: "Restore records from a backup file"
  };
  function label(control) {
    if (!control || control.hasAttribute("title")) return;
    const text = hints[control.id] || control.getAttribute("aria-label") || control.textContent.trim();
    if (text && text.length < 180) control.title = text;
  }
  document.querySelectorAll("button, a, summary").forEach(label);
  for (const event of ["mouseover", "focusin"]) {
    document.addEventListener(event, (e) => label(e.target.closest?.("button, a, summary")));
  }
})();
