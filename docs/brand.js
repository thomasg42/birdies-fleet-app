/**
 * The only shop identity the customer sees on an invoice, an estimate, or a
 * card-payment text. Birdie's Fleet Service is the shop filled in here.
 *
 * Copied from operations/invoice-brand.js (Jay Smith's card facts, PUBLIC,
 * context/product-facts.md, 2026-10-23). Never put a PIN or a Stripe key here.
 */
window.SHOP_BRAND = {
  name: "Birdie's Fleet Service & Backcountry Repair",
  shortName: "Birdie's",
  monogram: "B",
  deskLabel: "Field desk",
  laborLine: "Mobile repair labor",
  phoneDisplay: "435-531-4127",
  phoneTel: "+14355314127",
  tagline: "We come to you.",
  invoiceAccent: "#E8631C",
  invoiceGold: "#C9500F",
  invoiceInk: "#1C1814",
  idPrefix: "BFS",
  backupAppId: "Birdie's Fleet Service",
  backupFilename: "birdies-fleet-service-backup",
  // Logo cropped from his business card photo (2026-10-23). Swap for his
  // original logo file when he sends one.
  logo: "./logo.png",
  // App colors: his blaze orange on dark ink, from the card.
  theme: { accent: "#E8631C", accentLight: "#F5A15F", accentDark: "#C9500F", ink: "#1C1814" },
  // Email + password sign-in. Left blank on purpose so his address is not in
  // public JavaScript; the phone's password manager fills it after the first time.
  signInEmail: ""
};

window.renderInvoiceShop = function renderInvoiceShop() {
  const brand = window.SHOP_BRAND || {};
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const hex = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value) : fallback);
  const phone = String(brand.phoneDisplay || "").trim();
  const tel = /^\+[0-9]{10,15}$/.test(String(brand.phoneTel || "")) ? String(brand.phoneTel) : "";
  const phoneHtml = phone
    ? (tel ? `<br><a href="tel:${tel}">${escapeHtml(phone)}</a>` : `<br>${escapeHtml(phone)}`)
    : "";
  const tagline = String(brand.tagline || "").trim();
  return {
    name: String(brand.name || "Birdie's Fleet Service").trim() || "Birdie's Fleet Service",
    laborLine: String(brand.laborLine || "Mobile mechanic labor").trim() || "Mobile mechanic labor",
    phoneHtml,
    taglineHtml: tagline ? `<br>${escapeHtml(tagline)}` : "",
    accent: hex(brand.invoiceAccent, "#b48624"),
    gold: hex(brand.invoiceGold, "#9d7219"),
    ink: hex(brand.invoiceInk, "#171717")
  };
};

/**
 * A white-label shop can set `logo` (a file next to index.html, e.g.
 * "./logo.png") and `theme` ({ accent, accentLight, accentDark, ink } as
 * #rrggbb). Gold sets neither, so Gold looks exactly as it always has.
 * Runs once at load and again whenever a page redraws its header.
 */
window.applyShopTheme = function applyShopTheme() {
  const brand = window.SHOP_BRAND || {};
  const doc = window.document;
  if (!doc?.documentElement) return;
  const hex = (value) => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value) : "");
  const theme = brand.theme || {};
  const vars = { "--gold": theme.accent, "--gold-light": theme.accentLight, "--gold-dark": theme.accentDark, "--ink": theme.ink };
  for (const [name, value] of Object.entries(vars)) {
    if (hex(value)) doc.documentElement.style.setProperty(name, hex(value));
  }
  const logo = String(brand.logo || "");
  if (!/^\.\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|svg)$/.test(logo) || !doc.querySelectorAll) return;
  doc.querySelectorAll(".brand-mark").forEach((mark) => {
    if (mark.querySelector("img")) return;
    mark.classList.add("has-logo");
    mark.innerHTML = "";
    const img = doc.createElement("img");
    img.src = logo;
    img.alt = "";
    mark.appendChild(img);
  });
};
if (window.document?.readyState === "loading") {
  window.document.addEventListener("DOMContentLoaded", () => window.applyShopTheme());
} else {
  window.applyShopTheme();
}
