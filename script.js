"use strict";

/* ==========================================================================
   CONFIG
   ========================================================================== */

const SHEETS_API =
  "https://script.google.com/macros/s/AKfycbz9dZV_cFMcX8lxVo4RvikXyp47MQ6EtuWndMC9sppiaf_34pRej1pbQQ4Cm26RAVpg/exec";

// Public identifier — safe to ship in client code. The matching Client
// Secret lives ONLY in Code.gs on the server.
const ROBLOX_CLIENT_ID = "3966608874463146474";
const ROBLOX_AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize";
const ROBLOX_SCOPE = "openid profile";

// Must exactly match a Redirect URI registered in your Roblox OAuth app,
// character for character (protocol, host, path, trailing slash — all of
// it). If you see "Redirect URI is invalid for this application" this is
// almost always the cause: whatever URL this line builds at runtime is
// NOT registered, byte-for-byte, in the Roblox Creator Dashboard under
// your app's OAuth 2.0 → Redirect URIs. Open your browser console and
// log REDIRECT_URI right before it's used, then paste that exact string
// into the dashboard. If your site is reachable at more than one URL
// (e.g. with and without a trailing slash, or on two domains), register
// all of them, or hardcode a single canonical one here instead of
// deriving it dynamically.
const REDIRECT_URI = window.location.origin + window.location.pathname;

const CART_STORAGE_KEY = "plr_cart_v1";
const OAUTH_STATE_KEY = "plr_oauth_state";
const OAUTH_PENDING_DATE_KEY = "plr_oauth_pending_date";
const MAX_PER_DAY_IN_CART = 2;

// Add as many banner images as you like — the homepage banner will
// cross-fade smoothly between them. A single entry just shows a static
// banner with no dots/animation.
const HERO_IMAGES = [
  "https://cdn.discordapp.com/attachments/1510354348217991350/1525095438301134929/Screenshot_299.png?ex=6a52234f&is=6a50d1cf&hm=66262401b771276167a65d881470132c99b76771c2a70d91e6bb0c0dfc059ccf&",
  // "https://example.com/your-second-banner.png",
  // "https://example.com/your-third-banner.png",
];
const HERO_ROTATE_MS = 5500;

/* ==========================================================================
   SHEETS API HELPERS
   ========================================================================== */

async function apiGet(sheetName) {
  const res = await fetch(`${SHEETS_API}?sheet=${encodeURIComponent(sheetName)}`, { method: "GET" });
  if (!res.ok) throw new Error(`Could not load "${sheetName}"`);
  const data = await res.json();
  if (data && data.status === "error") throw new Error(data.message);
  return Array.isArray(data) ? data : [];
}

async function apiPost(payload) {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Request failed");
  const data = await res.json();
  if (data && data.status === "error") throw new Error(data.message);
  return data;
}

/* ==========================================================================
   TOAST
   ========================================================================== */

let toastTimer = null;
function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = type === "error" ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

/* ==========================================================================
   MODAL HELPERS
   ========================================================================== */

function showModal(id) { document.getElementById(id).classList.add("show"); }
function hideAllModals() { document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.remove("show")); }
document.querySelectorAll("[data-close-modal]").forEach((btn) => btn.addEventListener("click", hideAllModals));
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hideAllModals(); });
});

function setButtonLoading(btn, loading) {
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
}

/* ==========================================================================
   DATE HELPERS
   ========================================================================== */

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayIso() { return isoDate(new Date()); }
function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
function validateUsername(value) {
  if (!value) return "Please enter a Roblox username.";
  if (!USERNAME_RE.test(value)) return "3–20 characters, letters, numbers and underscores only.";
  return null;
}

/* ==========================================================================
   APP STATE
   ========================================================================== */

const state = {
  contingents: new Map(), // date -> { capacity, booked, usernames: [] }
  settings: {},
  cart: [], // { id, date, username }
  calendarMonth: new Date(new Date().setDate(1)),
  pendingDate: null,
};

function persistCart() {
  sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
}
function restoreCart() {
  try {
    const raw = sessionStorage.getItem(CART_STORAGE_KEY);
    state.cart = raw ? JSON.parse(raw) : [];
  } catch {
    state.cart = [];
  }
}

async function loadContingents() {
  const rows = await apiGet("Contingents");
  state.contingents = new Map(
    rows.map((r) => [
      String(r.date),
      {
        capacity: Number(r.capacity) || 0,
        booked: Number(r.booked) || 0,
        usernames: String(r.usernames || "").split(",").map((s) => s.trim()).filter(Boolean),
      },
    ])
  );
}
async function loadSettings() {
  const rows = await apiGet("Settings");
  state.settings = {};
  rows.forEach((r) => (state.settings[r.key] = r.value));
}
async function loadSessionsAndMaybeShowBanner() {
  const rows = await apiGet("Sessions");
  const today = todayIso();
  const todaySession = rows.find((r) => String(r.date) === today && String(r.is_open).toLowerCase() === "true");
  const banner = document.getElementById("sessionBanner");
  if (todaySession) {
    banner.classList.add("show");
  } else {
    banner.classList.remove("show");
  }
}

/* ==========================================================================
   ONE TICKET PER USERNAME PER DAY
   ========================================================================== */

// The server (BOOK_TICKET) is the source of truth and rejects duplicates
// no matter what — this is only a fast, friendly client-side pre-check so
// people see the message immediately instead of after a round trip.
function usernameAlreadyHasTicket(dateStr, username) {
  const c = state.contingents.get(dateStr);
  const already = c ? c.usernames.some((u) => u.toLowerCase() === username.toLowerCase()) : false;
  const inCart = state.cart.some((item) => item.date === dateStr && item.username.toLowerCase() === username.toLowerCase());
  return already || inCart;
}

/* ==========================================================================
   HERO BANNER (smooth cross-fade, supports any number of images)
   ========================================================================== */

function initHeroCarousel() {
  const mount = document.getElementById("heroCarousel");
  if (!mount) return;
  const images = HERO_IMAGES.filter(Boolean);
  if (images.length === 0) {
    mount.closest(".hero-image").style.display = "none";
    return;
  }

  mount.innerHTML = "";
  const layers = images.map((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Phantasialand-Roblox";
    img.className = "hero-layer" + (i === 0 ? " show" : "");
    img.addEventListener("error", () => { img.style.display = "none"; });
    mount.appendChild(img);
    return img;
  });

  const dotsWrap = document.getElementById("heroDots");
  if (dotsWrap) {
    dotsWrap.innerHTML = "";
    if (images.length > 1) {
      images.forEach((_, i) => {
        const dot = document.createElement("span");
        dot.className = "hero-dot" + (i === 0 ? " active" : "");
        dotsWrap.appendChild(dot);
      });
    }
  }

  if (images.length <= 1) return;

  let active = 0;
  setInterval(() => {
    const next = (active + 1) % images.length;
    layers[active].classList.remove("show");
    layers[next].classList.add("show");
    if (dotsWrap) {
      dotsWrap.children[active].classList.remove("active");
      dotsWrap.children[next].classList.add("active");
    }
    active = next;
  }, HERO_ROTATE_MS);
}

/* ==========================================================================
   CALENDAR
   ========================================================================== */

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["S","M","T","W","T","F","S"];

function cartCountForDate(dateStr) {
  return state.cart.filter((c) => c.date === dateStr).length;
}

function dayStatus(dateStr) {
  const today = todayIso();
  if (dateStr < today) return { status: "past" };
  const c = state.contingents.get(dateStr);
  if (!c) return { status: "closed" };
  const remaining = c.capacity - c.booked;
  const inCart = cartCountForDate(dateStr);
  if (remaining <= 0) return { status: "full", remaining: 0 };
  if (inCart > 0) return { status: "mine", remaining, inCart };
  if (remaining <= 2) return { status: "low", remaining };
  return { status: "open", remaining };
}

function renderCalendar() {
  const grid = document.getElementById("calendarGrid");
  const label = document.getElementById("monthLabel");
  const month = state.calendarMonth;
  label.textContent = `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`;

  grid.innerHTML = "";
  DOW.forEach((d) => {
    const el = document.createElement("div");
    el.className = "dow";
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  for (let i = 0; i < startOffset; i++) {
    const filler = document.createElement("div");
    filler.className = "day-cell empty";
    grid.appendChild(filler);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const dateStr = isoDate(date);
    const info = dayStatus(dateStr);

    const cell = document.createElement("div");
    cell.className = `day-cell ${info.status}`;

    let statusLabel = "";
    if (info.status === "open") statusLabel = `${info.remaining} left`;
    else if (info.status === "low") statusLabel = `${info.remaining} left`;
    else if (info.status === "mine") statusLabel = `${info.inCart} in cart`;
    else if (info.status === "full") statusLabel = "Full";

    cell.innerHTML = `<span class="dnum">${d}</span><span class="dstatus">${statusLabel}</span>`;

    if (["open", "low", "mine"].includes(info.status)) {
      cell.addEventListener("click", () => openAddToCartFlow(dateStr));
    } else if (info.status === "full") {
      cell.addEventListener("click", () => showToast("This day is fully booked.", "error"));
    }

    grid.appendChild(cell);
  }
}

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1);
  renderCalendar();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1);
  renderCalendar();
});

/* ==========================================================================
   CART UI
   ========================================================================== */

function updateCartUI() {
  const count = state.cart.length;
  const badge = document.getElementById("cartBadge");
  const bar = document.getElementById("cartBar");
  const barCount = document.getElementById("cartBarCount");

  badge.style.display = count > 0 ? "flex" : "none";
  badge.textContent = count;
  bar.classList.toggle("show", count > 0);
  barCount.textContent = `${count} ticket${count === 1 ? "" : "s"}`;

  const list = document.getElementById("cartList");
  const summaryCount = document.getElementById("cartSummaryCount");
  summaryCount.textContent = count;

  if (count === 0) {
    list.innerHTML = `<div class="cart-empty">Your cart is empty. Pick an open day on the calendar.</div>`;
    return;
  }
  list.innerHTML = "";
  state.cart.forEach((item) => {
    const row = document.createElement("div");
    row.className = "cart-item";
    row.innerHTML = `
      <div class="ci-main"><strong>${formatDateLong(item.date)}</strong>@${item.username}</div>
      <button class="ci-remove" type="button">Remove</button>
    `;
    row.querySelector(".ci-remove").addEventListener("click", () => {
      state.cart = state.cart.filter((c) => c.id !== item.id);
      persistCart();
      updateCartUI();
      renderCalendar();
    });
    list.appendChild(row);
  });
}

function addToCart(date, username) {
  if (usernameAlreadyHasTicket(date, username)) {
    showToast(`@${username} already has a ticket for ${formatDateLong(date)}.`, "error");
    return false;
  }
  const countForDate = cartCountForDate(date);
  if (countForDate >= MAX_PER_DAY_IN_CART) {
    showToast(`You can add at most ${MAX_PER_DAY_IN_CART} tickets for the same day.`, "error");
    return false;
  }
  state.cart.push({ id: `${date}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date, username });
  persistCart();
  updateCartUI();
  renderCalendar();
  showToast(`Added @${username} for ${formatDateLong(date)} to your cart.`);
  return true;
}

document.getElementById("cartOpenBtn").addEventListener("click", () => showModal("modalCart"));
document.getElementById("cartBarBtn").addEventListener("click", () => showModal("modalCart"));

/* ==========================================================================
   TERMS OF SERVICE
   ========================================================================== */

const tosBtn = document.getElementById("tosBtn");
if (tosBtn) tosBtn.addEventListener("click", () => showModal("modalTerms"));
const tosFooterBtn = document.getElementById("tosFooterBtn");
if (tosFooterBtn) tosFooterBtn.addEventListener("click", () => showModal("modalTerms"));

/* ==========================================================================
   ADD-TO-CART FLOW (Roblox OAuth or manual username)
   ========================================================================== */

function openAddToCartFlow(dateStr) {
  const info = dayStatus(dateStr);
  if (info.status === "full" || info.status === "closed" || info.status === "past") {
    showToast("This day isn't available.", "error");
    return;
  }
  if (cartCountForDate(dateStr) >= MAX_PER_DAY_IN_CART) {
    showToast(`You already have ${MAX_PER_DAY_IN_CART} tickets for this day in your cart.`, "error");
    return;
  }
  state.pendingDate = dateStr;
  document.getElementById("pickDateLabel").textContent = `for ${formatDateLong(dateStr)}`;
  document.getElementById("manualUsernameInput").value = "";
  document.getElementById("manualUsernameHint").textContent = "";
  showModal("modalGetUsername");
}

document.getElementById("robloxOAuthBtn").addEventListener("click", () => {
  if (!state.pendingDate) return;
  const state_token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(OAUTH_STATE_KEY, state_token);
  sessionStorage.setItem(OAUTH_PENDING_DATE_KEY, state.pendingDate);
  persistCart();

  const url = new URL(ROBLOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", ROBLOX_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", ROBLOX_SCOPE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state_token);
  window.location.href = url.toString();
});

document.getElementById("manualAddBtn").addEventListener("click", () => {
  const val = document.getElementById("manualUsernameInput").value.trim();
  const err = validateUsername(val);
  const hint = document.getElementById("manualUsernameHint");
  if (err) {
    hint.textContent = err;
    hint.className = "field-hint error";
    return;
  }
  hint.textContent = "";
  if (addToCart(state.pendingDate, val)) {
    hideAllModals();
  }
});

async function resumeOAuthIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");
  if (!code) return;

  const savedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  const pendingDate = sessionStorage.getItem(OAUTH_PENDING_DATE_KEY);
  history.replaceState(null, "", window.location.pathname);

  if (!savedState || returnedState !== savedState || !pendingDate) {
    showToast("Roblox login session expired. Please try again.", "error");
    return;
  }

  try {
    const result = await apiPost({ action: "ROBLOX_OAUTH_EXCHANGE", code, redirect_uri: REDIRECT_URI });
    if (result.username) {
      addToCart(pendingDate, result.username);
    }
  } catch (err) {
    console.error(err);
    showToast("Roblox login failed. You can still add your username manually.", "error");
  } finally {
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_DATE_KEY);
  }
}

/* ==========================================================================
   CHECKOUT — one atomic BOOK_TICKET call per item, server is authoritative
   ========================================================================== */

document.getElementById("cartConfirmBtn").addEventListener("click", async () => {
  if (state.cart.length === 0) {
    showToast("Your cart is empty.", "error");
    return;
  }
  const btn = document.getElementById("cartConfirmBtn");
  setButtonLoading(btn, true);

  const succeeded = [];
  const failed = [];

  for (const item of state.cart) {
    try {
      const result = await apiPost({ action: "BOOK_TICKET", date: item.date, username: item.username });
      succeeded.push(result.ticket);
    } catch (err) {
      failed.push({ item, message: err.message });
    }
  }

  state.cart = state.cart.filter((item) => !succeeded.some((t) => t.date === item.date && t.username.toLowerCase() === item.username.toLowerCase()));
  persistCart();
  await loadContingents();
  renderCalendar();
  updateCartUI();

  setButtonLoading(btn, false);
  hideAllModals();

  if (succeeded.length > 0) {
    showSuccessModal(succeeded);
  }
  if (failed.length > 0) {
    failed.forEach((f) => showToast(`@${f.item.username}, ${formatDateLong(f.item.date)}: ${f.message}`, "error"));
  }
});

function showSuccessModal(tickets) {
  const list = document.getElementById("successTicketList");
  list.innerHTML = "";
  tickets.forEach((t) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "btn btn-ghost btn-sm";
    row.style.justifyContent = "space-between";
    row.textContent = `View ticket — ${formatDateLong(t.date)} (@${t.username})`;
    row.addEventListener("click", () => { hideAllModals(); openTicketModal(t); });
    list.appendChild(row);
  });
  showModal("modalSuccess");
}

/* ==========================================================================
   TICKET GENERATION (display only — barcode itself comes from the server)
   ========================================================================== */

function renderTicketHTML(ticket) {
  const bannerUrl = state.settings.bannerImageUrl || "";
  const bannerContent = bannerUrl ? `<img src="${bannerUrl}" alt="" />` : "";
  return `
    <div class="ticket" id="ticketPrintArea">
      <div class="ticket-banner">
        ${bannerContent}
        <div class="banner-overlay">
          <div class="park-logo">Phantasialand · Roblox</div>
          <div class="experience-title">Phantasialand-Roblox</div>
          <div class="experience-sub">An immersive Roblox theme park experience</div>
        </div>
        <div class="ticket-qr tl" id="qrTopLeft"></div>
        <div class="ticket-qr br" id="qrBottomRight"></div>
      </div>
      <div class="ticket-body">
        <h1>Your Phantasialand-Roblox Ticket</h1>
        <p class="ticket-intro">Your ticket to a world full of fantasy. For adventures across the best attractions and a taste of the finest in-world dining, live shows, and a big new experience for the whole family.</p>
        <div class="ticket-howto">How to use your e-ticket</div>
        <p class="ticket-howto-desc">Download the barcode as a text file below. On your visit date, upload it in the Entering Panel on the homepage to unlock the join link — your username and barcode will be filled in automatically.</p>
      </div>
      <div class="ticket-divider"><span class="line"></span><span class="ring"></span><span class="line"></span></div>
      <div class="ticket-grid">
        <div class="t-field"><div class="t-label">Guest</div><div class="t-value">@${ticket.username}</div></div>
        <div class="t-field"><div class="t-label">Reservation number</div><div class="t-value">${ticket.reservation_number}</div></div>
        <div class="t-field"><div class="t-label">Visit date</div><div class="t-value">${formatDateLong(ticket.date)}</div></div>
        <div class="t-field"><div class="t-label">Ticket type</div><div class="t-value">Free ticket</div></div>
        <div class="t-field price"><div class="t-label">Price</div><div class="t-value">€0.00</div></div>
        <div class="t-field"><div class="t-label">Barcode</div><div class="t-value" style="font-size:12px;">${ticket.barcode}</div></div>
      </div>
      <div class="ticket-info">
        <h4>General information</h4>
        <ul>
          <li>This e-ticket is valid for one person on the stated date only.</li>
          <li>The name printed on this e-ticket cannot be changed and is not transferable.</li>
          <li>Keep your barcode file private — it's how you'll be checked in on your visit day.</li>
          <li>This e-ticket becomes invalid once the visit date has passed.</li>
        </ul>
      </div>
      <div class="ticket-contact">
        <div class="tc-col"><div><strong>Phantasialand-Roblox</strong></div><div>Fan-made Roblox experience</div></div>
        <div class="tc-col"><div>Website: playphantasialand.example</div><div>Support: hello@phantasialand-roblox.example</div></div>
      </div>
      <div class="ticket-disclaimer">
        <strong>Not affiliated with the real Phantasialand.</strong> This is an independent, fan-made Roblox project created purely for entertainment. It has no connection to Phantasialand, Schmidt Löffelhardt GmbH &amp; Co. KG, or any of its affiliates.
      </div>
    </div>
  `;
}

function drawTicketQrCodes(ticket) {
  ["qrTopLeft", "qrBottomRight"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || typeof QRCode === "undefined") return;
    el.innerHTML = "";
    new QRCode(el, { text: ticket.barcode, width: 100, height: 100, correctLevel: QRCode.CorrectLevel.M });
  });
}

function openTicketModal(ticket) {
  document.getElementById("ticketMount").innerHTML = renderTicketHTML(ticket);
  drawTicketQrCodes(ticket);
  document.getElementById("downloadBarcodeTxtBtn").onclick = () => downloadBarcodeAsTxt(ticket);
  showModal("modalTicket");
}

// The e-ticket "download" is a small plain-text file — username + barcode
// + date — so the Entering Panel can auto-fill BOTH fields from one
// upload. This is now the only way to export a ticket (no PDF/image).
function downloadBarcodeAsTxt(ticket) {
  const contents = [
    "PHANTASIALAND-ROBLOX E-TICKET",
    "username: " + ticket.username,
    "barcode: " + ticket.barcode,
    "date: " + ticket.date,
    "reservation_number: " + ticket.reservation_number,
  ].join("\n");
  const blob = new Blob([contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `phantasialand-roblox-eticket-${ticket.date}-${ticket.username}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("E-ticket saved as a text file.");
}

/* ==========================================================================
   ENTERING PANEL (daily session check-in)
   ========================================================================== */

document.getElementById("sessionEnterBtn").addEventListener("click", () => {
  document.getElementById("enterResultBox").style.display = "none";
  document.getElementById("enterResultBox").innerHTML = "";
  showModal("modalEnter");
});

// Parses the .txt e-ticket produced by downloadBarcodeAsTxt() above and
// fills in BOTH the username and barcode fields automatically.
document.getElementById("enterTicketText").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const hint = document.getElementById("enterTextHint");
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = String(ev.target.result || "");
    const usernameMatch = text.match(/username:\s*@?([^\r\n]+)/i);
    const barcodeMatch = text.match(/barcode:\s*([^\r\n]+)/i);

    if (barcodeMatch) {
      document.getElementById("enterBarcodeInput").value = barcodeMatch[1].trim();
    }
    if (usernameMatch) {
      document.getElementById("enterUsernameInput").value = usernameMatch[1].trim();
    }

    if (barcodeMatch && usernameMatch) {
      hint.textContent = "Username and barcode filled in from your e-ticket file.";
      hint.className = "field-hint ok";
    } else {
      hint.textContent = "Couldn't read that file — enter your details manually.";
      hint.className = "field-hint error";
    }
  };
  reader.readAsText(file);
});

document.getElementById("enterSubmitBtn").addEventListener("click", async () => {
  const username = document.getElementById("enterUsernameInput").value.trim().replace(/^@/, "");
  const barcode = document.getElementById("enterBarcodeInput").value.trim();
  const resultBox = document.getElementById("enterResultBox");

  if (!username || !barcode) {
    showToast("Enter both your username and barcode.", "error");
    return;
  }

  const btn = document.getElementById("enterSubmitBtn");
  setButtonLoading(btn, true);
  try {
    const result = await apiPost({ action: "VERIFY_AND_ENTER", date: todayIso(), username, barcode });
    resultBox.style.display = "block";
    resultBox.innerHTML = `
      <div class="summary-box" style="text-align:center;">
        <p style="margin:0 0 12px; font-weight:700; color:var(--success);">You're verified! Have a great visit.</p>
        <a href="${result.entrance_link}" target="_blank" rel="noopener" class="btn btn-gold" style="text-decoration:none;">Join Phantasialand-Roblox</a>
      </div>
    `;
  } catch (err) {
    showToast(err.message || "Verification failed.", "error");
  } finally {
    setButtonLoading(btn, false);
  }
});

/* ==========================================================================
   INIT
   ========================================================================== */

async function boot() {
  restoreCart();
  document.getElementById("footerYear").textContent = new Date().getFullYear();
  initHeroCarousel();

  await resumeOAuthIfNeeded();

  try {
    await Promise.all([loadContingents(), loadSettings(), loadSessionsAndMaybeShowBanner()]);
  } catch (err) {
    console.error(err);
    showToast("Some data couldn't be loaded from Google Sheets.", "error");
  }

  renderCalendar();
  updateCartUI();
}

document.addEventListener("DOMContentLoaded", boot);
