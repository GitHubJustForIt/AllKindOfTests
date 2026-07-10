"use strict";

/* ==========================================================================
   CONFIG
   ========================================================================== */

const SHEETS_API =
  "https://script.google.com/macros/s/AKfycbzxaTffjMadwWagMiTxxVxyc6QkLDN8AuYP2yiz75CyguhnXGWHII4iR7uABPa2eD6I/exec";

// Public identifier — safe to ship in client code. The matching Client
// Secret lives ONLY in Code.gs on the server.
const ROBLOX_CLIENT_ID = "3966608874463146474";
const ROBLOX_AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize";
const ROBLOX_SCOPE = "openid profile";

// Must exactly match a Redirect URI registered in your Roblox OAuth app.
const REDIRECT_URI = window.location.origin + window.location.pathname;

const CART_STORAGE_KEY = "plr_cart_v1";
const OAUTH_STATE_KEY = "plr_oauth_state";
const OAUTH_PENDING_DATE_KEY = "plr_oauth_pending_date";
const MAX_PER_DAY_IN_CART = 2;

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
function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  contingents: new Map(), // date -> { capacity, booked }
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
    rows.map((r) => [String(r.date), { capacity: Number(r.capacity) || 0, booked: Number(r.booked) || 0 }])
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
   CHECKOUT
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
      await apiPost({ sheet: "Contingents", action: "INCREMENT_BOOKING", date: item.date, username: item.username });
      const ticket = buildTicketRecord(item.date, item.username);
      await apiPost({
        sheet: "Tickets",
        action: "APPEND",
        values: [ticket.username, ticket.date, ticket.barcode, ticket.reservation_number, ticket.created_at, ""],
      });
      succeeded.push(ticket);
    } catch (err) {
      failed.push({ item, message: err.message });
    }
  }

  state.cart = state.cart.filter((item) => !succeeded.some((t) => t.date === item.date && t.username === item.username));
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
    showToast(`${failed.length} ticket(s) couldn't be booked (day may have filled up).`, "error");
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
   TICKET GENERATION
   ========================================================================== */

function generateBarcode() {
  const rand = window.crypto && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").toUpperCase()
    : String(Math.random()).slice(2) + Date.now();
  return "PLR-" + rand.slice(0, 16);
}

function buildTicketRecord(date, username) {
  const barcode = generateBarcode();
  const reservationNumber = "PLR-" + date.replace(/-/g, "") + "-" + barcode.slice(4, 9);
  return {
    username,
    date,
    barcode,
    reservation_number: reservationNumber,
    created_at: new Date().toISOString(),
  };
}

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
        <p class="ticket-howto-desc">Show this on your device, or download it as a PDF. On your visit date, use it in the Entering Panel on the homepage to unlock the join link.</p>
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
          <li>Keep your barcode private — it's how you'll be checked in on your visit day.</li>
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
  document.getElementById("downloadPdfBtn").onclick = () => downloadTicketAsPdf(ticket);
  showModal("modalTicket");
}

async function downloadTicketAsPdf(ticket) {
  const btn = document.getElementById("downloadPdfBtn");
  const original = btn.textContent;
  btn.textContent = "Preparing…";
  btn.disabled = true;
  try {
    const node = document.getElementById("ticketPrintArea");
    const canvas = await html2canvas(node, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const imgHeight = (canvas.height * pageWidth) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 16, pageWidth, imgHeight);
    pdf.save(`phantasialand-roblox-ticket-${ticket.date}.pdf`);
  } catch (err) {
    console.error(err);
    showToast("Couldn't create the PDF. You can still screenshot the ticket.", "error");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

/* ==========================================================================
   ENTERING PANEL (daily session check-in)
   ========================================================================== */

document.getElementById("sessionEnterBtn").addEventListener("click", () => {
  document.getElementById("enterResultBox").style.display = "none";
  document.getElementById("enterResultBox").innerHTML = "";
  showModal("modalEnter");
});

document.getElementById("enterTicketImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const hint = document.getElementById("enterScanHint");
  if (!file) return;
  hint.textContent = "Scanning…";
  hint.className = "field-hint";

  const img = new Image();
  const reader = new FileReader();
  reader.onload = (ev) => { img.src = ev.target.result; };
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = typeof jsQR === "function" ? jsQR(imageData.data, imageData.width, imageData.height) : null;
    if (code && code.data) {
      document.getElementById("enterBarcodeInput").value = code.data;
      hint.textContent = "Barcode found and filled in below.";
      hint.className = "field-hint ok";
    } else {
      hint.textContent = "Couldn't find a QR code in that image — enter the barcode manually.";
      hint.className = "field-hint error";
    }
  };
  reader.readAsDataURL(file);
});

document.getElementById("enterSubmitBtn").addEventListener("click", async () => {
  const username = document.getElementById("enterUsernameInput").value.trim();
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
