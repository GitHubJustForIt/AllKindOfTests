"use strict";

/* ==========================================================================
   CONFIG
   ========================================================================== */

const SHEETS_API =
  "https://script.google.com/macros/s/AKfycbz7poA9onjIuZQddOOL_8JoneqCMs0NQZZczb69Wtp5BhgeC0pZCvYZGe2QX0vRzAWY/exec";
// Column order expected in the Google Sheet, matching how doPost() appends
// `jsonBody.values` as a plain row: [username, linked_at]
const SHEET_COLUMNS = ["username", "linked_at"];
const STORAGE_KEY = "rbx_link_username";
const SOUND_MUTE_KEY = "rbx_link_music_muted";

/* ==========================================================================
   SOUND MANAGER
   Maps every relevant supplied sample to a purposeful UI moment.
   Glitch/flicker samples are intentionally excluded — they don't fit
   the calm, Apple-like sound language of this flow.
   ========================================================================== */

const SFX = {
  clickPrimary: new Audio("assets/sounds/Button__Cursor__Select___4_.wav"),
  clickSecondary: new Audio("assets/sounds/Button__Cursor__Select___5_.wav"),
  inputFocus: new Audio("assets/sounds/Granular__Button__Select____2_.wav"),
  checking: new Audio("assets/sounds/Granular_Combo__5_.wav"),
  success: new Audio("assets/sounds/Granular_Shine__45_.wav"),
  hover: new Audio("assets/sounds/Magnetic__Button__10_.wav"),
  cute: new Audio("assets/sounds/Cute_Vocal.wav"),
  whooshIn: new Audio("assets/sounds/Deep__Mini__Whoosh__7_.wav"),
  whooshOut: new Audio("assets/sounds/Deep__Mini__Whoosh__8_.wav"),
  whooshHome: new Audio("assets/sounds/Deep__Mini__Whoosh__11_.wav"),
};

const MUSIC = new Audio("assets/sounds/Music.wav");
MUSIC.loop = true;
MUSIC.volume = 0.28;

// Sensible default volumes so nothing overpowers the UI
const SFX_VOLUME = {
  clickPrimary: 0.55,
  clickSecondary: 0.5,
  inputFocus: 0.35,
  checking: 0.3,
  success: 0.6,
  hover: 0.22,
  cute: 0.7,
  whooshIn: 0.45,
  whooshOut: 0.45,
  whooshHome: 0.45,
};
Object.keys(SFX).forEach((k) => (SFX[k].volume = SFX_VOLUME[k] ?? 0.5));

function playSfx(name) {
  const base = SFX[name];
  if (!base) return;
  // Clone so overlapping triggers (fast clicks) don't cut each other off
  const node = base.cloneNode();
  node.volume = base.volume;
  node.play().catch(() => {
    /* Autoplay/interaction restrictions — safe to ignore */
  });
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
  document.getElementById("muteBtn").classList.toggle("muted", muted);
}

function tryStartMusic() {
  if (localStorage.getItem(SOUND_MUTE_KEY) === "1") {
    setMusicMuted(true);
    return;
  }
  MUSIC.play().catch(() => {
    /* Will retry on next user gesture via the 'once' listener below */
  });
}

/* ==========================================================================
   SCREEN CONTROLLER
   Handles the choreography between the three screens with Apple-style
   fade/scale transitions and matching whoosh sounds.
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
    setTimeout(() => {
      current.classList.remove("active", "leaving");
    }, 260);
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
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

/* ==========================================================================
   GOOGLE SHEETS INTEGRATION (via Apps Script Web App)
   The Apps Script doGet() has no server-side filtering — it always returns
   every row as JSON. So we fetch everything once and filter client-side.
   doPost() expects { values: [...] } and appends it as a raw row, in the
   exact column order defined in SHEET_COLUMNS above.

   Important: the POST is sent with `Content-Type: text/plain` on purpose.
   Apps Script Web Apps don't answer CORS preflight (OPTIONS) requests, so
   a JSON content-type would trigger a preflight and silently fail. Sending
   as text/plain skips the preflight while the body is still valid JSON,
   which doPost() parses fine via JSON.parse(e.postData.contents).
   ========================================================================== */

async function fetchAllAccounts() {
  const res = await fetch(SHEETS_API, { method: "GET" });
  if (!res.ok) throw new Error("Suche fehlgeschlagen");
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function findAccountByUsername(username) {
  const rows = await fetchAllAccounts();
  const target = username.trim().toLowerCase();
  return (
    rows.find(
      (row) =>
        String(row.username ?? "")
          .trim()
          .toLowerCase() === target
    ) || null
  );
}

async function createAccount(username) {
  const values = SHEET_COLUMNS.map((col) =>
    col === "username" ? username : new Date().toISOString()
  );

  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error("Konnte Account nicht erstellen");
  const data = await res.json();
  if (data.status === "error") throw new Error(data.message || "Fehler beim Speichern");
  return data;
}

/* ==========================================================================
   VALIDATION
   ========================================================================== */

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function validateUsername(value) {
  if (!value) return "Bitte gib deinen Roblox-Benutzernamen ein.";
  if (!USERNAME_RE.test(value)) {
    return "3–20 Zeichen, nur Buchstaben, Zahlen und Unterstriche.";
  }
  return null;
}

/* ==========================================================================
   LOCAL SESSION
   ========================================================================== */

function saveLocalSession(username) {
  localStorage.setItem(STORAGE_KEY, username);
}

function readLocalSession() {
  return localStorage.getItem(STORAGE_KEY);
}

function clearLocalSession() {
  localStorage.removeItem(STORAGE_KEY);
}

/* ==========================================================================
   HOME SCREEN POPULATION
   ========================================================================== */

function populateHome(username) {
  document.getElementById("homeUsername").textContent = username;
  document.getElementById("homeAvatarInitial").textContent = username
    .charAt(0)
    .toUpperCase();
}

/* ==========================================================================
   FLOW: enter app
   ========================================================================== */

async function boot() {
  const saved = readLocalSession();

  if (saved) {
    // Returning session on this device — no need to re-check the sheet,
    // straight to the homepage, no intro.
    populateHome(saved);
    goToScreen("home");
    return;
  }

  // No local session: stay on the auth screen and wait for input.
  goToScreen("auth");
}

/* ==========================================================================
   EVENT WIRING
   ========================================================================== */

const authForm = document.getElementById("authForm");
const usernameInput = document.getElementById("usernameInput");
const fieldHint = document.getElementById("fieldHint");
const submitBtn = document.getElementById("submitBtn");
const introContinueBtn = document.getElementById("introContinueBtn");
const muteBtn = document.getElementById("muteBtn");
const logoutBtn = document.getElementById("logoutBtn");

function setHint(message, type) {
  fieldHint.textContent = message || "";
  fieldHint.className = "field-hint" + (type ? ` ${type}` : "");
}

function setButtonLoading(btn, loading) {
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
}

usernameInput.addEventListener("focus", () => playSfx("inputFocus"));

usernameInput.addEventListener("input", () => {
  if (fieldHint.classList.contains("error")) setHint("", null);
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = usernameInput.value.trim();
  const validationError = validateUsername(username);

  if (validationError) {
    setHint(validationError, "error");
    playSfx("clickSecondary");
    usernameInput.focus();
    return;
  }

  playSfx("clickPrimary");
  setButtonLoading(submitBtn, true);
  setHint("Wird geprüft …", null);
  playSfx("checking");

  try {
    const existing = await findAccountByUsername(username);

    if (existing) {
      // Existing account -> straight into the homepage, no intro.
      setHint("Account gefunden — willkommen zurück!", "ok");
      saveLocalSession(username);
      populateHome(username);
      showToast(`Willkommen zurück, ${username}!`);
      setTimeout(() => goToScreen("home", { sound: "whooshHome" }), 500);
    } else {
      // New account -> create it, then show the cute intro.
      await createAccount(username);
      playSfx("success");
      setHint("Account erstellt!", "ok");
      saveLocalSession(username);
      document.getElementById("introUsername").textContent = username;
      setTimeout(() => {
        goToScreen("intro", { sound: "whooshIn" });
        setTimeout(() => playSfx("cute"), 350);
      }, 450);
    }
  } catch (err) {
    console.error(err);
    setHint("Etwas ist schiefgelaufen. Bitte versuch es erneut.", "error");
    showToast("Verbindung zu Google Sheets fehlgeschlagen.", "error");
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

introContinueBtn.addEventListener("click", () => {
  playSfx("clickPrimary");
  setButtonLoading(introContinueBtn, true);
  const username = readLocalSession() || document.getElementById("introUsername").textContent;
  populateHome(username);
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
  setHint("", null);
  showToast("Account getrennt.");
  goToScreen("auth", { sound: "whooshOut" });
});

// Magnetic hover feedback on primary interactive elements
[submitBtn, introContinueBtn, muteBtn, logoutBtn].forEach((el) => {
  el.addEventListener("mouseenter", playHoverThrottled);
});

// Kick off background music on first user interaction (autoplay policies)
window.addEventListener(
  "pointerdown",
  () => {
    tryStartMusic();
  },
  { once: true }
);

if (localStorage.getItem(SOUND_MUTE_KEY) === "1") {
  document.addEventListener("DOMContentLoaded", () => setMusicMuted(true));
}

/* ==========================================================================
   INIT
   ========================================================================== */

document.addEventListener("DOMContentLoaded", boot);
