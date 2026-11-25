/**
 * Device pairing for the operator app.
 *
 * The sync API holds every customer's name, phone, cost basis, clock ledger
 * and receipt photos. For six weeks it held them behind nothing at all: the
 * Worker URL ships in this repository's JavaScript, and `GET /api/jobs`
 * answered anyone who asked. The PIN gate that used to sit there was removed
 * on 2026-07-31 as "low-stakes" — which it was, on a database with no real
 * customers in it. It has real customers in it now.
 *
 * The shape here is deliberate, because the first version of this was removed
 * for being annoying rather than for being wrong:
 *
 *   Thomas types six digits ONCE per phone. That is the whole ceremony.
 *
 * The PIN itself never becomes the API credential. It is exchanged at
 * `/api/pair` for a device token — an HMAC of a random per-device id under the
 * PIN — and the token is what every later request carries. So the thing sent a
 * hundred times a day is 256 bits of signature that cannot be guessed, while
 * the thing a human has to remember stays six digits. Brute force only buys
 * anything at `/api/pair`, which is rate-limited to a handful of tries an hour.
 *
 * The token is a bearer credential and lives in this phone's localStorage.
 * That is the same trust level as being logged in: whoever holds the unlocked
 * phone is the operator. Losing a phone means rotating the PIN, which
 * invalidates every paired device at once — see the README.
 */
(() => {
  "use strict";

  const SYNC_API = "https://birdies-fleet-service-sync.forevergoldai.workers.dev";
  const DEVICE_STORAGE = "bfs-device-id";
  const TOKEN_STORAGE = "bfs-sync-token";

  /** Set once he cancels the prompt, so a queue flush cannot nag him per item. */
  let declined = false;
  /** Single-flight: ten queued uploads hitting 401 together must ask once. */
  let pairing = null;

  // A phone signed in with "stay signed in" off keeps its token for this
  // browser session only.
  function sessionRead(key) {
    try {
      return window.sessionStorage?.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function read(key) {
    try {
      return window.localStorage.getItem(key) || (key === TOKEN_STORAGE ? sessionRead(key) : "");
    } catch {
      // Private-mode Safari throws on access rather than returning null.
      return "";
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* Unpaired every launch is survivable; a crash here is not. */
    }
  }

  /** Stable, random, and meaningless on its own — it only names this phone. */
  function deviceId() {
    let id = read(DEVICE_STORAGE);
    if (id) return id;
    id = (window.crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .replace(/[^A-Za-z0-9-]/g, "");
    write(DEVICE_STORAGE, id);
    return id;
  }

  const token = () => read(TOKEN_STORAGE);
  const isPaired = () => Boolean(token());

  function clear() {
    write(TOKEN_STORAGE, "");
    try { window.sessionStorage?.removeItem(TOKEN_STORAGE); } catch { /* nothing to clear */ }
  }

  function keepToken(value, stay) {
    if (stay) {
      write(TOKEN_STORAGE, value);
      return;
    }
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE, value);
    } catch {
      write(TOKEN_STORAGE, value);
    }
  }

  /**
   * The shop's own sign-in card, in its name and colors: PIN, "stay signed in
   * on this phone" (on by default), Sign in. Resolves with { pin, stay } or
   * null when closed. Falls back to the browser prompt where there is no DOM.
   */
  function askForPin(shopName, message = "") {
    const doc = window.document;
    if (!doc?.createElement || !doc.body) {
      const pin = window.prompt(`Enter your ${shopName} PIN to sign in on this phone.`);
      return Promise.resolve(pin === null ? null : { pin, stay: true });
    }
    doc.getElementById("signInOverlay")?.remove();
    const brand = window.SHOP_BRAND || {};
    const overlay = doc.createElement("div");
    overlay.id = "signInOverlay";
    overlay.className = "sign-in-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "signInTitle");
    // A shop that signs in with email sets `signInEmail` in brand.js; its Worker
    // checks OWNER_EMAIL alongside the password. Gold keeps the PIN card.
    const emailLogin = typeof brand.signInEmail === "string";
    const logo = /^\.\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|svg)$/.test(String(brand.logo || "")) ? String(brand.logo) : "";
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(brand.invoiceAccent || "")) ? brand.invoiceAccent : "";
    if (accent) overlay.style.setProperty("--sign-in-accent", accent);
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    overlay.innerHTML = `
      <form class="sign-in-card" id="signInForm" novalidate>
        ${logo
          ? `<span class="sign-in-mark has-logo" aria-hidden="true"><img src="${esc(logo)}" alt=""></span>`
          : `<span class="sign-in-mark" aria-hidden="true">${esc(String(brand.monogram || shopName.slice(0, 1)).slice(0, 2))}</span>`}
        <h2 id="signInTitle">${esc(shopName)}</h2>
        <p>Sign in to your shop.</p>
        ${emailLogin ? `<label class="field"><span>Email</span>
          <input id="signInEmail" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(brand.signInEmail)}" required></label>` : ""}
        <label class="field"><span>${emailLogin ? "Password" : "Shop PIN"}</span>
          <input id="signInPin" type="password" ${emailLogin ? "" : 'inputmode="numeric" '}autocomplete="current-password" required></label>
        <label class="sign-in-stay"><input id="signInStay" type="checkbox" checked> Stay signed in on this phone</label>
        <p class="sign-in-error" id="signInError" role="alert">${esc(message)}</p>
        <button class="button button-gold" type="submit">Sign in</button>
        <button class="text-button" type="button" id="signInLater">Not now</button>
      </form>`;
    doc.body.appendChild(overlay);
    const input = doc.getElementById("signInPin");
    const emailInput = doc.getElementById("signInEmail");
    (emailInput && !emailInput.value ? emailInput : input)?.focus?.();
    return new Promise((resolve) => {
      const done = (value) => {
        overlay.remove();
        resolve(value);
      };
      doc.getElementById("signInForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const pin = String(input.value || "").trim();
        const email = emailInput ? String(emailInput.value || "").trim() : "";
        if (emailInput && !email) {
          doc.getElementById("signInError").textContent = "Enter your email.";
          return;
        }
        if (!pin) {
          doc.getElementById("signInError").textContent = emailInput ? "Enter your password." : "Enter the PIN.";
          return;
        }
        done({ pin, email, stay: Boolean(doc.getElementById("signInStay").checked) });
      });
      doc.getElementById("signInLater").addEventListener("click", () => done(null));
    });
  }

  function headers(base) {
    const result = new Headers(base || {});
    const current = token();
    if (current) result.set("Authorization", `Bearer ${current}`);
    return result;
  }

  /**
   * Trades the PIN for this device's token. Returns true once paired.
   *
   * `interactive` is false for anything running on its own — a boot sync, a
   * queue flush when the phone comes back online — because a modal prompt
   * appearing out of nowhere in a driveway is its own kind of broken.
   */
  function ensurePaired({ interactive = false } = {}) {
    if (isPaired()) return Promise.resolve(true);
    if (!interactive || declined) return Promise.resolve(false);
    if (pairing) return pairing;

    pairing = (async () => {
      try {
        const shopName = (window.SHOP_BRAND && window.SHOP_BRAND.name) || "Gold Mobile Mechanic";
        let message = "";
        // Wrong PIN asks again on the same card instead of a dead-end alert.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const answer = await askForPin(shopName, message);
          if (!answer) {
            declined = true;
            return false;
          }
          const entered = String(answer.pin).trim();
          if (!entered) return false;
          let response;
          try {
            response = await fetch(`${SYNC_API}/api/pair`, {
              method: "POST",
              cache: "no-store",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(answer.email ? { pin: entered, email: answer.email, deviceId: deviceId() } : { pin: entered, deviceId: deviceId() })
            });
          } catch {
            message = "Could not reach the server. Check signal and try again.";
            continue;
          }
          const body = await response.json().catch(() => null);
          if (response.ok && body?.token) {
            keepToken(String(body.token), answer.stay);
            return true;
          }
          message = body?.error || "That PIN did not work. Try again.";
        }
        return false;
      } catch {
        return false;
      } finally {
        pairing = null;
      }
    })();

    return pairing;
  }

  /**
   * `fetch` for every call that needs the operator's identity.
   *
   * A 401 is treated as "this phone is not paired yet" rather than as a failed
   * request: the token is dropped, the PIN is asked for once, and the call is
   * replayed. That is what lets the Worker be locked down while a phone is
   * still running the previous build — it repairs itself on the next tap
   * instead of going dead until someone reinstalls the app.
   *
   * Only replayable bodies are retried. Everything this app sends is a string
   * or a Blob, both of which can be sent twice; a stream could not be.
   */
  async function request(path, options = {}) {
    // Deliberately NOT paired up-front. Asking for a PIN before the server has
    // said it wants one would pop a prompt on a phone talking to a Worker that
    // is not locked yet — which is exactly the state between deploying the app
    // and deploying the Worker. Let the 401 be the thing that asks.
    const send = () => fetch(`${SYNC_API}${path}`, {
      ...options,
      cache: options.cache || "no-store",
      headers: headers(options.headers)
    });

    let response = await send();
    if (response.status === 401) {
      clear();
      const paired = await ensurePaired({ interactive: options.interactive !== false });
      if (paired) response = await send();
    }
    return response;
  }

  /** Asks for the PIN on open when the shop's server is locked and this phone is not signed in. */
  async function signInOnOpen() {
    if (isPaired()) return true;
    try {
      const response = await fetch(`${SYNC_API}/api/health`, { cache: "no-store" });
      const health = await response.json().catch(() => ({}));
      if (health?.locked !== true) return false;
    } catch {
      return false;
    }
    return ensurePaired({ interactive: true });
  }

  /** Sign out of this phone: the next open asks for the PIN again. */
  function signOut() {
    clear();
    declined = false;
  }

  window.GMMAuth = { deviceId, token, isPaired, clear, headers, ensurePaired, request, signInOnOpen, signOut, SYNC_API };
})();
