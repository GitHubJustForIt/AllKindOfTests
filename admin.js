"use strict";

const SHEETS_API =
  "https://script.google.com/macros/s/AKfycbz9dZV_cFMcX8lxVo4RvikXyp47MQ6EtuWndMC9sppiaf_34pRej1pbQQ4Cm26RAVpg/exec";

const ADMIN_CODE = "19.08.2011";
const ADMIN_SESSION_KEY = "plr_admin_ok";

async function apiGet(sheetName) {
  const res = await fetch(`${SHEETS_API}?sheet=${encodeURIComponent(sheetName)}`, { method: "GET" });
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
  const data = await res.json();
  if (data && data.status === "error") throw new Error(data.message);
  return data;
}

let toastTimer = null;
function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = type === "error" ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/* ==========================================================================
   STYLED CONFIRM / PROMPT DIALOGS
   Replace window.confirm() / window.prompt() everywhere below — those
   native browser dialogs can't be styled and clash with the rest of the
   site. These return a Promise, same call shape, so the rest of the code
   just uses `await`.
   ========================================================================== */

function confirmDialog(title, message, { okLabel = "Confirm", danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modalConfirm");
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmMessage").textContent = message;
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    okBtn.textContent = okLabel;
    okBtn.className = danger ? "btn btn-danger" : "btn btn-primary";

    const cleanup = (result) => {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    overlay.classList.add("show");
  });
}

function promptDialog(title, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modalPrompt");
    document.getElementById("promptTitle").textContent = title;
    const input = document.getElementById("promptInput");
    const hint = document.getElementById("promptHint");
    input.value = defaultValue;
    hint.textContent = "";
    const okBtn = document.getElementById("promptOkBtn");
    const cancelBtn = document.getElementById("promptCancelBtn");

    const cleanup = (result) => {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => {
      const val = input.value.trim();
      if (!val || Number(val) < 1) {
        hint.textContent = "Enter a valid number.";
        hint.className = "field-hint error";
        return;
      }
      cleanup(val);
    };
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(null); };
    const onKeydown = (e) => { if (e.key === "Enter") onOk(); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    input.addEventListener("keydown", onKeydown);
    overlay.classList.add("show");
    setTimeout(() => input.focus(), 50);
  });
}

/* ==========================================================================
   PIN GATE
   ========================================================================== */

function unlockAdmin() {
  document.getElementById("pinGate").style.display = "none";
  document.getElementById("adminPanel").classList.add("show");
  loadAll();
}

document.getElementById("pinSubmitBtn").addEventListener("click", () => {
  const val = document.getElementById("pinInput").value.trim();
  const hint = document.getElementById("pinHint");
  if (val === ADMIN_CODE) {
    sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
    unlockAdmin();
  } else {
    hint.textContent = "Incorrect code.";
    hint.className = "field-hint error";
  }
});
document.getElementById("pinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("pinSubmitBtn").click();
});

if (sessionStorage.getItem(ADMIN_SESSION_KEY) === "1") {
  unlockAdmin();
}

/* ==========================================================================
   DATA LOAD + RENDER
   ========================================================================== */

let contingentsCache = [];
let sessionsCache = [];
let ticketsCache = [];

async function loadAll() {
  try {
    const [contingents, sessions, settings, tickets] = await Promise.all([
      apiGet("Contingents"),
      apiGet("Sessions"),
      apiGet("Settings"),
      apiGet("Tickets"),
    ]);
    contingentsCache = contingents.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    sessionsCache = sessions;
    ticketsCache = tickets;
    renderDays();

    const banner = settings.find((s) => s.key === "bannerImageUrl");
    if (banner) document.getElementById("bannerUrlInput").value = banner.value;
  } catch (err) {
    console.error(err);
    showToast("Couldn't load data from Google Sheets.", "error");
  }
}

function sessionForDate(dateStr) {
  return sessionsCache.find((s) => String(s.date) === dateStr);
}

function ticketFor(dateStr, username) {
  return ticketsCache.find(
    (t) => String(t.date) === dateStr && String(t.username).toLowerCase() === username.toLowerCase()
  );
}

function renderDays() {
  const container = document.getElementById("daysList");
  if (contingentsCache.length === 0) {
    container.innerHTML = `<div class="empty-note">No open days yet. Add one above.</div>`;
    return;
  }

  container.innerHTML = "";
  contingentsCache.forEach((day) => {
    const usernames = String(day.usernames || "").split(",").map((s) => s.trim()).filter(Boolean);
    const session = sessionForDate(day.date);
    const isOpen = session && String(session.is_open).toLowerCase() === "true";

    const row = document.createElement("div");
    row.className = "day-row";
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";
    row.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div class="dr-main">
          <strong>${formatDateLong(day.date)}</strong>
          ${day.booked} / ${day.capacity} booked
        </div>
        <div class="dr-actions">
          <button class="btn btn-ghost btn-sm" data-action="capacity">Edit capacity</button>
          <button class="btn btn-ghost btn-sm" data-action="bookings">Bookings (${usernames.length})</button>
          <button class="btn btn-ghost btn-sm" data-action="session">Session: ${isOpen ? "Open" : "Closed"}</button>
          <button class="btn btn-danger btn-sm" data-action="close">Close day</button>
        </div>
      </div>
      <div class="booking-list" data-panel="bookings">
        ${usernames.length === 0 ? '<div class="empty-note">No bookings yet.</div>' : usernames.map((u) => {
          const t = ticketFor(day.date, u);
          const checkedIn = t && t.checked_in_at;
          return `
            <div class="booking-chip">
              <div class="bc-main">
                <span>@${u}</span>
                ${t ? `<span class="bc-barcode">${t.barcode}</span>` : `<span class="bc-barcode">no ticket row found</span>`}
              </div>
              <span class="bc-status ${checkedIn ? "in" : "out"}">${checkedIn ? "Checked in" : "Not entered"}</span>
              <button data-remove-username="${u}" class="link-btn" style="color:var(--danger);">Remove</button>
            </div>
          `;
        }).join("")}
      </div>
      <div class="booking-list" data-panel="session">
        <div class="session-row">
          <span class="session-status ${isOpen ? "open" : "closed"}">${isOpen ? "Entrance open" : "Entrance closed"}</span>
          ${isOpen ? `<span style="font-size:12px; color:var(--text-secondary);">Link: ${session.entrance_link || "(none set)"}</span>` : ""}
        </div>
        <div class="inline-form" style="margin-top:10px;">
          <div class="field">
            <label>Entrance link</label>
            <div class="field-input-wrap"><input type="text" class="entrance-link-input" placeholder="https://www.roblox.com/games/…" value="${session && session.entrance_link ? session.entrance_link : ""}" /></div>
          </div>
          <button class="btn btn-primary btn-sm" data-action="open-session">Open daily session</button>
          ${isOpen ? '<button class="btn btn-ghost btn-sm" data-action="close-session">Close session</button>' : ""}
        </div>
      </div>
    `;

    row.querySelector('[data-action="capacity"]').addEventListener("click", async () => {
      const next = await promptDialog(`New capacity for ${formatDateLong(day.date)}`, day.capacity);
      if (next === null) return;
      const capacity = Number(next);
      try {
        await apiPost({ action: "SET_CONTINGENT", date: day.date, capacity });
        showToast("Capacity updated.");
        loadAll();
      } catch (err) { showToast(err.message, "error"); }
    });

    row.querySelector('[data-action="bookings"]').addEventListener("click", () => {
      row.querySelector('[data-panel="bookings"]').classList.toggle("show");
    });
    row.querySelector('[data-action="session"]').addEventListener("click", () => {
      row.querySelector('[data-panel="session"]').classList.toggle("show");
    });

    row.querySelectorAll("[data-remove-username]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const username = btn.getAttribute("data-remove-username");
        const ok = await confirmDialog("Remove booking?", `Remove @${username}'s booking for ${formatDateLong(day.date)}? This also deletes their ticket row.`);
        if (!ok) return;
        try {
          await apiPost({ action: "REMOVE_BOOKING", date: day.date, username });
          showToast("Booking removed.");
          loadAll();
        } catch (err) { showToast(err.message, "error"); }
      });
    });

    row.querySelector('[data-action="close"]').addEventListener("click", async () => {
      const ok = await confirmDialog(
        "Close this day?",
        `This removes ${formatDateLong(day.date)} from the calendar, deletes all ${usernames.length} ticket(s) booked for it, and closes its entrance session.`
      );
      if (!ok) return;
      try {
        const result = await apiPost({ action: "DELETE_CONTINGENT", date: day.date });
        showToast(result.message || "Day closed.");
        loadAll();
      } catch (err) { showToast(err.message, "error"); }
    });

    row.querySelector('[data-action="open-session"]').addEventListener("click", async () => {
      const link = row.querySelector(".entrance-link-input").value.trim();
      if (!link) { showToast("Enter an entrance link first.", "error"); return; }
      try {
        await apiPost({ action: "OPEN_SESSION", date: day.date, entrance_link: link });
        showToast("Daily session opened.");
        loadAll();
      } catch (err) { showToast(err.message, "error"); }
    });

    const closeSessionBtn = row.querySelector('[data-action="close-session"]');
    if (closeSessionBtn) {
      closeSessionBtn.addEventListener("click", async () => {
        const ok = await confirmDialog("Close today's entrance session?", "Guests won't be able to check in for this date until you open it again.", { okLabel: "Close session" });
        if (!ok) return;
        try {
          await apiPost({ action: "CLOSE_SESSION", date: day.date });
          showToast("Session closed.");
          loadAll();
        } catch (err) { showToast(err.message, "error"); }
      });
    }

    container.appendChild(row);
  });
}

/* ==========================================================================
   NEW DAY + SETTINGS
   ========================================================================== */

document.getElementById("addDayBtn").addEventListener("click", async () => {
  const date = document.getElementById("newDayDate").value.trim();
  const capacity = Number(document.getElementById("newDayCapacity").value) || 5;
  const hint = document.getElementById("addDayHint");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    hint.textContent = "Use the format YYYY-MM-DD.";
    hint.className = "field-hint error";
    return;
  }
  hint.textContent = "";
  try {
    await apiPost({ action: "SET_CONTINGENT", date, capacity });
    showToast(`${date} is now open with ${capacity} spots.`);
    document.getElementById("newDayDate").value = "";
    loadAll();
  } catch (err) {
    showToast(err.message, "error");
  }
});

document.getElementById("saveBannerBtn").addEventListener("click", async () => {
  const url = document.getElementById("bannerUrlInput").value.trim();
  try {
    await apiPost({ action: "UPSERT_SETTINGS", entries: { bannerImageUrl: url } });
    showToast("Banner image saved.");
  } catch (err) {
    showToast(err.message, "error");
  }
});
