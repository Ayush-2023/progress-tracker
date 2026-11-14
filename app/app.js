"use strict";

const STORAGE_KEY = "progress-tracker.v0";
const SCHEMA_VERSION = 1;
const GOAL_TYPES = ["Achieve", "Maintain", "Grow"];
// Saved data keeps the values above, so changing a name here never affects old backups.
const GOAL_TYPE_LABELS = { Achieve: "Targeted", Maintain: "Maintenance", Grow: "Growth" };
const TABS = ["goals", "achievements", "reminders"];
const TAB_ITEMS = { goals: "goal", achievements: "achievement", reminders: "reminder" };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const THEME_KEY = "progress-tracker.theme";
const THEMES = { light: "Light", dark: "Dark", programmer: "Programmer" };
// Each theme's background, used for the phone's status bar. Must match the script in index.html.
const THEME_BAR_COLORS = { light: "#f6f5f1", dark: "#191a18", programmer: "#000000" };

// Which kinds of item can sit directly under each kind.
const CHILD_KINDS = {
  goal: ["blocker", "task"],
  blocker: ["task"],
  task: ["subtask"],
  subtask: [],
};
const KIND_LABELS = { goal: "Goal", blocker: "Blocker", task: "Task", subtask: "Subtask" };

// How often a Maintenance goal repeats. `period` finishes "Done ..." and `unit` names one period.
const FREQUENCIES = {
  daily: { label: "Daily", unit: "day", period: "today" },
  weekly: { label: "Weekly", unit: "week", period: "this week" },
  fortnightly: { label: "Fortnightly", unit: "fortnight", period: "this fortnight" },
  monthly: { label: "Monthly", unit: "month", period: "this month" },
  quarterly: { label: "Quarterly", unit: "quarter", period: "this quarter" },
  yearly: { label: "Yearly", unit: "year", period: "this year" },
};
const DEFAULT_FREQUENCY = "weekly";

/* ---------- Data ---------- */

function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, nextGoalNumber: 1, items: [], achievements: [], reminders: [] };
}

// Numbers older goals, and keeps a counter so a deleted goal's number is never reused.
function ensureGoalNumbers(loaded) {
  const goals = loaded.items.filter((item) => item.kind === "goal");
  const highest = Math.max(0, ...goals.map((goal) => goal.goalNumber || 0));
  let next = Math.max(loaded.nextGoalNumber || 1, highest + 1);
  for (const goal of goals) {
    if (!goal.goalNumber) goal.goalNumber = next++;
  }
  loaded.nextGoalNumber = next;
  return loaded;
}

function goalId(goal) {
  return `G-${String(goal.goalNumber).padStart(3, "0")}`;
}

// Fills in anything older saved data or backups are missing.
function upgradeData(loaded) {
  ensureGoalNumbers(loaded);
  for (const item of loaded.items) {
    if (item.kind === "goal" && item.goalType === "Maintain") {
      item.frequency ??= DEFAULT_FREQUENCY;
      item.checkIns ??= [];
    }
  }
  return loaded;
}

/* ---------- Streaks ---------- */

// Numbers each calendar period, so consecutive periods are consecutive numbers.
// Weeks start on Monday. Fortnights are fixed two-week blocks starting on a Monday.
function periodIndex(date, frequency) {
  const [year, month, day] = date.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  const daysSinceMonday = dayNumber - 4; // 1970-01-05 was a Monday.
  switch (frequency) {
    case "daily": return dayNumber;
    case "weekly": return Math.floor(daysSinceMonday / 7);
    case "fortnightly": return Math.floor(daysSinceMonday / 14);
    case "monthly": return year * 12 + (month - 1);
    case "quarterly": return year * 4 + Math.floor((month - 1) / 3);
    default: return year;
  }
}

// The current period doesn't break a streak until it's over, so an unchecked
// "this week" still counts the weeks before it.
function streakInfo(goal, onDate = today()) {
  const periods = new Set(goal.checkIns.map((date) => periodIndex(date, goal.frequency)));
  const now = periodIndex(onDate, goal.frequency);
  const doneNow = periods.has(now);
  let current = 0;
  for (let period = doneNow ? now : now - 1; periods.has(period); period--) current++;
  let best = 0;
  let run = 0;
  let previous = null;
  for (const period of [...periods].sort((a, b) => a - b)) {
    run = previous !== null && period === previous + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = period;
  }
  return { current, best, doneNow };
}

// Checks in for the current period, or undoes that check-in if there already is one.
function toggleCheckIn(goal) {
  const now = periodIndex(today(), goal.frequency);
  const inThisPeriod = (date) => periodIndex(date, goal.frequency) === now;
  goal.checkIns = goal.checkIns.some(inThisPeriod)
    ? goal.checkIns.filter((date) => !inThisPeriod(date))
    : [...goal.checkIns, today()].sort();
  ui.returnFocusKey = `checkin-${goal.id}`;
  commit();
}

function isOptionalDate(value) {
  return value === null || (typeof value === "string" && DATE_PATTERN.test(value));
}

// Throws unless `data` is complete and consistent. Used for storage and imports.
function validate(data) {
  const fail = (reason) => { throw new Error(reason); };
  if (!data || typeof data !== "object") fail("not a JSON object");
  if (data.schemaVersion !== SCHEMA_VERSION) fail("unsupported schema version");
  for (const key of ["items", "achievements", "reminders"]) {
    if (!Array.isArray(data[key])) fail(`missing list: ${key}`);
  }

  const seen = new Set();
  const records = [...data.items, ...data.achievements, ...data.reminders];
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !record.id) fail("record without an id");
    if (typeof record.title !== "string" || !record.title) fail("record without a title");
    if (seen.has(record.id)) fail("duplicate id");
    seen.add(record.id);
  }

  const isPositiveWhole = (value) => Number.isInteger(value) && value > 0;
  if (data.nextGoalNumber !== undefined && !isPositiveWhole(data.nextGoalNumber)) fail("invalid goal counter");
  const goalNumbers = new Set();
  for (const item of data.items) {
    if (item.goalNumber === undefined) continue;
    if (item.kind !== "goal" || !isPositiveWhole(item.goalNumber)) fail("invalid goal number");
    if (goalNumbers.has(item.goalNumber)) fail("duplicate goal number");
    goalNumbers.add(item.goalNumber);
  }

  const itemsById = new Map(data.items.map((item) => [item.id, item]));
  for (const item of data.items) {
    if (!Object.hasOwn(CHILD_KINDS, item.kind)) fail("unknown item kind");
    if (typeof item.done !== "boolean") fail("item without a done state");
    if (item.archived !== undefined && (item.kind !== "goal" || typeof item.archived !== "boolean")) {
      fail("invalid archived state");
    }
    if (item.frequency !== undefined && (item.kind !== "goal" || !Object.hasOwn(FREQUENCIES, item.frequency))) {
      fail("invalid repeat setting");
    }
    if (item.checkIns !== undefined && (item.kind !== "goal" || !Array.isArray(item.checkIns)
      || item.checkIns.some((date) => typeof date !== "string" || !DATE_PATTERN.test(date)))) {
      fail("invalid check-ins");
    }
    if (item.kind === "goal") {
      if (item.parentId !== null) fail("goal with a parent");
      if (!GOAL_TYPES.includes(item.goalType)) fail("unknown goal type");
    } else {
      const parent = itemsById.get(item.parentId);
      if (!parent || !CHILD_KINDS[parent.kind].includes(item.kind)) fail("item with an invalid parent");
    }
  }
  for (const achievement of data.achievements) {
    if (!isOptionalDate(achievement.date) || achievement.date === null) fail("achievement without a date");
    if (achievement.attachedTo !== null && !itemsById.has(achievement.attachedTo)) {
      fail("achievement attached to a missing item");
    }
  }
  for (const reminder of data.reminders) {
    if (typeof reminder.done !== "boolean") fail("reminder without a done state");
    if (!isOptionalDate(reminder.date)) fail("reminder with an invalid date");
  }
  return data;
}

function loadData() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyData();
    return upgradeData(validate(JSON.parse(raw)));
  } catch (error) {
    // Keep unreadable data under another key so a later save can't destroy it.
    try {
      if (raw !== null) localStorage.setItem(`${STORAGE_KEY}.unreadable`, raw);
    } catch (_) { /* Nothing more we can do. */ }
    ui.notice = "Your saved data couldn't be read, so the app started empty. Import a backup to restore it.";
    return emptyData();
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    ui.notice = "Your last change couldn't be saved in this browser. Export a backup now.";
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function childrenOf(id) {
  const children = data.items.filter((item) => item.parentId === id);
  // Blockers first, because they explain why the tasks beside them are stuck.
  return [
    ...children.filter((item) => item.kind === "blocker"),
    ...children.filter((item) => item.kind !== "blocker"),
  ];
}

function descendantsOf(id) {
  return childrenOf(id).flatMap((child) => [child, ...descendantsOf(child.id)]);
}

function findItem(id) {
  return data.items.find((item) => item.id === id);
}

function pathOf(item) {
  const parts = [];
  for (let current = item; current; current = findItem(current.parentId)) {
    parts.unshift(current.title);
  }
  return parts.join(" › ");
}

// A flag only: tasks under an open blocker are marked, but still work normally.
function isBlocked(item) {
  for (let parent = findItem(item.parentId); parent; parent = findItem(parent.parentId)) {
    if (parent.kind === "blocker" && !parent.done) return true;
  }
  return false;
}

/* ---------- Changes ---------- */

function commit() {
  saveData();
  render();
}

function addItem(kind, parentId, title, goalType, frequency) {
  const item = { id: newId(), kind, parentId, title, done: false };
  if (kind === "goal") {
    item.goalType = goalType;
    item.goalNumber = data.nextGoalNumber++;
    if (goalType === "Maintain") {
      item.frequency = frequency || DEFAULT_FREQUENCY;
      item.checkIns = [];
    }
  }
  data.items.push(item);
  commit();
}

function deleteItem(id) {
  const removed = new Set([id, ...descendantsOf(id).map((item) => item.id)]);
  data.items = data.items.filter((item) => !removed.has(item.id));
  // Achievements still happened, so they outlive whatever they were attached to.
  for (const achievement of data.achievements) {
    if (removed.has(achievement.attachedTo)) achievement.attachedTo = null;
  }
  commit();
}

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = h("a", { href: URL.createObjectURL(blob), download: `progress-tracker-${today()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function readImportFile(file) {
  try {
    ui.pendingImport = upgradeData(validate(JSON.parse(await file.text())));
    ui.notice = null;
  } catch (error) {
    ui.pendingImport = null;
    ui.notice = `That file couldn't be imported: ${error.message}. Your data wasn't changed.`;
  }
  render();
}

/* ---------- Rendering helpers ---------- */

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "class") element.className = value;
    else if (key === "key") element.dataset.key = value;
    else if (key in element && key !== "list") element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return element;
}

function linkButton(label, onclick, key) {
  return h("button", { type: "button", class: "link", onclick, key: key || label }, label);
}

// Text kept in `ui.drafts` survives re-renders until the form is submitted.
function draftField(element, key, fallback) {
  element.value = ui.drafts[key] ?? fallback;
  const remember = () => { ui.drafts[key] = element.value; };
  element.addEventListener("input", remember);
  element.addEventListener("change", remember);
  return element;
}

function clearDrafts(formKey) {
  for (const key of Object.keys(ui.drafts)) {
    if (key === formKey || key.startsWith(`${formKey}:`)) delete ui.drafts[key];
  }
}

function goalTypeSelect(value, onchange, label, key) {
  return h(
    "select",
    { "aria-label": label, onchange, key },
    GOAL_TYPES.map((type) => h("option", { value: type, selected: type === value }, GOAL_TYPE_LABELS[type])),
  );
}

function attachOptions(selected) {
  const options = [h("option", { value: "", selected: selected === null }, "Not attached")];
  const addTree = (item) => {
    options.push(h(
      "option",
      { value: item.id, selected: item.id === selected },
      `${KIND_LABELS[item.kind]}: ${pathOf(item)}`,
    ));
    childrenOf(item.id).forEach(addTree);
  };
  // Archived goals are left out, unless this record is already attached inside one.
  let selectedRoot = findItem(selected);
  while (selectedRoot && selectedRoot.parentId) selectedRoot = findItem(selectedRoot.parentId);
  data.items
    .filter((item) => item.kind === "goal" && (!item.archived || item === selectedRoot))
    .forEach(addTree);
  return options;
}

function setMode(mode) {
  ui.mode = mode;
  render();
}

// The row menu, add form and edit modal show one at a time, tracked in `ui.mode`.
function isMode(type, id, extra) {
  return ui.mode && ui.mode.type === type && ui.mode.id === id && ui.mode.extra === extra;
}

// Shown when a tab has nothing in it. Does the same thing as the tab bar's plus button.
function emptyCard(title, hint) {
  return h(
    "button",
    {
      type: "button",
      class: "empty-card",
      onclick: () => setMode({ type: "add", id: null, extra: TAB_ITEMS[ui.tab] }),
    },
    h("span", { class: "add-icon", "aria-hidden": "true" }),
    h("span", { class: "empty-title" }, title),
    h("span", { class: "meta" }, hint),
  );
}

/* ---------- Goals tab ---------- */

function renderGoals() {
  const goals = data.items.filter((item) => item.kind === "goal");
  const active = goals.filter((goal) => !goal.archived);
  const archived = goals.filter((goal) => goal.archived);
  return [
    active.length
      ? h("ul", { class: "flat" }, active.map((goal) => renderItem(goal, true)))
      : emptyCard(archived.length ? "Add a goal" : "Add your first goal", "Something long term you want to work toward."),
    archived.length
      ? h(
          "button",
          {
            type: "button",
            class: "archive-toggle",
            key: "archive-toggle",
            "aria-expanded": String(ui.showArchived),
            onclick: () => {
              ui.showArchived = !ui.showArchived;
              ui.mode = null;
              render();
            },
          },
          `Archived (${archived.length})`,
        )
      : null,
    archived.length && ui.showArchived
      ? h("ul", { class: "flat" }, archived.map((goal) => renderItem(goal, true)))
      : null,
  ];
}

function setGoalState(goal, changes) {
  Object.assign(goal, changes);
  ui.mode = null;
  ui.returnFocusKey = `more-${goal.id}`;
  commit();
}

function rowMenu(item) {
  const isGoal = item.kind === "goal";
  const edit = linkButton("Edit", () => setMode({ type: "edit", id: item.id }), `edit-${item.id}`);
  if (item.archived) {
    return h(
      "div",
      { class: "dropdown" },
      linkButton("Unarchive", () => setGoalState(item, { archived: false }), `unarchive-${item.id}`),
      edit,
    );
  }
  return h(
    "div",
    { class: "dropdown" },
    CHILD_KINDS[item.kind].map((kind) => linkButton(
      `Add ${kind}`,
      () => setMode({ type: "add", id: item.id, extra: kind }),
      `add-${kind}-${item.id}`,
    )),
    linkButton("Add achievement", () => setMode({ type: "add", id: item.id, extra: "achievement" }), `add-ach-${item.id}`),
    h("hr"),
    edit,
    isGoal
      ? linkButton(
          item.done ? "Reopen goal" : "Finish goal",
          () => setGoalState(item, { done: !item.done }),
          `finish-${item.id}`,
        )
      : null,
    isGoal && item.done
      ? linkButton("Archive", () => setGoalState(item, { archived: true }), `archive-${item.id}`)
      : null,
  );
}

function renderItem(item, isTopLevel) {
  // Archived goals show as a single line, so the section stays compact and read-only.
  const isArchived = Boolean(item.archived);
  const canFinish = !isArchived && (item.kind !== "goal" || item.goalType === "Achieve");
  const openBlockers = isArchived
    ? 0
    : childrenOf(item.id).filter((child) => child.kind === "blocker" && !child.done).length;
  const attached = isArchived ? [] : data.achievements.filter((achievement) => achievement.attachedTo === item.id);
  const children = isArchived ? [] : childrenOf(item.id);
  const classes = ["item", item.kind, isTopLevel ? "card" : "", item.done ? "is-done" : "", isArchived ? "archived" : ""];
  // Only active Maintenance goals take check-ins. Finished or archived ones just show their type.
  const repeats = item.kind === "goal" && item.goalType === "Maintain" ? FREQUENCIES[item.frequency] : null;
  const tracksStreak = repeats && !item.done && !isArchived;
  const streak = tracksStreak ? streakInfo(item) : null;

  const line = h(
    "div",
    { class: "line" },
    canFinish
      ? h("input", {
          type: "checkbox",
          checked: item.done,
          key: `done-${item.id}`,
          "aria-label": `${item.kind === "blocker" ? "Resolved" : "Done"}: ${item.title}`,
          onchange: (event) => {
            item.done = event.target.checked;
            commit();
          },
        })
      : null,
    item.kind === "goal" ? h("span", { class: "goal-id" }, goalId(item)) : null,
    h("span", { class: "title" }, item.title),
    item.kind === "goal"
      ? h("span", { class: "tag" }, repeats ? `${GOAL_TYPE_LABELS.Maintain} · ${repeats.label}` : GOAL_TYPE_LABELS[item.goalType])
      : null,
    item.kind === "goal" && item.done ? h("span", { class: "tag" }, "Finished") : null,
    streak && streak.current
      ? h("span", {
          class: "tag streak",
          title: `Best: ${streak.best} ${repeats.unit}${streak.best === 1 ? "" : "s"}`,
        }, `${streak.current}-${repeats.unit} streak`)
      : null,
    tracksStreak
      ? h("button", {
          type: "button",
          class: "checkin",
          key: `checkin-${item.id}`,
          "aria-pressed": String(streak.doneNow),
          "aria-label": streak.doneNow
            ? `Undo check-in for ${repeats.period}: ${item.title}`
            : `Check in for ${repeats.period}: ${item.title}`,
          onclick: () => toggleCheckIn(item),
        }, streak.doneNow ? `✓ Done ${repeats.period}` : "Check in")
      : null,
    openBlockers
      ? h("span", {
          class: "blocker-count",
          role: "img",
          title: `${openBlockers} open ${openBlockers === 1 ? "blocker" : "blockers"}`,
          "aria-label": `${openBlockers} open ${openBlockers === 1 ? "blocker" : "blockers"}`,
        }, String(openBlockers))
      : null,
    item.kind !== "blocker" && isBlocked(item) ? h("span", { class: "tag alert" }, "Blocked") : null,
    h(
      "button",
      {
        type: "button",
        class: "link more",
        key: `more-${item.id}`,
        "aria-label": `Actions for ${item.title}`,
        "aria-expanded": String(Boolean(isMode("menu", item.id))),
        onclick: () => setMode(isMode("menu", item.id) ? null : { type: "menu", id: item.id }),
      },
    ),
    isMode("menu", item.id) ? rowMenu(item) : null,
  );

  return h(
    "li",
    { class: classes.filter(Boolean).join(" ") },
    line,
    attached.length
      ? h("ul", { class: "attached" }, attached.map((achievement) => h(
          "li",
          {},
          h("span", { class: "star", "aria-hidden": "true" }, "★ "),
          `${achievement.title} (${achievement.date})`,
        )))
      : null,
    children.length ? h("ul", { class: "tree" }, children.map((child) => renderItem(child, false))) : null,
  );
}

/* ---------- Achievements tab ---------- */

function renderAchievements() {
  const sorted = [...data.achievements].sort((a, b) => b.date.localeCompare(a.date));
  return sorted.length
    ? h("ul", { class: "flat" }, sorted.map(renderAchievement))
    : emptyCard("Log your first achievement", "Short wins count.");
}

function renderAchievement(achievement) {
  const attachedItem = findItem(achievement.attachedTo);
  return h(
    "li",
    { class: "card" },
    h(
      "div",
      { class: "line" },
      h("span", { class: "star", "aria-hidden": "true" }, "★"),
      h("span", { class: "title" }, achievement.title),
      h("span", { class: "meta" }, achievement.date),
      h(
        "div",
        { class: "actions" },
        linkButton("Edit", () => setMode({ type: "edit", id: achievement.id }), `edit-${achievement.id}`),
      ),
    ),
    h("p", { class: "meta attached-to" }, attachedItem ? pathOf(attachedItem) : "Not attached"),
  );
}

/* ---------- Reminders tab ---------- */

function renderReminders() {
  // Open first, then soonest date, with undated reminders after dated ones.
  const sorted = [...data.reminders].sort((a, b) => (
    Number(a.done) - Number(b.done) || (a.date || "9999").localeCompare(b.date || "9999")
  ));
  return sorted.length
    ? h("ul", { class: "flat" }, sorted.map(renderReminder))
    : emptyCard("Add a reminder", "For anything that comes up on its own.");
}

function renderReminder(reminder) {
  const overdue = !reminder.done && reminder.date && reminder.date < today();
  return h(
    "li",
    { class: "card" },
    h(
      "div",
      { class: "line" },
      h("input", {
        type: "checkbox",
        checked: reminder.done,
        key: `done-${reminder.id}`,
        "aria-label": `Done: ${reminder.title}`,
        onchange: (event) => {
          reminder.done = event.target.checked;
          commit();
        },
      }),
      h("span", { class: reminder.done ? "title is-done" : "title" }, reminder.title),
      reminder.date ? h("span", { class: "meta" }, reminder.date) : null,
      overdue ? h("span", { class: "tag alert" }, "Overdue") : null,
      h(
        "div",
        { class: "actions" },
        linkButton("Edit", () => setMode({ type: "edit", id: reminder.id }), `edit-${reminder.id}`),
      ),
    ),
  );
}

/* ---------- Add and edit modals ---------- */

function modalField(label, control) {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

// "Repeats" only applies to Maintenance goals, so it shows and hides with the Type field.
function repeatsField(typeSelect, formKey, current) {
  const select = draftField(
    h("select", {}, Object.entries(FREQUENCIES).map(([value, frequency]) => (
      h("option", { value, selected: value === current }, frequency.label)
    ))),
    `${formKey}:repeats`,
    current,
  );
  const field = modalField("Repeats", select);
  const sync = () => { field.hidden = typeSelect.value !== "Maintain"; };
  typeSelect.addEventListener("change", sync);
  sync();
  return { select, field };
}

function modalDialog({ heading, error, close, onSubmit, fields, footer }) {
  return h(
    "dialog",
    {
      class: "modal",
      "aria-labelledby": "modal-heading",
      // Escape closes through here, so the page's state stays in step.
      oncancel: (event) => {
        event.preventDefault();
        close();
        render();
      },
    },
    h(
      "form",
      {
        noValidate: true,
        oninput: () => { error.hidden = true; },
        onsubmit: (event) => {
          event.preventDefault();
          onSubmit();
        },
      },
      h("h2", { id: "modal-heading" }, heading),
      fields,
      error,
      footer,
    ),
  );
}

function renderAddModal() {
  if (!ui.mode || ui.mode.type !== "add") return null;
  const { id: parentId, extra: kind } = ui.mode;
  const parent = parentId ? findItem(parentId) : null;
  if (parentId && !parent) {
    ui.mode = null;
    return null;
  }

  const formKey = `add-${kind}-${parentId || "top"}`;
  const titleInput = draftField(h("input", { type: "text", maxLength: 300 }), formKey, "");
  titleInput.dataset.modalTitle = "true";
  const typeSelect = kind === "goal"
    ? draftField(goalTypeSelect("Achieve"), `${formKey}:type`, "Achieve")
    : null;
  const repeats = typeSelect ? repeatsField(typeSelect, formKey, DEFAULT_FREQUENCY) : null;
  const hasDate = kind === "achievement" || kind === "reminder";
  const dateInput = hasDate
    ? draftField(h("input", { type: "date" }), `${formKey}:date`, kind === "achievement" ? today() : "")
    : null;
  const attachSelect = kind === "achievement"
    ? draftField(h("select", {}, attachOptions(parentId)), `${formKey}:attach`, parentId || "")
    : null;
  const error = h("p", { class: "form-error", role: "alert", hidden: true });

  const close = () => {
    clearDrafts(formKey);
    ui.mode = null;
    ui.returnFocusKey = parentId ? `more-${parentId}` : "add-new";
  };
  const showError = (message, field) => {
    error.textContent = message;
    error.hidden = false;
    field.focus();
  };

  return modalDialog({
    heading: `New ${kind}`,
    error,
    close,
    onSubmit: () => {
      const title = titleInput.value.trim();
      if (!title) return showError("Type a title first.", titleInput);
      if (kind === "achievement" && !dateInput.value) return showError("Choose a date.", dateInput);
      const typeValue = typeSelect ? typeSelect.value : undefined;
      const repeatsValue = repeats ? repeats.select.value : undefined;
      const dateValue = dateInput ? dateInput.value : "";
      const attachValue = attachSelect ? attachSelect.value : "";
      close();
      if (kind === "achievement") {
        data.achievements.push({ id: newId(), title, date: dateValue, attachedTo: attachValue || null });
        commit();
      } else if (kind === "reminder") {
        data.reminders.push({ id: newId(), title, date: dateValue || null, done: false });
        commit();
      } else {
        addItem(kind, parentId, title, typeValue, repeatsValue);
      }
    },
    fields: [
      parent && kind !== "achievement" ? h("p", { class: "meta modal-context" }, `Under ${pathOf(parent)}`) : null,
      modalField("Title", titleInput),
      typeSelect ? modalField("Type", typeSelect) : null,
      repeats ? repeats.field : null,
      dateInput ? modalField(kind === "reminder" ? "Date (optional)" : "Date", dateInput) : null,
      attachSelect ? modalField("Attached to", attachSelect) : null,
    ],
    footer: h(
      "div",
      { class: "modal-actions" },
      h("button", { type: "button", onclick: () => { close(); render(); } }, "Cancel"),
      h("button", { type: "submit", class: "primary" }, "Add"),
    ),
  });
}

function renderEditModal() {
  if (!ui.mode || ui.mode.type !== "edit") return null;
  const { id } = ui.mode;
  const item = findItem(id);
  const achievement = data.achievements.find((other) => other.id === id);
  const reminder = data.reminders.find((other) => other.id === id);
  const record = item || achievement || reminder;
  if (!record) {
    ui.mode = null;
    return null;
  }

  const formKey = `edit-${id}`;
  const kindName = item ? item.kind : achievement ? "achievement" : "reminder";
  const titleInput = draftField(h("input", { type: "text", maxLength: 300 }), formKey, record.title);
  titleInput.dataset.modalTitle = "true";

  const typeSelect = item && item.kind === "goal"
    ? draftField(goalTypeSelect(item.goalType), `${formKey}:type`, item.goalType)
    : null;
  const repeats = typeSelect ? repeatsField(typeSelect, formKey, item.frequency || DEFAULT_FREQUENCY) : null;
  const dateInput = achievement || reminder
    ? draftField(h("input", { type: "date" }), `${formKey}:date`, record.date || "")
    : null;
  const attachSelect = achievement
    ? draftField(h("select", {}, attachOptions(achievement.attachedTo)), `${formKey}:attach`, achievement.attachedTo || "")
    : null;
  const error = h("p", { class: "form-error", role: "alert", hidden: true });

  const close = () => {
    clearDrafts(formKey);
    ui.mode = null;
    ui.returnFocusKey = item ? `more-${id}` : formKey;
  };
  const showError = (message, field) => {
    error.textContent = message;
    error.hidden = false;
    field.focus();
  };

  const deleteRecord = () => {
    clearDrafts(formKey);
    ui.mode = null;
    if (item) {
      if (item.parentId) ui.returnFocusKey = `more-${item.parentId}`;
      deleteItem(id);
      return;
    }
    if (achievement) data.achievements = data.achievements.filter((other) => other.id !== id);
    else data.reminders = data.reminders.filter((other) => other.id !== id);
    commit();
  };
  const count = item ? descendantsOf(id).length : 0;
  const under = count ? ` and ${count} ${count === 1 ? "item" : "items"} under it` : "";
  const keptNote = item ? " Attached achievements are kept." : "";

  const actions = h(
    "div",
    { class: "modal-actions" },
    h("button", {
      type: "button",
      class: "danger delete-start",
      onclick: () => {
        actions.hidden = true;
        confirmation.hidden = false;
        keepButton.focus();
      },
    }, "Delete"),
    h("button", { type: "button", onclick: () => { close(); render(); } }, "Cancel"),
    h("button", { type: "submit", class: "primary" }, "Save"),
  );
  const keepButton = h("button", {
    type: "button",
    onclick: () => {
      confirmation.hidden = true;
      actions.hidden = false;
    },
  }, "Keep");
  const confirmation = h(
    "div",
    { class: "modal-confirm", role: "alert", hidden: true },
    h("p", {}, `Delete this ${kindName}${under}?${keptNote}`),
    h(
      "div",
      { class: "modal-actions" },
      keepButton,
      h("button", { type: "button", class: "danger", onclick: deleteRecord }, "Delete"),
    ),
  );

  return modalDialog({
    heading: item && item.kind === "goal" ? `Edit goal ${goalId(item)}` : `Edit ${kindName}`,
    error,
    close,
    onSubmit: () => {
      const title = titleInput.value.trim();
      if (!title) return showError("Type a title first.", titleInput);
      if (achievement && !dateInput.value) return showError("Choose a date.", dateInput);
      record.title = title;
      if (typeSelect) record.goalType = typeSelect.value;
      if (typeSelect && record.goalType === "Maintain") {
        // Check-ins are kept even if the repeat setting changes, and the streak is recounted.
        record.frequency = repeats.select.value;
        record.checkIns ??= [];
      }
      if (achievement) {
        record.date = dateInput.value;
        record.attachedTo = attachSelect.value || null;
      }
      if (reminder) record.date = dateInput.value || null;
      close();
      commit();
    },
    fields: [
      modalField("Title", titleInput),
      typeSelect ? modalField("Type", typeSelect) : null,
      repeats ? repeats.field : null,
      dateInput ? modalField(reminder ? "Date (optional)" : "Date", dateInput) : null,
      attachSelect ? modalField("Attached to", attachSelect) : null,
    ],
    footer: [actions, confirmation],
  });
}

/* ---------- Page ---------- */

function storedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return Object.hasOwn(THEMES, saved) ? saved : null;
  } catch (error) {
    return null;
  }
}

function systemTheme() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.content = THEME_BAR_COLORS[theme];
}

// The theme is a preference of this browser, so it isn't part of exported data.
function chooseTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) { /* The theme still applies until the page closes. */ }
}

// Lives outside the rendered page, so a re-render can't remove it while the file picker is open.
const importInput = h("input", {
  type: "file",
  accept: ".json,application/json",
  hidden: true,
  onchange: (event) => {
    const [file] = event.target.files;
    if (file) readImportFile(file);
  },
});
document.body.append(importInput);

function renderSettingsMenu() {
  const current = document.documentElement.dataset.theme;
  return h(
    "div",
    { class: "dropdown" },
    h("p", { class: "meta dropdown-label" }, "Theme"),
    Object.entries(THEMES).map(([value, label]) => h(
      "button",
      {
        type: "button",
        class: "link",
        key: `theme-${value}`,
        "aria-current": value === current ? "true" : null,
        onclick: () => {
          chooseTheme(value);
          render();
        },
      },
      label,
    )),
    h("hr"),
    linkButton("Export backup", () => {
      setMode(null);
      exportData();
    }, "export"),
    linkButton("Import backup", () => {
      setMode(null);
      importInput.value = "";
      importInput.click();
    }, "import"),
  );
}

function renderHeader() {
  const isOpen = Boolean(isMode("settings", "header"));
  return h(
    "header",
    { class: "top" },
    h("h1", {}, "Progress Tracker"),
    h(
      "div",
      { class: "settings" },
      h("button", {
        type: "button",
        class: "settings-button",
        key: "settings",
        title: "Settings",
        "aria-label": "Settings",
        "aria-expanded": String(isOpen),
        onclick: () => setMode(isOpen ? null : { type: "settings", id: "header" }),
      }, "⚙︎"),
      isOpen ? renderSettingsMenu() : null,
    ),
  );
}

function renderNotices() {
  const notices = [];
  if (ui.notice) {
    notices.push(h(
      "div",
      { class: "notice row", role: "alert" },
      ui.notice,
      h("button", { type: "button", onclick: () => { ui.notice = null; render(); } }, "Dismiss"),
    ));
  }
  if (ui.pendingImport) {
    const { items, achievements, reminders } = ui.pendingImport;
    const applyImport = () => {
      data = ui.pendingImport;
      ui.pendingImport = null;
      ui.mode = null;
      ui.drafts = {};
      commit();
    };
    notices.push(h(
      "div",
      { class: "notice row", role: "alert" },
      `Replace everything here with this backup (${items.length} goal items, ${achievements.length} achievements, ${reminders.length} reminders)?`,
      h("button", { type: "button", class: "danger", onclick: applyImport }, "Replace"),
      h("button", { type: "button", onclick: () => { ui.pendingImport = null; render(); } }, "Cancel"),
    ));
  }
  return notices;
}

function renderTabs() {
  return h(
    "nav",
    { class: "tabs", "aria-label": "Sections" },
    h(
      "div",
      { class: "tab-links" },
      TABS.map((tab) => h(
        "button",
        {
          type: "button",
          key: `tab-${tab}`,
          "aria-current": ui.tab === tab ? "page" : null,
          onclick: () => {
            ui.tab = tab;
            ui.mode = null;
            location.hash = tab;
            render();
          },
        },
        tab,
      )),
    ),
    h("button", {
      type: "button",
      class: "add-button",
      key: "add-new",
      title: `Add ${TAB_ITEMS[ui.tab]}`,
      "aria-label": `Add ${TAB_ITEMS[ui.tab]}`,
      onclick: () => setMode({ type: "add", id: null, extra: TAB_ITEMS[ui.tab] }),
    }),
  );
}

function render() {
  const focusedKey = ui.returnFocusKey || (document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.key
    : null);
  ui.returnFocusKey = null;
  const views = { goals: renderGoals, achievements: renderAchievements, reminders: renderReminders };
  const root = document.getElementById("root");
  root.replaceChildren(h(
    "div",
    { class: "page" },
    renderHeader(),
    renderNotices(),
    renderTabs(),
    h("main", {}, views[ui.tab]()),
    h(
      "footer",
      {},
      h("p", {}, "Your data is saved only in this browser. Export a backup regularly."),
      h("p", {}, "You don't get what you dream for, you get what you work for."),
    ),
    renderEditModal() || renderAddModal(),
  ));

  const modal = root.querySelector("dialog.modal");
  if (modal) {
    modal.showModal();
    modal.querySelector("[data-modal-title]").select();
    return;
  }

  const previous = focusedKey ? root.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`) : null;
  if (previous) previous.focus();
}

/* ---------- Start ---------- */

const ui = {
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "goals",
  mode: null,
  notice: null,
  pendingImport: null,
  drafts: {},
  showArchived: false,
};
let data = loadData();

// Another open tab saved a change: pick it up so this tab can't overwrite it.
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    data = loadData();
    render();
  }
  if (event.key === THEME_KEY) {
    applyTheme(storedTheme() || systemTheme());
    render();
  }
});

// Close an open row dropdown on a click elsewhere. The timeout lets the click
// finish first, so a checkbox clicked at the same moment still registers.
document.addEventListener("click", (event) => {
  if (!ui.mode || !["menu", "settings"].includes(ui.mode.type)) return;
  if (event.target.closest(".dropdown, button.more, button.settings-button")) return;
  const openMenu = ui.mode;
  setTimeout(() => {
    if (ui.mode === openMenu) setMode(null);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !ui.mode) return;
  if (ui.mode.type === "menu") ui.returnFocusKey = `more-${ui.mode.id}`;
  else if (ui.mode.type === "settings") ui.returnFocusKey = "settings";
  else return;
  setMode(null);
});

// Offline support for the installed app. Browsers only allow it over https or
// localhost, so opening index.html straight from disk simply skips it.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => { /* The app works without it. */ });
}

// With no theme chosen yet, keep following the system's light or dark setting.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!storedTheme()) {
    applyTheme(systemTheme());
    render();
  }
});

render();
