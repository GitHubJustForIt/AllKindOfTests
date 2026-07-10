"use strict";

/* ==========================================================================
   CONFIG
   ========================================================================== */

const SHEETS_API =
  "https://script.google.com/macros/s/AKfycbz7poA9onjIuZQddOOL_8JoneqCMs0NQZZczb69Wtp5BhgeC0pZCvYZGe2QX0vRzAWY/exec";

const STORAGE_KEY = "plr_username";
const SOUND_MUTE_KEY = "plr_music_muted";
const TICKET_PRICE = " ";

/* ==========================================================================
   SOUND ENGINE
   Every sample maps to one purposeful UI moment. Glitch/flicker samples are
   intentionally left unused — they don't fit this calm sound language.

   IMPORTANT FIX: sounds were silent before because each play() created a
   brand-new <audio> clone that browsers (Safari in particular, and Chrome
   under some conditions) refuse to play unless it has been "unlocked" by a
   direct user gesture first. The fix: build a small pool of real <audio>
   elements per sound up front, and unlock every single one of them (play +
   immediately pause) on the very first tap/click anywhere on the page. From
   then on, calling .play() on those same elements works reliably — even
   from inside a setTimeout, which several of our transitions use.
   ========================================================================== */

const SFX_FILES = {
  clickPrimary: "assets/sounds/Button__Cursor__Select___4_.wav",
  clickSecondary: "assets/sounds/Button__Cursor__Select___5_.wav",
  inputFocus: "assets/sounds/Granular__Button__Select____2_.wav",
  checking: "assets/sounds/Granular_Combo__5_.wav",
  success: "assets/sounds/Granular_Shine__45_.wav",
  hover: "assets/sounds/Magnetic__Button__10_.wav",
  cute: "assets/sounds/Cute_Vocal.wav",
  whooshIn: "assets/sounds/Deep__Mini__Whoosh__7_.wav",
  whooshOut: "assets/sounds/Deep__Mini__Whoosh__8_.wav",
  whooshHome: "assets/sounds/Deep__Mini__Whoosh__11_.wav",
};

const SFX_VOLUME = {
  clickPrimary: 0.6,
  clickSecondary: 0.55,
  inputFocus: 0.4,
  checking: 0.35,
  success: 0.65,
  hover: 0.28,
  cute: 0.75,
  whooshIn: 0.5,
  whooshOut: 0.5,
  whooshHome: 0.5,
};

const POOL_SIZE = 3;
const sfxPool = {}; // name -> [Audio, Audio, Audio]
const sfxPoolIndex = {};

Object.keys(SFX_FILES).forEach((name) => {
  sfxPool[name] = [];
  sfxPoolIndex[name] = 0;
  for (let i = 0; i < POOL_SIZE; i++) {
    const a = new Audio(SFX_FILES[name]);
    a.preload = "auto";
    a.volume = SFX_VOLUME[name] ?? 0.5;
    a.addEventListener("error", () => {
      console.warn(`[sound] Failed to load "${name}" from ${SFX_FILES[name]} — check the assets/sounds folder is next to index.html and the site is served over http(s), not opened as a local file.`);
    });
    sfxPool[name].push(a);
  }
});

const MUSIC = new Audio("assets/sounds/Music.wav");
MUSIC.loop = true;
MUSIC.preload = "auto";
MUSIC.volume = 0.25;
MUSIC.addEventListener("error", () => console.warn("[sound] Failed to load background music."));

let audioUnlocked = false;
function unlockAllAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const all = Object.values(sfxPool).flat().concat([MUSIC]);
  all.forEach((el) => {
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(() => el.pause()).catch(() => {
        /* Some elements may still refuse silently — later real plays will retry anyway */
      });
    } else {
      el.pause();
    }
    el.currentTime = 0;
  });
  // Music should keep playing (unless previously muted) once unlocked
  if (localStorage.getItem(SOUND_MUTE_KEY) === "1") {
    setMusicMuted(true);
  } else {
    MUSIC.play().catch(() => {});
  }
}
["pointerdown", "keydown", "touchstart"].forEach((evt) =>
  window.addEventListener(evt, unlockAllAudio, { once: true, passive: true })
);

function playSfx(name) {
  const pool = sfxPool[name];
  if (!pool) return;
  const idx = sfxPoolIndex[name];
  const el = pool[idx];
  sfxPoolIndex[name] = (idx + 1) % pool.length;
  try {
    el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => console.warn(`[sound] "${name}" was blocked:`, err.message));
    }
  } catch (err) {
    console.warn(`[sound] "${name}" threw:`, err);
  }
}

let hoverArmed = true;
function playHoverThrottled() {
  if (!hoverArmed) return;
  hoverArmed = false;
  playSfx("hover");
  setTimeout(() => (hoverArmed = true), 260);
}

function setMusicMuted(muted) {
  MUSIC.muted = muted;
  localStorage.setItem(SOUND_MUTE_KEY, muted ? "1" : "0");
  const btn = document.getElementById("muteBtn");
  if (btn) btn.classList.toggle("muted", muted);
}

/* ==========================================================================
   BUBBLE FIELD — soap-bubble ambience
   ========================================================================== */

function spawnBubble() {
  const field = document.getElementById("bubbleField");
  if (!field) return;
  const size = 14 + Math.random() * 46;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.style.width = `${size}px`;
  bubble.style.height = `${size}px`;
  bubble.style.left = `${Math.random() * 100}vw`;
  const riseDur = 14 + Math.random() * 12;
  const wobbleDur = 3 + Math.random() * 3;
  bubble.style.animationDuration = `${riseDur}s, ${wobbleDur}s`;
  bubble.style.animationDelay = `0s, ${Math.random() * wobbleDur}s`;
  field.appendChild(bubble);
  setTimeout(() => bubble.remove(), riseDur * 1000 + 200);
}

function startBubbleField() {
  for (let i = 0; i < 6; i++) {
    setTimeout(() => spawnBubble(), i * 900);
  }
  setInterval(spawnBubble, 2600);
}

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
   SCREEN CONTROLLER
   ========================================================================== */

const screens = {
  auth: document.getElementById("screen-auth"),
  intro: document.getElementById("screen-intro"),
  home: document.getElementById("screen-home"),
};

function goToScreen(name, { sound } = {}) {
  const next = screens[name];
  const current = Object.values(screens).find((s) => s.classList.contains("active"));
  if (sound) playSfx(sound);

  if (current && current !== next) {
    current.classList.add("leaving");
    current.classList.remove("entering");
    setTimeout(() => current.classList.remove("active", "leaving"), 260);
  }
  setTimeout(() => {
    next.classList.add("active", "entering");
    setTimeout(() => next.classList.remove("entering"), 600);
  }, current ? 180 : 0);
}

/* ==========================================================================
   TOAST
   ========================================================================== */

let toastTimer = null;
function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "glass show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3400);
}

/* ==========================================================================
   VALIDATION / SESSION
   ========================================================================== */

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
function validateUsername(value) {
  if (!value) return "Please enter a Roblox username.";
  if (!USERNAME_RE.test(value)) return "3–20 characters, letters, numbers and underscores only.";
  return null;
}

function saveLocalSession(username) { localStorage.setItem(STORAGE_KEY, username); }
function readLocalSession() { return localStorage.getItem(STORAGE_KEY); }
function clearLocalSession() { localStorage.removeItem(STORAGE_KEY); }

async function findAccountByUsername(username) {
  const rows = await apiGet("Accounts");
  const target = username.trim().toLowerCase();
  return rows.find((r) => String(r.username ?? "").trim().toLowerCase() === target) || null;
}
async function createAccount(username) {
  return apiPost({ sheet: "Accounts", action: "APPEND", values: [username, new Date().toISOString()] });
}

function populateHome(username) {
  document.getElementById("homeUsername").textContent = username;
  document.getElementById("homeAvatarInitial").textContent = username.charAt(0).toUpperCase();
  document.getElementById("choiceLinkedName").textContent = "@" + username;
  document.getElementById("footerYear").textContent = new Date().getFullYear();
}

/* ==========================================================================
   APP STATE (loaded once homepage opens)
   ========================================================================== */

const state = {
  username: null,
  contingents: new Map(), // "YYYY-MM-DD" -> { capacity, booked, usernames }
  settings: {},
  myTickets: [], // upcoming tickets for the current user
  calendarMonth: new Date(new Date().setDate(1)),
  pendingBooking: { date: null, guest: null },
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayIso() { return isoDate(new Date()); }

async function loadAppData() {
  const [contingentRows, settingsRows, ticketRows] = await Promise.all([
    apiGet("Contingents").catch(() => []),
    apiGet("Settings").catch(() => []),
    apiGet("Tickets").catch(() => []),
  ]);

  state.contingents = new Map(
    contingentRows.map((r) => [
      String(r.date),
      {
        capacity: Number(r.capacity) || 0,
        booked: Number(r.booked) || 0,
        usernames: String(r.usernames || ""),
      },
    ])
  );

  state.settings = {};
  settingsRows.forEach((r) => (state.settings[r.key] = r.value));

  const today = todayIso();
  state.myTickets = ticketRows
    .filter((t) => String(t.username).toLowerCase() === state.username.toLowerCase())
    .filter((t) => String(t.date) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* ==========================================================================
   CALENDAR RENDERING
   ========================================================================== */

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["S","M","T","W","T","F","S"];

function dayStatus(dateStr) {
  const today = todayIso();
  if (dateStr < today) return "past";
  const c = state.contingents.get(dateStr);
  if (!c) return "closed";
  const iBooked = c.usernames
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(state.username.toLowerCase());
  if (iBooked) return "booked-by-me";
  if (c.booked >= c.capacity) return "full";
  return "open";
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
    const status = dayStatus(dateStr);

    const cell = document.createElement("div");
    cell.className = `day-cell ${status}`;
    cell.setAttribute("role", status === "open" || status === "booked-by-me" ? "button" : "presentation");
    cell.tabIndex = status === "open" || status === "booked-by-me" ? 0 : -1;
    cell.innerHTML = `<span class="day-num">${d}</span><span class="day-dot"></span>`;

    if (status === "open") {
      cell.addEventListener("click", () => openBookingFlow(dateStr));
      cell.addEventListener("keydown", (e) => { if (e.key === "Enter") openBookingFlow(dateStr); });
      cell.addEventListener("mouseenter", playHoverThrottled);
    } else if (status === "booked-by-me") {
      cell.addEventListener("click", () => {
        const t = state.myTickets.find((tk) => String(tk.date) === dateStr);
        if (t) openTicketModal(t);
      });
    } else if (status === "full") {
      cell.addEventListener("click", () => showToast("This day is fully booked.", "error"));
    }

    grid.appendChild(cell);
  }
}

document.getElementById("prevMonthBtn").addEventListener("click", () => {
  playSfx("clickSecondary");
  state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1);
  renderCalendar();
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  playSfx("clickSecondary");
  state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1);
  renderCalendar();
});

/* ==========================================================================
   MY TICKETS STRIP
   ========================================================================== */

function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderTicketsStrip() {
  const strip = document.getElementById("ticketsStrip");
  const count = document.getElementById("ticketsCount");
  count.textContent = `${state.myTickets.length} upcoming`;

  if (state.myTickets.length === 0) {
    strip.innerHTML = `<div class="ticket-empty">No upcoming tickets yet — book a day below.</div>`;
    return;
  }

  strip.innerHTML = "";
  state.myTickets.forEach((t) => {
    const card = document.createElement("div");
    card.className = "glass mini-ticket";
    card.innerHTML = `
      <div class="mt-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" stroke="white" stroke-width="1.6"/></svg></div>
      <div class="mt-date">${formatDateShort(t.date)}</div>
      <div class="mt-sub">Guest: @${t.guest_name}</div>
      <div class="mt-res">${t.reservation_number}</div>
    `;
    card.addEventListener("click", () => { playSfx("clickSecondary"); openTicketModal(t); });
    strip.appendChild(card);
  });
}

/* ==========================================================================
   BOOKING FLOW — 3 modal steps
   ========================================================================== */

function showModal(id) {
  document.getElementById(id).classList.add("show");
}
function hideModal(id) {
  document.getElementById(id).classList.remove("show");
}
function hideAllModals() {
  document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.remove("show"));
}

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => { playSfx("clickSecondary"); hideAllModals(); });
});
document.querySelectorAll("[data-back-modal]").forEach((btn) => {
  btn.addEventListener("click", () => {
    playSfx("clickSecondary");
    hideAllModals();
    showModal(btn.getAttribute("data-back-modal"));
  });
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hideAllModals(); });
});

function openBookingFlow(dateStr) {
  const c = state.contingents.get(dateStr);
  if (!c) { showToast("This day isn't open for booking.", "error"); return; }
  if (c.booked >= c.capacity) { showToast("This day is fully booked.", "error"); return; }

  state.pendingBooking = { date: dateStr, guest: state.username };

  document.getElementById("check1").checked = false;
  document.getElementById("check2").checked = false;
  document.getElementById("check1Row").classList.remove("checked");
  document.getElementById("check2Row").classList.remove("checked");
  document.getElementById("step1ContinueBtn").disabled = true;
  document.getElementById("step1Date").textContent = `for ${formatDateLong(dateStr)}`;

  document.getElementById("choiceLinked").classList.add("selected");
  document.getElementById("choiceOther").classList.remove("selected");
  document.getElementById("otherUsernameField").classList.remove("show");
  document.getElementById("otherUsernameInput").value = "";

  playSfx("clickPrimary");
  hideAllModals();
  showModal("modalStep1");
}

[["check1Row", "check1"], ["check2Row", "check2"]].forEach(([rowId, inputId]) => {
  const row = document.getElementById(rowId);
  const input = document.getElementById(inputId);
  row.addEventListener("click", () => {
    input.checked = !input.checked;
    row.classList.toggle("checked", input.checked);
    playSfx("inputFocus");
    const bothChecked = document.getElementById("check1").checked && document.getElementById("check2").checked;
    document.getElementById("step1ContinueBtn").disabled = !bothChecked;
  });
});

document.getElementById("step1ContinueBtn").addEventListener("click", () => {
  playSfx("clickPrimary");
  hideAllModals();
  showModal("modalStep2");
});

let selectedChoice = "linked";
["choiceLinked", "choiceOther"].forEach((id) => {
  document.getElementById(id).addEventListener("click", () => {
    playSfx("clickSecondary");
    selectedChoice = document.getElementById(id).getAttribute("data-choice");
    document.getElementById("choiceLinked").classList.toggle("selected", selectedChoice === "linked");
    document.getElementById("choiceOther").classList.toggle("selected", selectedChoice === "other");
    document.getElementById("otherUsernameField").classList.toggle("show", selectedChoice === "other");
  });
});

document.getElementById("step2ContinueBtn").addEventListener("click", () => {
  let guest = state.username;
  if (selectedChoice === "other") {
    const val = document.getElementById("otherUsernameInput").value.trim();
    const err = validateUsername(val);
    if (err) {
      document.getElementById("otherUsernameHint").textContent = err;
      document.getElementById("otherUsernameHint").className = "field-hint error";
      playSfx("clickSecondary");
      return;
    }
    guest = val;
  }
  state.pendingBooking.guest = guest;

  document.getElementById("summaryDate").textContent = formatDateLong(state.pendingBooking.date);
  document.getElementById("summaryGuest").textContent = "@" + guest;

  playSfx("clickPrimary");
  hideAllModals();
  showModal("modalStep3");
});

document.getElementById("step3ConfirmBtn").addEventListener("click", async () => {
  const btn = document.getElementById("step3ConfirmBtn");
  btn.classList.add("loading");
  btn.disabled = true;
  playSfx("clickPrimary");
  playSfx("checking");

  const { date, guest } = state.pendingBooking;
  try {
    await apiPost({ sheet: "Contingents", action: "INCREMENT_BOOKING", date, username: guest });

    const ticket = buildTicketRecord(date, guest);
    await apiPost({
      sheet: "Tickets",
      action: "APPEND",
      values: [state.username, ticket.date, ticket.barcode, ticket.reservation_number, ticket.guest_name, ticket.created_at],
    });

    playSfx("success");
    await loadAppData();
    renderCalendar();
    renderTicketsStrip();

    hideAllModals();
    showModal("modalSuccess");
    document.getElementById("viewTicketBtn").onclick = () => {
      playSfx("clickSecondary");
      hideAllModals();
      openTicketModal(ticket);
    };
  } catch (err) {
    console.error(err);
    showToast(err.message || "Booking failed. Please try again.", "error");
    hideAllModals();
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
});

/* ==========================================================================
   TICKET GENERATION
   ========================================================================== */

function generateBarcode() {
  const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "").toUpperCase() : String(Math.random()).slice(2) + Date.now();
  return "PLR-" + rand.slice(0, 16);
}

function buildTicketRecord(date, guest) {
  const barcode = generateBarcode();
  const reservationNumber = "PLR-" + date.replace(/-/g, "") + "-" + barcode.slice(4, 9);
  return {
    username: state.username,
    date,
    barcode,
    reservation_number: reservationNumber,
    guest_name: guest,
    created_at: new Date().toISOString(),
  };
}

function renderTicketHTML(ticket) {
  const bannerUrl = state.settings.bannerImageUrl || "";
  const bannerContent = bannerUrl
    ? `<img src="${bannerUrl}" alt="" />`
    : "";
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
        <p class="ticket-intro">Your ticket to a world full of fantasy. For adventures across the best attractions and a taste of the finest in-world dining. Live shows, playful crowds, and a big new drop for the whole family — join us on a turbulent mission with our crew, powered by Roblox's newest tech.</p>
        <div class="ticket-howto">How to use your e-ticket</div>
        <p class="ticket-howto-desc">Simply show us this on your device, or print it in its original A4 format. That's how we can scan you in at the entrance.</p>
      </div>
      <div class="ticket-divider"><span class="line"></span><span class="ring"></span><span class="line"></span></div>
      <div class="ticket-grid">
        <div class="t-field"><div class="t-label">Guest</div><div class="t-value">@${ticket.guest_name}</div></div>
        <div class="t-field"><div class="t-label">Reservation number</div><div class="t-value">${ticket.reservation_number}</div></div>
        <div class="t-field"><div class="t-label">Visit date</div><div class="t-value">${formatDateLong(ticket.date)}</div></div>
        <div class="t-field"><div class="t-label">Ticket type</div><div class="t-value">Ticket (ages 12+)</div></div>
        <div class="t-field price"><div class="t-label">Price</div><div class="t-value">${TICKET_PRICE}</div></div>
        <div class="t-field"><div class="t-label">Booked by</div><div class="t-value">@${ticket.username}</div></div>
      </div>
      <div class="ticket-info">
        <h4>General information</h4>
        <ul>
          <li>This e-ticket is valid for one person on the stated date only.</li>
          <li>The name of the ticket holder printed on this e-ticket cannot be changed and is not transferable.</li>
          <li>Guests aged 4–11 must be accompanied by an adult; guests 60+ get in free with valid proof of age.</li>
          <li>A valid ID may be requested at check-in to confirm your Roblox username.</li>
          <li>This e-ticket becomes invalid once the visit date has passed. Rebooking and refunds are excluded.</li>
          <li><strong>Please note wait times and transport restrictions displayed in-experience for your safety.</strong></li>
        </ul>
      </div>
      <div class="ticket-contact">
        <div class="tc-col">
          <div><strong>Phantasialand-Roblox</strong></div>
          <div>Fan-made Roblox experience</div>
        </div>
        <div class="tc-col">
          <div>Website: playphantasialand.example</div>
          <div>Support: hello@phantasialand-roblox.example</div>
        </div>
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
    new QRCode(el, {
      text: ticket.barcode,
      width: 100,
      height: 100,
      correctLevel: QRCode.CorrectLevel.M,
    });
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
  const originalLabel = btn.textContent;
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
    playSfx("success");
  } catch (err) {
    console.error(err);
    showToast("Couldn't create the PDF. You can still screenshot the ticket.", "error");
  } finally {
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
}

/* ==========================================================================
   AUTH FORM WIRING
   ========================================================================== */

const authForm = document.getElementById("authForm");
const usernameInput = document.getElementById("usernameInput");
const fieldHint = document.getElementById("fieldHint");
const submitBtn = document.getElementById("submitBtn");
const introContinueBtn = document.getElementById("introContinueBtn");
const muteBtn = document.getElementById("muteBtn");
const logoutBtn = document.getElementById("logoutBtn");

function setHint(el, message, type) {
  el.textContent = message || "";
  el.className = "field-hint" + (type ? ` ${type}` : "");
}
function setButtonLoading(btn, loading) {
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
}

usernameInput.addEventListener("focus", () => playSfx("inputFocus"));
usernameInput.addEventListener("input", () => {
  if (fieldHint.classList.contains("error")) setHint(fieldHint, "", null);
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const validationError = validateUsername(username);
  if (validationError) {
    setHint(fieldHint, validationError, "error");
    playSfx("clickSecondary");
    usernameInput.focus();
    return;
  }

  playSfx("clickPrimary");
  setButtonLoading(submitBtn, true);
  setHint(fieldHint, "Checking…", null);
  playSfx("checking");

  try {
    const existing = await findAccountByUsername(username);
    state.username = username;

    if (existing) {
      setHint(fieldHint, "Account found — welcome back!", "ok");
      saveLocalSession(username);
      populateHome(username);
      showToast(`Welcome back, ${username}!`);
      await enterHome();
      setTimeout(() => goToScreen("home", { sound: "whooshHome" }), 400);
    } else {
      await createAccount(username);
      playSfx("success");
      setHint(fieldHint, "Account created!", "ok");
      saveLocalSession(username);
      document.getElementById("introUsername").textContent = username;
      setTimeout(() => {
        goToScreen("intro", { sound: "whooshIn" });
        setTimeout(() => playSfx("cute"), 350);
      }, 450);
    }
  } catch (err) {
    console.error(err);
    setHint(fieldHint, "Something went wrong. Please try again.", "error");
    showToast("Couldn't reach Google Sheets.", "error");
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

introContinueBtn.addEventListener("click", async () => {
  playSfx("clickPrimary");
  setButtonLoading(introContinueBtn, true);
  const username = readLocalSession() || document.getElementById("introUsername").textContent;
  state.username = username;
  populateHome(username);
  await enterHome();
  setTimeout(() => {
    goToScreen("home", { sound: "whooshOut" });
    setButtonLoading(introContinueBtn, false);
  }, 350);
});

muteBtn.addEventListener("click", () => {
  playSfx("clickSecondary");
  const willMute = !MUSIC.muted;
  setMusicMuted(willMute);
  if (!willMute) MUSIC.play().catch(() => {});
});

logoutBtn.addEventListener("click", () => {
  playSfx("clickSecondary");
  clearLocalSession();
  usernameInput.value = "";
  setHint(fieldHint, "", null);
  showToast("Account unlinked.");
  goToScreen("auth", { sound: "whooshOut" });
});

[submitBtn, introContinueBtn, muteBtn, logoutBtn].forEach((el) => {
  el.addEventListener("mouseenter", playHoverThrottled);
});

/* ==========================================================================
   INIT
   ========================================================================== */

async function enterHome() {
  try {
    await loadAppData();
  } catch (err) {
    console.error(err);
    showToast("Some data couldn't be loaded from Google Sheets.", "error");
  }
  renderCalendar();
  renderTicketsStrip();
}

async function boot() {
  startBubbleField();
  if (localStorage.getItem(SOUND_MUTE_KEY) === "1") setMusicMuted(true);

  const saved = readLocalSession();
  if (saved) {
    state.username = saved;
    populateHome(saved);
    goToScreen("home");
    await enterHome();
    return;
  }
  goToScreen("auth");
}

document.addEventListener("DOMContentLoaded", boot);
