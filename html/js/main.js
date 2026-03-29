import * as RR from "/nictool/dns-resource-record/index.js";

const API_URI = "/api";
let nsDataTable;
let zoneDataTable;
let userDataTable;
const zoneRecordDataTables = new Map();
const zoneColumnSearchTimers = new Map();
const RR_DATA_PREVIEW_CHARS = 50;
const CONFIRM_DELETES_COOKIE = "nt-confirm-deletes";
let activeZoneRecordContext;
let currentUser = null;

function isConfirmDeletesEnabled() {
  // Default ON (confirm) when no cookie set; cookie "0" means skip confirms
  return Cookie.get(CONFIRM_DELETES_COOKIE) !== "0";
}

function initDangerousModeToggle() {
  const toggle = document.getElementById("dangerousModeToggle");
  if (!toggle || toggle.dataset.initialized === "true") return;

  toggle.checked = isConfirmDeletesEnabled();
  toggle.dataset.initialized = "true";
  toggle.addEventListener("change", () => {
    Cookie.set(CONFIRM_DELETES_COOKIE, toggle.checked ? "1" : "0", { days: 365 });
  });
}

function normalizeOwnerForZone(owner, zoneName) {
  const zoneFqdn = `${zoneName}`.endsWith(".") ? `${zoneName}` : `${zoneName}.`;
  let value = `${owner ?? ""}`.trim();

  if (!value || value === "@") return zoneFqdn;
  if (!value.endsWith(".")) value = `${value}.`;
  if (value === zoneFqdn || value.endsWith(zoneFqdn)) return value;
  return `${value}${zoneFqdn}`;
}

function parseInputValue(raw) {
  if (typeof raw !== "string") return raw;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

function parseOptionalTtlValue(raw) {
  if (typeof raw !== "string") return raw;
  const value = raw.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

function formatZoneRecordTtl(ttl) {
  return ttl === 0 || ttl === undefined || ttl === null ? "" : `${ttl}`;
}

let currentGroupId = null;
let rootGroupId = null;
let groupHistory = []; // stack of { id, name } for breadcrumb navigation
let zoneDefaults = { ttl: 86400, refresh: 16384, retry: 900, expire: 1048576, minimum: 2560 };

function fieldToId(field) {
  return field.replace(/\s+/g, "-");
}

function secondsToHuman(secs) {
  const n = parseInt(secs, 10);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "0s";
  const units = [
    [604800, "w", 1],
    [86400,  "d", 1],
    [3600,   "h", 1],
    [60,     "m", 0],
    [1,      "s", 0],
  ];
  for (const [div, unit, decimals] of units) {
    if (n >= div) {
      const val = n / div;
      const factor = Math.pow(10, decimals);
      const rounded = Math.round(val * factor) / factor;
      return `${rounded}${unit}`;
    }
  }
  return `${n}s`;
}

function parseHumanTime(raw) {
  const s = `${raw ?? ""}`.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([smhdwSMHDW])$/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.round(val * multipliers[unit]);
}

function attachTimeField(inputId, displayId) {
  const input = document.getElementById(inputId);
  const display = document.getElementById(displayId);
  if (!input || !display) return;
  if (input.dataset.timeAttached === "true") {
    // Just update display for new value
    const parsed = parseHumanTime(input.value);
    display.textContent = parsed !== null ? secondsToHuman(parsed) : "";
    return;
  }
  input.dataset.timeAttached = "true";

  const update = () => {
    const parsed = parseHumanTime(input.value);
    display.textContent = parsed !== null ? secondsToHuman(parsed) : "";
  };

  input.addEventListener("blur", () => {
    const parsed = parseHumanTime(input.value);
    if (parsed !== null && !/^\d+$/.test(input.value.trim())) {
      input.value = String(parsed);
    }
    update();
  });
  input.addEventListener("input", update);
  update();
}

function setRRTypePlaceholders(type) {
  if (!RR[type]) return

  const rr = new RR[type](null)
  const canonical = rr.getCanonical()

  const ownerEl = document.getElementById("zrEditOwner")
  if (ownerEl && canonical.owner !== undefined) ownerEl.placeholder = canonical.owner

  for (const field of rr.getRdataFields()) {
    const val = canonical[field]
    if (val === undefined) continue
    const eid = `zrEdit${fieldToId(field)}`
    const el = document.getElementById(eid)
    if (el) {
      el.placeholder = String(val)
      const helpEl = document.getElementById(`zrEdit${rr.ucFirst(field)}Help`)
      if (helpEl && !helpEl.textContent) helpEl.textContent = `e.g. ${val}`
    }
  }
}

function setZoneRecordModalMode(mode) {
  const title = document.getElementById("zrEditModalLabel");
  const deleteButton = document.getElementById("zrDeleteButton");
  const saveButton = document.getElementById("zrSaveButton");

  if (title) title.textContent = mode === "create" ? "Create Resource Record" : "Edit Resource Record";
  if (deleteButton) deleteButton.style.display = mode === "create" ? "none" : "";
  if (saveButton) saveButton.textContent = mode === "create" ? "Create" : "Save";
}

function openCreateZoneRecordModal(zone) {
  const zoneFqdn = `${zone.zone}`.endsWith(".") ? zone.zone : `${zone.zone}.`;
  const defaultType = zoneFqdn.endsWith(".arpa.") ? "PTR" : "A";
  const rrCtor = RR[defaultType];
  const rr = new rrCtor(null);
  const zr = { zid: zone.id, owner: "", type: defaultType, address: "" };

  activeZoneRecordContext = { zone, mode: "create", rr };
  setZoneRecordModalMode("create");
  editZoneRecord(zone, zr, rr);
  setRRTypePlaceholders(defaultType);

  const modalEl = document.getElementById("zrEditModal");
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

function setZoneRowOpenState(tr, isOpen) {
  tr.classList.toggle("zone-row-open", isOpen);
  const icon = tr.querySelector(".zone-toggle-icon");
  if (icon) icon.textContent = isOpen ? "▾" : "▸";
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getRdataPreview(value, maxChars = RR_DATA_PREVIEW_CHARS) {
  const full = `${value ?? ""}`;
  if (full.length <= maxChars) {
    return { full, preview: full, isTrimmed: false };
  }

  return {
    full,
    preview: `${full.slice(0, maxChars - 3)}...`,
    isTrimmed: true,
  };
}

async function copyTextToClipboard(value) {
  const text = `${value ?? ""}`;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

const ajax = async (config) => {
  const request = await fetch(config.url, {
    method: config.method,
    mode: "cors",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${Cookie.get("nt-token")}`,
      ...config.headers,
    },
    body: JSON.stringify(config.payload),
  });
  try {
    let response = await request.json();
    return response;
  } catch (error) {
    console.error("Error with fetch:", error);
    // alert error;
  }
};

const Cookie = {
  // https://stackoverflow.com/questions/4825683/how-do-i-create-and-read-a-value-from-cookie-with-javascript
  get: (name) => {
    let c = document.cookie.match(
      `(?:(?:^|.*; *)${name} *= *([^;]*).*$)|^.*$`,
    )[1];
    if (c) return decodeURIComponent(c);
  },
  set: (name, value, opts = {}) => {
    if (opts.days) {
      opts["max-age"] = opts.days * 60 * 60 * 24;
      delete opts.days;
    }

    opts = Object.entries(opts).reduce(
      (accumulatedStr, [k, v]) => `${accumulatedStr}; ${k}=${v}`,
      "",
    );

    document.cookie = name + "=" + encodeURIComponent(value) + opts;
  },
  delete: (name, opts) => Cookie.set(name, "", { "max-age": -1, ...opts }),
  // path & domain must match cookie being deleted
};

function onLoad() {
  console.log("onLoad");
  populateZrEditType();
  initZoneRecordModalActions();
  initZoneControls();
  initDangerousModeToggle();
  initNsControls();
  initUserControls();

  if (!Cookie.get("nt-token")) {
    console.log(`Cookie/token not found`);
    document.getElementById("login_div").style.display = "block";
    return;
  }

  ajax({
    method: "GET",
    url: `${API_URI}/session`,
  })
    .then((response) => {
      console.log("GET /session response", response);
      console.log(response);
      if (response?.error) {
        switch (response.message) {
          case "Token expired":
          case "Token maximum age exceeded":
            Cookie.delete("nt-token");
            document.getElementById("login_div").style.display = "block";
            break;
          default:
            console.error(response.message);
            break;
        }
      }
      if (response?.user?.id) onLoggedIn(response);
    })
    .catch((error) => {
      console.error("Error fetching session:", error);
    });
}

async function loadGroupMenu(gid, name) {
  const groupMenu = document.getElementById("group_dropdown_menu");
  if (!groupMenu) return;

  groupMenu.innerHTML = "";

  if (groupHistory.length > 0) {
    const parent = groupHistory[groupHistory.length - 1];
    const backLi = document.createElement("li");
    backLi.innerHTML = `<a class="dropdown-item text-secondary small" href="#" data-group-back="true">← ${escapeHtml(parent.name)}</a>`;
    groupMenu.appendChild(backLi);
    const sep = document.createElement("li");
    sep.innerHTML = '<hr class="dropdown-divider my-1">';
    groupMenu.appendChild(sep);
  }

  const currentLi = document.createElement("li");
  currentLi.innerHTML = `<a class="dropdown-item active" href="#" data-group-id="${gid}">${escapeHtml(name)}</a>`;
  groupMenu.appendChild(currentLi);

  try {
    const res = await ajax({ method: "GET", url: `${API_URI}/group?parent_gid=${gid}` });
    const subgroups = res?.group ?? [];
    if (subgroups.length === 0) return;

    const divider = document.createElement("li");
    divider.innerHTML = '<hr class="dropdown-divider my-1">';
    groupMenu.appendChild(divider);

    // Fetch sub-subgroups in parallel to know which items have children
    const childResults = await Promise.all(
      subgroups.map(g =>
        ajax({ method: "GET", url: `${API_URI}/group?parent_gid=${g.id}` })
          .then(r => ({ id: g.id, children: r?.group ?? [] }))
          .catch(() => ({ id: g.id, children: [] }))
      )
    );
    const childrenMap = new Map(childResults.map(s => [s.id, s.children]));

    for (const g of subgroups) {
      const children = childrenMap.get(g.id) ?? [];
      const hasChildren = children.length > 0;
      const li = document.createElement("li");

      if (hasChildren) {
        li.className = "has-submenu";
        li.innerHTML = `<a class="dropdown-item" href="#" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}"><span class="text-body-tertiary me-2">▸</span>${escapeHtml(g.name)}</a>`;
        const submenu = document.createElement("ul");
        submenu.className = "group-submenu dropdown-menu";
        for (const c of children) {
          const cLi = document.createElement("li");
          cLi.innerHTML = `<a class="dropdown-item" href="#" data-group-id="${c.id}" data-group-name="${escapeHtml(c.name)}" data-group-parent-id="${g.id}" data-group-parent-name="${escapeHtml(g.name)}">${escapeHtml(c.name)}</a>`;
          submenu.appendChild(cLi);
        }
        li.appendChild(submenu);
      } else {
        li.innerHTML = `<a class="dropdown-item" href="#" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}"><span class="invisible me-2">▸</span>${escapeHtml(g.name)}</a>`;
      }
      groupMenu.appendChild(li);
    }
  } catch (err) {
    console.error("Failed to load group menu:", err);
  }
}

function switchGroup(gid, name) {
  currentGroupId = gid;
  const groupLabel = document.getElementById("group_dropdown_label");
  if (groupLabel) groupLabel.textContent = name;
  loadGroupMenu(gid, name);
  if (zoneDataTable) {
    zoneDataTable.ajax.reload(null, true);
  } else {
    showZones();
  }
  showNameservers();
  showUsers();
}

function onLoggedIn(response) {
  document.getElementById("login_div").style.display = "none";
  document.getElementById("loggedInMain").style.display = "block";
  document.getElementById("loggedInMain").classList.add("show");

  currentUser = response.user ?? null;
  currentGroupId = response.group?.id ?? null;
  rootGroupId = currentGroupId;
  groupHistory = [];

  const groupLabel = document.getElementById("group_dropdown_label");
  const groupMenu = document.getElementById("group_dropdown_menu");
  if (groupLabel && groupMenu) {
    groupLabel.textContent = response.group?.name ?? "Group";

    if (!groupMenu.dataset.clickInitialized) {
      groupMenu.dataset.clickInitialized = "true";
      groupMenu.addEventListener("click", (e) => {
        const a = e.target.closest("a[data-group-id], a[data-group-back]");
        if (!a) return;
        e.preventDefault();

        if (a.dataset.groupBack) {
          const prev = groupHistory.pop();
          if (!prev) return;
          currentGroupId = prev.id;
          if (groupLabel) groupLabel.textContent = prev.name;
          loadGroupMenu(prev.id, prev.name);
          if (zoneDataTable) zoneDataTable.ajax.reload(null, true); else showZones();
          showNameservers();
          showUsers();
          return;
        }

        const gid = parseInt(a.dataset.groupId, 10);
        const label = a.dataset.groupName || a.textContent.replace("▸", "").trim();

        if (a.dataset.groupParentId) {
          // Submenu item — push current group AND intermediate parent to history
          const parentId = parseInt(a.dataset.groupParentId, 10);
          const parentName = a.dataset.groupParentName ?? "";
          groupHistory.push({ id: currentGroupId, name: groupLabel.textContent });
          groupHistory.push({ id: parentId, name: parentName });
          switchGroup(gid, label);
        } else {
          if (gid === currentGroupId) return;
          groupHistory.push({ id: currentGroupId, name: groupLabel.textContent });
          switchGroup(gid, label);
        }
      });
    }

    if (currentGroupId) loadGroupMenu(currentGroupId, response.group?.name ?? "Group");
  }

  fetch("/nt/config")
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg?.zone) zoneDefaults = { ...zoneDefaults, ...cfg.zone };
    })
    .catch(() => {});

  showNameservers();
  showZones();
  showUsers();
}

function onLoggedOut() {
  document.getElementById("loggedInMain").style.display = "none";
  const groupLabel = document.getElementById("group_dropdown_label");
  const groupMenu = document.getElementById("group_dropdown_menu");
  if (groupLabel) groupLabel.textContent = "Group";
  if (groupMenu) groupMenu.innerHTML = "";
  // document.getElementById('groups').style.display = 'none';
  // document.getElementById('zones').style.display = 'none';
  // document.getElementById('nameservers').style.display = 'none';
  document.getElementById("login_div").style.display = "block";
}

const ZONE_SUBGROUPS_COOKIE = "nt-zone-include-subgroups";

function initZoneControls() {
  const deletedToggle = document.getElementById("zoneSearchDeleted");
  if (!deletedToggle || deletedToggle.dataset.initialized === "true") return;
  deletedToggle.dataset.initialized = "true";
  deletedToggle.addEventListener("change", () => {
    if (!zoneDataTable) return;
    zoneDataTable.ajax.reload(null, true);
  });
}

function attemptLogin() {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  if (!username || !password) return;

  console.log("attempting login");

  try {
    ajax({
      method: "POST",
      url: `${API_URI}/session`,
      payload: { username, password },
    }).then((response) => {
      console.log("login response", response);
      if (response.session) {
        Cookie.set("nt-token", response.session.token, { days: 1 });
        onLoggedIn(response);
      }
      console.log("document.cookie", document.cookie);
    });
  } catch (error) {
    console.error("Error logging in:", error);
    alert("Login failed. Please check your username and password.");
  }
}

function attemptLogout() {
  console.log("attempting logout");
  ajax({
    method: "DELETE",
    url: `${API_URI}/session`,
  })
    .then((response) => {
      // console.log('logout response', response);
      if (response) {
        Cookie.delete("nt-token");
        onLoggedOut();
      }
    })
    .catch((error) => {
      console.error("Error logging out:", error);
      // alert('Logout failed. Please try again.');
    });

  return false;
}

function showNameservers() {
  const params = new URLSearchParams();
  if (currentGroupId) params.set("gid", `${currentGroupId}`);
  if (document.getElementById("nsShowDeleted")?.checked) params.set("deleted", "true");

  ajax({
    method: "GET",
    url: `${API_URI}/nameserver?${params.toString()}`,
  }).then((response) => {
    const table = document.getElementById("ns_table");
    const tableHead = table.querySelector("thead");

    while (tableHead.rows.length > 1) {
      tableHead.deleteRow(1);
    }

    if (nsDataTable) {
      nsDataTable.destroy();
      nsDataTable = undefined;
    }

    const body = table.querySelector("tbody");
    body.innerHTML = "";

    const sorted = (response.nameserver ?? [])
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id));

    for (const ns of sorted) {
      const row = document.createElement("tr");
      row.classList.add("accordion-item");
      row.id = `ns_${ns.id}_tr`;
      if (ns.deleted) row.classList.add("text-body-secondary");

      let nameCell = escapeHtml(ns.name ?? "");
      try {
        // Validate the name is parseable — flag rows with missing trailing dot or other issues
        if (ns.name && !ns.name.endsWith(".")) {
          nameCell = `${nameCell} <span class="badge text-bg-warning ms-1" title="Name is missing a trailing dot">!</span>`;
        }
      } catch (e) {
        nameCell = `${nameCell} <span class="badge text-bg-danger ms-1" title="${escapeHtml(e.message)}">invalid</span>`;
      }

      const actionButtons = ns.deleted
        ? `<button type="button" class="btn btn-sm btn-link text-success p-0 ns-restore-btn" style="text-decoration:none;font-size:0.85rem;line-height:1;" aria-label="Restore nameserver" title="Restore nameserver">↩ Restore</button>`
        : `<div class="d-inline-flex align-items-center gap-2"><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 ns-edit-btn" style="text-decoration:none;font-size:0.9rem;line-height:1;" aria-label="Edit nameserver">✎</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 ns-delete-btn" style="text-decoration:none;font-size:0.9rem;line-height:1;" aria-label="Delete nameserver" title="Delete nameserver">🗑</button></div>`;

      row.innerHTML = `
        <td>${nameCell}</td>
        <td>${escapeHtml(ns.description ?? "")}</td>
        <td style="text-align: right;">${escapeHtml(ns.address ?? "")}</td>
        <td style="text-align: right;">${escapeHtml(ns.address6 ?? "")}</td>
        <td style="text-align: center">${escapeHtml(ns.export?.type ?? "")}</td>
        <td style="text-align: center">${actionButtons}</td>
      `;

      row.querySelector(".ns-edit-btn")?.addEventListener("click", () => openNsPane(ns));
      row.querySelector(".ns-delete-btn")?.addEventListener("click", () => {
        if (isConfirmDeletesEnabled()) {
          const confirmed = window.confirm(`Delete nameserver ${ns.name}?`);
          if (!confirmed) return;
        }
        ajax({ method: "DELETE", url: `${API_URI}/nameserver/${ns.id}` }).then((r) => {
          if (r?.error) { console.error("Delete NS failed:", r); return; }
          showNameservers();
        });
      });
      row.querySelector(".ns-restore-btn")?.addEventListener("click", () => {
        ajax({ method: "PUT", url: `${API_URI}/nameserver/${ns.id}`, payload: { deleted: false } }).then((r) => {
          if (r?.error) { console.error("Restore NS failed:", r); return; }
          showNameservers();
        });
      });

      body.appendChild(row);
    }

    const nsPageLength = 25;
    const hasSearch = sorted.length >= nsPageLength;
    let filterRow;
    if (hasSearch) {
      filterRow = tableHead.rows[0].cloneNode(true);
      filterRow.classList.add("ns-filter-row");
      for (let i = 0; i < filterRow.cells.length; i++) {
        const cell = filterRow.cells[i];
        if (i === filterRow.cells.length - 1) {
          cell.innerHTML = "";
          continue;
        }
        const title = tableHead.rows[0].cells[i].textContent.trim();
        cell.innerHTML = `<input type="search" class="form-control form-control-sm" placeholder="Search ${title}" aria-label="Search ${title}">`;
      }
      tableHead.appendChild(filterRow);
    }

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "btn btn-sm btn-outline-secondary";
    createBtn.textContent = "+ Create";
    createBtn.addEventListener("click", () => openNsPane(null));

    nsDataTable = new DataTable(table, {
      orderCellsTop: true,
      pageLength: nsPageLength,
      lengthMenu: [10, 25, 50, 100],
      layout: { topEnd: null },
      columnDefs: [
        { orderable: false, searchable: false, targets: [5] },
      ],
      initComplete() {
        const api = this.api();
        if (hasSearch && filterRow) {
          api.columns().every(function (index) {
            const input = filterRow.cells[index].querySelector("input");
            if (!input) return;
            input.addEventListener("input", () => {
              if (this.search() !== input.value) this.search(input.value).draw();
            });
          });
        }
        // Place Create button in the top-right of the DataTable toolbar row
        const container = api.table().container();
        const topRow = container.querySelectorAll(".dt-layout-row")[0];
        if (topRow) {
          topRow.style.display = "flex";
          topRow.style.alignItems = "center";
          const btnCell = document.createElement("div");
          btnCell.style.marginLeft = "auto";
          btnCell.appendChild(createBtn);
          topRow.appendChild(btnCell);
        }
      },
    });
  });
}

let activeNsContext = null;

function openNsPane(ns) {
  activeNsContext = ns ? { mode: "edit", ns } : { mode: "create" };
  const isCreate = !ns;
  document.getElementById("nsEditPaneLabel").textContent = isCreate ? "Create Nameserver" : "Edit Nameserver";
  document.getElementById("nsEditName").value        = ns?.name        ?? "";
  document.getElementById("nsEditDescription").value = ns?.description ?? "";
  document.getElementById("nsEditTtl").value         = ns?.ttl         ?? 86400;
  document.getElementById("nsEditAddress").value     = ns?.address     ?? "";
  document.getElementById("nsEditAddress6").value    = ns?.address6    ?? "";
  document.getElementById("nsEditExportType").value  = ns?.export?.type ?? "bind";
  document.getElementById("nsEditSaveBtn").textContent = isCreate ? "Create" : "Save";
  bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("nsEditPane")).show();
}

function initNsControls() {
  const deletedToggle = document.getElementById("nsShowDeleted");
  if (deletedToggle && !deletedToggle.dataset.initialized) {
    deletedToggle.dataset.initialized = "true";
    deletedToggle.addEventListener("change", () => showNameservers());
  }

  const saveBtn = document.getElementById("nsEditSaveBtn");
  if (saveBtn && !saveBtn.dataset.initialized) {
    saveBtn.dataset.initialized = "true";
    saveBtn.addEventListener("click", async () => {
      const ctx = activeNsContext;
      if (!ctx) return;

      const name = document.getElementById("nsEditName").value.trim();
      if (!name) { alert("Name is required."); return; }

      const ttlRaw = parseInt(document.getElementById("nsEditTtl").value, 10);
      const payload = {
        name,
        description: document.getElementById("nsEditDescription").value.trim(),
        ttl: Number.isFinite(ttlRaw) ? ttlRaw : 86400,
        address:  document.getElementById("nsEditAddress").value.trim() || undefined,
        address6: document.getElementById("nsEditAddress6").value.trim() || undefined,
        export: { type: document.getElementById("nsEditExportType").value },
      };
      if (ctx.mode === "create") payload.gid = currentGroupId;

      const method = ctx.mode === "create" ? "POST" : "PUT";
      const url    = ctx.mode === "create"
        ? `${API_URI}/nameserver`
        : `${API_URI}/nameserver/${ctx.ns.id}`;

      saveBtn.disabled = true;
      try {
        const response = await ajax({ method, url, payload });
        if (!response || response?.error) {
          alert(response?.message ?? "Save failed. See console for details.");
          return;
        }
        bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("nsEditPane")).hide();
        showNameservers();
      } catch (err) {
        console.error("NS save failed:", err);
        alert("Save failed due to a network error.");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

function showUsers() {
  const params = new URLSearchParams();
  if (currentGroupId) params.set("gid", `${currentGroupId}`);
  if (document.getElementById("userShowDeleted")?.checked) params.set("deleted", "true");

  ajax({
    method: "GET",
    url: `${API_URI}/user${params.toString() ? "?" + params.toString() : ""}`,
  }).then((response) => {
    const table = document.getElementById("user_table");
    const tableHead = table.querySelector("thead");

    while (tableHead.rows.length > 1) {
      tableHead.deleteRow(1);
    }

    if (userDataTable) {
      userDataTable.destroy();
      userDataTable = undefined;
    }

    const body = table.querySelector("tbody");
    body.innerHTML = "";

    const sorted = (response.user ?? [])
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id));

    for (const u of sorted) {
      const row = document.createElement("tr");
      row.id = `user_${u.id}_tr`;
      if (u.deleted) row.classList.add("text-body-secondary");
      row.innerHTML = `
        <td>${escapeHtml(u.username ?? "")}</td>
        <td>${escapeHtml((u.first_name ?? "") + (u.last_name ? " " + u.last_name : ""))}</td>
        <td>${escapeHtml(u.email ?? "")}</td>
        <td style="text-align: center; white-space: nowrap"><div class="d-inline-flex align-items-center gap-2"><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 user-edit-btn" style="text-decoration:none;font-size:0.9rem;line-height:1;" aria-label="Edit user">✎</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 user-delete-btn" style="text-decoration:none;font-size:0.9rem;line-height:1;" aria-label="Delete user" title="Delete user">🗑</button></div></td>
      `;
      row.querySelector(".user-edit-btn").addEventListener("click", () => openUserPane(u));
      row.querySelector(".user-delete-btn").addEventListener("click", () => {
        if (isConfirmDeletesEnabled()) {
          const confirmed = window.confirm(`Delete user ${u.username}?`);
          if (!confirmed) return;
        }
        ajax({ method: "DELETE", url: `${API_URI}/user/${u.id}` }).then((response) => {
          if (response?.error) { console.error("Delete user failed:", response); return; }
          showUsers();
        });
      });
      body.appendChild(row);
    }

    const filterRow = tableHead.rows[0].cloneNode(true);
    filterRow.classList.add("user-filter-row");
    for (let i = 0; i < filterRow.cells.length; i++) {
      const cell = filterRow.cells[i];
      if (i === filterRow.cells.length - 1) { cell.innerHTML = ""; continue; }
      const title = tableHead.rows[0].cells[i].textContent.trim();
      cell.innerHTML = `<input type="search" class="form-control form-control-sm" placeholder="Search ${title}" aria-label="Search ${title}">`;
    }
    tableHead.appendChild(filterRow);

    userDataTable = new DataTable(table, {
      orderCellsTop: true,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100],
      layout: { topEnd: null },
      columnDefs: [
        { orderable: false, searchable: false, targets: [3] },
      ],
      initComplete() {
        const api = this.api();
        api.columns().every(function (index) {
          const input = filterRow.cells[index].querySelector("input");
          if (!input) return;
          input.addEventListener("input", () => {
            if (this.search() !== input.value) this.search(input.value).draw();
          });
        });
        const actionsCell = filterRow.cells[filterRow.cells.length - 1];
        const createBtn = document.createElement("button");
        createBtn.type = "button";
        createBtn.className = "btn btn-sm btn-outline-secondary";
        createBtn.textContent = "+ Create";
        createBtn.addEventListener("click", () => openUserPane(null));
        actionsCell.appendChild(createBtn);
      },
    });
  });
}

let activeUserContext = null;

function openUserPane(user) {
  activeUserContext = user ? { mode: "edit", user } : { mode: "create" };
  const isCreate = !user;
  document.getElementById("userEditPaneLabel").textContent = isCreate ? "Create User" : "Edit User";
  document.getElementById("userEditUsername").value   = user?.username   ?? "";
  document.getElementById("userEditFirstName").value  = user?.first_name ?? "";
  document.getElementById("userEditLastName").value   = user?.last_name  ?? "";
  document.getElementById("userEditEmail").value      = user?.email      ?? "";
  document.getElementById("userEditPassword").value   = "";
  document.getElementById("userEditIsAdmin").checked  = user?.is_admin   ?? false;
  document.getElementById("userEditSaveBtn").textContent = isCreate ? "Create" : "Save";
  bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("userEditPane")).show();
}

function initUserControls() {
  const deletedToggle = document.getElementById("userShowDeleted");
  if (deletedToggle && !deletedToggle.dataset.initialized) {
    deletedToggle.dataset.initialized = "true";
    deletedToggle.addEventListener("change", () => showUsers());
  }

  const pwField = document.getElementById("userEditPassword");
  const hintsEl = document.getElementById("userPasswordHints");
  if (pwField && hintsEl && !pwField.dataset.hintsInitialized) {
    pwField.dataset.hintsInitialized = "true";
    const checkHint = (id, ok) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = ok ? "text-success" : "text-danger";
      el.textContent = `${ok ? "✓" : "✗"} ${el.dataset.msg}`;
    };
    pwField.addEventListener("input", () => {
      const v = pwField.value;
      if (!v) { hintsEl.classList.add("d-none"); return; }
      hintsEl.classList.remove("d-none");
      checkHint("pwHintLength",  v.length >= 8);
      checkHint("pwHintUpper",   (v.match(/[A-Z]/g) ?? []).length >= 2);
      checkHint("pwHintLower",   (v.match(/[a-z]/g) ?? []).length >= 2);
      checkHint("pwHintNumber",  (v.match(/[0-9]/g) ?? []).length >= 2);
      checkHint("pwHintSpecial", (v.match(/[^a-zA-Z0-9]/g) ?? []).length >= 2);
      const vl = v.toLowerCase();
      checkHint("pwHintBanned",  !["password","abc","123","asdf"].some(s => vl.includes(s)));
    });
  }

  const saveBtn = document.getElementById("userEditSaveBtn");
  if (saveBtn && !saveBtn.dataset.initialized) {
    saveBtn.dataset.initialized = "true";
    saveBtn.addEventListener("click", async () => {
      const ctx = activeUserContext;
      if (!ctx) return;

      const username = document.getElementById("userEditUsername").value.trim();
      if (!username) { alert("Username is required."); return; }

      const payload = {
        username,
        is_admin: document.getElementById("userEditIsAdmin").checked,
      };
      const firstName = document.getElementById("userEditFirstName").value.trim();
      const lastName  = document.getElementById("userEditLastName").value.trim();
      const email     = document.getElementById("userEditEmail").value.trim();
      const password  = document.getElementById("userEditPassword").value;
      if (firstName) payload.first_name = firstName;
      if (lastName)  payload.last_name  = lastName;
      if (email)     payload.email      = email;
      if (password)  payload.password   = password;
      if (ctx.mode === "create") payload.gid = currentGroupId;

      const method = ctx.mode === "create" ? "POST" : "PUT";
      const url    = ctx.mode === "create"
        ? `${API_URI}/user`
        : `${API_URI}/user/${ctx.user.id}`;

      saveBtn.disabled = true;
      try {
        const response = await ajax({ method, url, payload });
        if (!response || response?.error) {
          alert(response?.message ?? "Save failed. See console for details.");
          return;
        }
        bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("userEditPane")).hide();
        showUsers();
      } catch (err) {
        console.error("User save failed:", err);
        alert("Save failed due to a network error.");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

function showZones() {
  const ztbody = document.getElementById("zone_tbody");
  if (!ztbody) return;
  const table = document.getElementById("zone_table");
  if (!table) return;

  if (zoneDataTable) {
    zoneDataTable.ajax.reload();
    return;
  }

  const tableHead = table.querySelector("thead");
  while (tableHead.rows.length > 1) {
    tableHead.deleteRow(1);
  }

  const filterRow = tableHead.rows[0].cloneNode(true);
  filterRow.classList.add("zone-filter-row");
  for (let i = 0; i < filterRow.cells.length; i++) {
    if (i === 0 || i === filterRow.cells.length - 1) {
      filterRow.cells[i].innerHTML = "";
      continue;
    }
    const title = tableHead.rows[0].cells[i].textContent.trim();
    filterRow.cells[i].innerHTML = `<input type="search" class="form-control form-control-sm" placeholder="Search ${title}" aria-label="Search ${title}">`;
  }
  tableHead.appendChild(filterRow);

  zoneDataTable = new DataTable(table, {
    processing: true,
    serverSide: true,
    searchDelay: 400,
    orderCellsTop: true,
    pageLength: 25,
    lengthMenu: [10, 25, 50, 100],
    layout: { topEnd: null },
    columnDefs: [{ orderable: false, searchable: false, targets: [0, 3] }],
    order: [[1, "asc"]],
    columns: [
      {
        data: null,
        defaultContent: '<span class="zone-toggle-icon" aria-hidden="true">▸</span>',
        className: "text-center",
      },
      { data: "zone", defaultContent: "", className: "zone-name-toggle" },
      { data: "description", defaultContent: "" },
      {
        data: null,
        className: "text-center",
        render(rowData) {
          if (rowData?.deleted) {
            return `<div class="d-inline-flex"><button type="button" class="btn btn-sm btn-link text-success p-0 zone-restore-btn" aria-label="Restore zone" title="Restore zone" style="text-decoration:none;font-size:0.9rem;line-height:1;">↩ Restore</button></div>`;
          }
          return `<div class="d-inline-flex align-items-center gap-2"><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-add-zr-btn" aria-label="Add resource record" title="Add resource record" style="text-decoration: none; font-size: 1rem; line-height: 1;">+</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-edit-btn" aria-label="Edit zone" title="Edit zone" style="text-decoration: none; font-size: 0.9rem; line-height: 1;">✎</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-delete-btn" aria-label="Delete zone" title="Delete zone" style="text-decoration: none; font-size: 0.9rem; line-height: 1;">🗑</button></div>`;
        },
      },
    ],
    async ajax(data, callback) {
      const params = new URLSearchParams();
      params.set("limit", `${data.length}`);
      params.set("offset", `${data.start}`);

      const includeDeleted = document.getElementById("zoneSearchDeleted")?.checked === true;
      if (includeDeleted) params.set("deleted", "true");
      if (currentGroupId) params.set("gid", `${currentGroupId}`);
      if (document.getElementById("zoneIncludeSubgroups")?.checked) params.set("include_subgroups", "true");

      const globalSearch = `${data.search?.value ?? ""}`.trim();
      if (globalSearch) params.set("search", globalSearch);

      const zoneLike = `${data.columns?.[1]?.search?.value ?? ""}`.trim();
      if (zoneLike) params.set("zone_like", zoneLike);

      const descriptionLike = `${data.columns?.[2]?.search?.value ?? ""}`.trim();
      if (descriptionLike) params.set("description_like", descriptionLike);

      const order = data.order?.[0] ?? { column: 1, dir: "asc" };
      const sortBy = { 1: "zone", 2: "description" }[order.column] ?? "zone";
      params.set("sort_by", sortBy);
      params.set("sort_dir", order.dir === "desc" ? "desc" : "asc");

      const response = await ajax({
        method: "GET",
        url: `${API_URI}/zone?${params.toString()}`,
      });

      const rows = response?.zone ?? [];
      const total = response?.meta?.pagination?.total ?? rows.length;
      const filtered = response?.meta?.pagination?.filtered ?? total;

      callback({
        data: rows,
        recordsTotal: total,
        recordsFiltered: filtered,
      });
    },
    createdRow(row, data) {
      row.id = `zone_${data.id}_tr`;
      row.dataset.zoneId = `${data.id}`;
      row.classList.add("zone-row");
      if (row.cells[0]) {
        row.cells[0].classList.add("zone-disclosure");
        row.cells[0].setAttribute("title", "Expand/collapse zone records");
      }
      if (row.cells[1]) {
        row.cells[1].classList.add("zone-name-toggle");
        row.cells[1].setAttribute("title", "Click to expand/collapse zone records");
      }
      setZoneRowOpenState(row, false);
    },
    initComplete() {
      const api = this.api();

      // Rebuild Zone column cell with search input + subgroups toggle on the same line
      const zoneSearchCell = filterRow.cells[1];
      if (zoneSearchCell && !document.getElementById("zoneIncludeSubgroups")) {
        zoneSearchCell.innerHTML = `
          <div class="d-flex align-items-center gap-2">
            <input type="search" class="form-control form-control-sm" placeholder="Search Zone" aria-label="Search Zone" style="min-width:0;flex:1 1 auto;">
            <div class="form-check form-switch mb-0 text-nowrap flex-shrink-0">
              <input class="form-check-input" type="checkbox" role="switch" id="zoneIncludeSubgroups" style="cursor:pointer;">
              <label class="form-check-label small text-body-secondary" for="zoneIncludeSubgroups">Subgroups</label>
            </div>
          </div>`;
        const subgroupToggle = document.getElementById("zoneIncludeSubgroups");
        subgroupToggle.checked = Cookie.get(ZONE_SUBGROUPS_COOKIE) === "1";
        subgroupToggle.addEventListener("change", () => {
          Cookie.set(ZONE_SUBGROUPS_COOKIE, subgroupToggle.checked ? "1" : "0", { days: 365 });
          if (zoneDataTable) zoneDataTable.ajax.reload(null, true);
        });
      }

      // Bind column search inputs (after cell rebuild so the final inputs are found)
      api.columns().every(function (index) {
        const input = filterRow.cells[index].querySelector("input[type='search']");
        if (!input) return;
        input.addEventListener("input", () => {
          clearTimeout(zoneColumnSearchTimers.get(index));
          zoneColumnSearchTimers.set(
            index,
            setTimeout(() => {
              if (this.search() !== input.value) {
                this.search(input.value).draw();
              }
            }, 400),
          );
        });
      });

      // Add "+ Create Zone" button to Actions column of filter row
      const actionsCell = filterRow.cells[filterRow.cells.length - 1];
      const createBtn = document.createElement("button");
      createBtn.type = "button";
      createBtn.className = "btn btn-sm btn-outline-secondary";
      createBtn.title = "Create new zone";
      createBtn.setAttribute("aria-label", "Create new zone");
      createBtn.textContent = "+ Create";
      createBtn.addEventListener("click", () => openCreateZoneModal());
      actionsCell.appendChild(createBtn);
    },
  });

  ztbody.onclick = (event) => {
    const addRecordButton = event.target.closest("button.zone-add-zr-btn");
    if (addRecordButton) {
      const tr = addRecordButton.closest("tr");
      if (!tr) return;

      const row = zoneDataTable.row(tr);
      const zone = row.data();
      if (!zone) return;

      openCreateZoneRecordModal(zone);
      return;
    }

    const zoneEditButton = event.target.closest("button.zone-edit-btn");
    if (zoneEditButton) {
      const tr = zoneEditButton.closest("tr");
      if (!tr) return;

      const row = zoneDataTable.row(tr);
      const zone = row.data();
      if (!zone) return;

      openEditZoneModal(zone);
      return;
    }

    const zoneRestoreButton = event.target.closest("button.zone-restore-btn");
    if (zoneRestoreButton) {
      const tr = zoneRestoreButton.closest("tr");
      if (!tr) return;

      const row = zoneDataTable.row(tr);
      const zone = row.data();
      if (!zone) return;

      ajax({
        method: "PUT",
        url: `${API_URI}/zone/${zone.id}`,
        payload: { deleted: false },
      }).then((response) => {
        if (response?.error) {
          console.error("Restore zone failed:", response);
          return;
        }
        zoneDataTable.ajax.reload(null, false);
      });
      return;
    }

    const deleteButton = event.target.closest("button.zone-delete-btn");
    if (deleteButton) {
      const tr = deleteButton.closest("tr");
      if (!tr) return;

      const row = zoneDataTable.row(tr);
      const zone = row.data();
      if (!zone) return;

      if (isConfirmDeletesEnabled()) {
        const confirmed = window.confirm(
          `Delete zone ${zone.zone}? This hides it from default views.`,
        );
        if (!confirmed) return;
      }

      ajax({
        method: "DELETE",
        url: `${API_URI}/zone/${zone.id}`,
      }).then((response) => {
        if (response?.error) {
          console.error("Delete zone failed:", response);
          return;
        }

        const zrTable = zoneRecordDataTables.get(zone.id);
        if (zrTable) {
          zrTable.destroy();
          zoneRecordDataTables.delete(zone.id);
        }

        zoneDataTable.ajax.reload(null, false);
      });
      return;
    }

    const toggleCell = event.target.closest("td.zone-disclosure, td.zone-name-toggle");
    if (!toggleCell) return;

    const tr = toggleCell.closest("tr");
    if (!tr) return;

    const row = zoneDataTable.row(tr);
    const zone = row.data();
    if (!zone) return;

    if (row.child.isShown()) {
      const zrTable = zoneRecordDataTables.get(zone.id);
      if (zrTable) {
        zrTable.destroy();
        zoneRecordDataTables.delete(zone.id);
      }

      row.child.hide();
      tr.classList.remove("shown");
      setZoneRowOpenState(tr, false);
      return;
    }

    row.child(`
          <div class="accordion-body zone-records-panel">
            <table id="zone_${zone.id}_table" class="table table-md table-striped table-hover table-bordered zone-records-table">
                        <thead>
                            <tr>
                                <th style="display:none"></th>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Data</th>
                                <th>TTL</th>
                  <th style="text-align: center; width: 4rem;">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="zone_${zone.id}_tbody"></tbody>
                    </table>
                </div>
            `).show();
    tr.classList.add("shown");
    setZoneRowOpenState(tr, true);
    showZoneRecords(zone);
  };
}

function syntheticOwnerDisplay(owner, zone) {
  const zoneFqdn = `${zone.zone}`.endsWith(".") ? zone.zone : `${zone.zone}.`;
  return owner === zoneFqdn ? "@" : owner;
}

function unqualifyHost(host, zoneFqdn) {
  if (!host) return host;
  const fqdn = zoneFqdn.endsWith(".") ? zoneFqdn : `${zoneFqdn}.`;
  const h    = host.endsWith(".")    ? host    : `${host}.`;
  if (h === fqdn) return "@";
  const suffix = `.${fqdn}`;
  if (h.endsWith(suffix)) return h.slice(0, -suffix.length);
  return h;
}

function buildSyntheticSoaRow(zone) {
  const zoneFqdn = `${zone.zone}`.endsWith(".") ? zone.zone : `${zone.zone}.`;
  const mname = Array.isArray(zone.nameservers) && zone.nameservers.length
    ? (zone.nameservers[0].endsWith(".") ? zone.nameservers[0] : `${zone.nameservers[0]}.`)
    : `ns1.${zoneFqdn}`;
  const rname = zone.mailaddr
    ? (zone.mailaddr.endsWith(".") ? zone.mailaddr : `${zone.mailaddr}.`)
    : `hostmaster.${zoneFqdn}`;
  const serial  = zone.serial  ?? 0;
  const refresh = zone.refresh ?? 86400;
  const retry   = zone.retry   ?? 7200;
  const expire  = zone.expire  ?? 1209600;
  const minimum = zone.minimum ?? 3600;
  const rdata = `${unqualifyHost(mname, zoneFqdn)} ${unqualifyHost(rname, zoneFqdn)} ${serial} ${refresh} ${retry} ${expire} ${minimum}`;

  const row = document.createElement("tr");
  row.classList.add("zone-record-soa");
  row.innerHTML = `
    <td style="display:none">0</td>
    <td class="small text-muted">@</td>
    <td class="small text-muted">SOA</td>
    <td class="small text-muted" style="width: 50%;">
      <span class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(rdata)}">${escapeHtml(rdata)}</span>
    </td>
    <td class="small text-muted">${escapeHtml(formatZoneRecordTtl(zone.ttl))}</td>
    <td class="small text-center"></td>
  `;
  return row;
}

function buildSyntheticNsRow(zr, zone) {
  const zoneFqdn = `${zone.zone}`.endsWith(".") ? zone.zone : `${zone.zone}.`;
  const ownerDisplay = escapeHtml(syntheticOwnerDisplay(zr.owner, zone));
  const rdata = escapeHtml(unqualifyHost(zr.dname ?? "", zoneFqdn));
  const row = document.createElement("tr");
  row.classList.add("zone-record-synthetic");
  row.innerHTML = `
    <td style="display:none">1</td>
    <td class="small text-muted">${ownerDisplay}</td>
    <td class="small text-muted">NS</td>
    <td class="small text-muted" style="width: 50%;">
      <span class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${rdata}">${rdata}</span>
    </td>
    <td class="small text-muted">${escapeHtml(formatZoneRecordTtl(zr.ttl))}</td>
    <td class="small text-center"></td>
  `;
  return row;
}

function showZoneRecords(zone) {
  const zrTable = zoneRecordDataTables.get(zone.id);
  if (zrTable) {
    // Remove the custom info element inserted before the dt-container
    const container = zrTable.table().container();
    const prev = container?.previousElementSibling;
    if (prev?.classList.contains("text-body-secondary")) prev.remove();
    zrTable.destroy();
    zoneRecordDataTables.delete(zone.id);
  }

  const table = document.getElementById(`zone_${zone.id}_table`);
  if (!table) return;

  const tbody = document.getElementById(`zone_${zone.id}_tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";

  tbody.appendChild(buildSyntheticSoaRow(zone));

  Promise.all([
    ajax({ method: "GET", url: `${API_URI}/zone_record/?zid=${zone.id}` }),
    ajax({ method: "GET", url: `${API_URI}/zone/${zone.id}/ns` }),
  ]).then(([response, nsResponse]) => {
    for (const ns of nsResponse?.ns ?? []) {
      tbody.appendChild(buildSyntheticNsRow(ns, zone));
    }

    // console.log('GET /zone_record response', response);

    const hasDescriptions = response.zone_record.some((zr) => zr.description);
    if (hasDescriptions) {
      const thead = table.querySelector("thead tr");
      if (thead) {
        const actionsTh = thead.lastElementChild;
        const descTh = document.createElement("th");
        descTh.textContent = "Description";
        thead.insertBefore(descTh, actionsTh);
      }
      for (const row of tbody.rows) {
        const emptyTd = document.createElement("td");
        emptyTd.className = "small text-muted";
        row.insertBefore(emptyTd, row.lastElementChild);
      }
    }

    const zoneFqdn = `${zone.zone}`.endsWith(".") ? zone.zone : `${zone.zone}.`;

    for (const zr of response.zone_record) {
      const row = document.createElement("tr");
      try {
        const owner =
          zr.owner === zoneFqdn
            ? zr.owner
            : zr.owner.endsWith(zoneFqdn)
              ? zr.owner
              : `${zr.owner}.${zoneFqdn}`;
        const rrCtor = RR[zr.type];
        const asRR = new rrCtor({ ...zr, owner, type: rrCtor.name });
        row.asRR = asRR;
        zr.rdata = asRR
          .getRdataFields()
          .map((f) => {
            if (zr.type === "AAAA" && f === "address") return asRR.getCompressed();
            return asRR.get(f);
          })
          .join(" ");
      } catch (error) {
        console.error("Error creating RR:", error);
      }
      row.id = `zr_${zr.id}_tr`;

      const ownerDisplay = escapeHtml(zr.owner === zoneFqdn ? "@" : zr.owner);
      const typeDisplay = escapeHtml(zr.type);
      const ttlDisplay = escapeHtml(formatZoneRecordTtl(zr.ttl));
      const rdataInfo = getRdataPreview(zr.rdata);
      const rdataDisplay = escapeHtml(rdataInfo.preview);
      const rdataFull = escapeHtml(rdataInfo.full);
      const trimmedMarker = rdataInfo.isTrimmed
        ? `<span class="text-muted ms-1">[trimmed]</span>`
        : "";
      const copyButtonHtml = rdataInfo.isTrimmed
        ? `<button
                      type="button"
                      class="btn btn-sm btn-outline-secondary zr-copy-btn"
                      aria-label="Copy record data"
                      title="Copy full value"
                      style="padding-top:0.09rem;padding-bottom:0.09rem;"
                    >Copy</button>`
        : "";
      const editButtonHtml = `<button
                      type="button"
                      class="btn btn-sm btn-link text-body-secondary p-0 zr-edit-btn"
                      aria-label="Edit zone record"
                      title="Edit zone record"
                      style="text-decoration: none; font-size: 0.9rem; line-height: 1;"
                    >✎</button>`;
      const deleteButtonHtml = `<button
                      type="button"
                      class="btn btn-sm btn-link text-body-secondary p-0 zr-delete-btn"
                      aria-label="Delete zone record"
                      title="Delete zone record"
                      style="text-decoration: none; font-size: 0.95rem; line-height: 1;"
                    >🗑</button>`;

      const dataCellAttrs = rdataInfo.isTrimmed
        ? 'class="small" style="width:50%;font-size:0.75em;"'
        : 'class="small" style="width:50%;"';
      const dataSpanAttrs = rdataInfo.isTrimmed
        ? `title="${rdataFull}"`
        : `class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${rdataFull}"`;
      const dataWrapperAttrs = rdataInfo.isTrimmed
        ? 'class="d-flex flex-wrap align-items-center gap-2"'
        : 'class="d-flex align-items-center gap-2" style="min-width:0;"';
      row.innerHTML = `
                <td style="display:none">2</td>
                <td class="small" id="zr_${zr.id}_td">${ownerDisplay}</td>
                <td class="small">${typeDisplay}</td>
                <td ${dataCellAttrs}>
                  <div ${dataWrapperAttrs}>
                    <span ${dataSpanAttrs}>${rdataDisplay}</span>${trimmedMarker}
                    ${copyButtonHtml}
                  </div>
                </td>
                <td class="small">${ttlDisplay}</td>
                ${hasDescriptions ? `<td class="small text-muted">${escapeHtml(zr.description ?? "")}</td>` : ""}
                <td class="small text-center"><div class="d-inline-flex align-items-center gap-1">${editButtonHtml}${deleteButtonHtml}</div></td>
            `;
      tbody.appendChild(row);

      const copyButton = row.querySelector(".zr-copy-btn");
      if (copyButton) {
        const rawRdata = rdataInfo.full;
        copyButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          event.preventDefault();

          const ok = await copyTextToClipboard(rawRdata);

          const original = copyButton.textContent;
          copyButton.textContent = ok ? "Copied" : "Copy failed";
          setTimeout(() => {
            copyButton.textContent = original;
          }, 1200);
        });
      }

      const editButton = row.querySelector(".zr-edit-btn");
      if (editButton) {
        editButton.addEventListener("click", (event) => {
          event.stopPropagation();
          event.preventDefault();
          activeZoneRecordContext = { zone, zr, mode: "edit" };
          setZoneRecordModalMode("edit");
          editZoneRecord(zone, zr, row.asRR);
          const modalEl = document.getElementById("zrEditModal");
          const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
          modal.show();
        });
      }

      const deleteButton = row.querySelector(".zr-delete-btn");
      if (deleteButton) {
        deleteButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          event.preventDefault();

          deleteButton.disabled = true;
          try {
            const response = await ajax({
              method: "DELETE",
              url: `${API_URI}/zone_record/${zr.id}`,
            });

            if (!response || response?.error) {
              console.error("Delete zone record failed:", response);
              alert(response?.message ?? "Delete failed. See console for details.");
              return;
            }

            showZoneRecords(zone);
          } catch (error) {
            console.error("Delete zone record request failed:", error);
            alert("Delete failed due to a network or server error.");
          } finally {
            deleteButton.disabled = false;
          }
        });
      }

      document
        .getElementById(`zr_${zr.id}_tr`)
        .addEventListener("click", (event) => {
          if (event.target.closest(".zr-copy-btn, .zr-delete-btn, .zr-edit-btn")) return;

          activeZoneRecordContext = { zone, zr, mode: "edit" };
          setZoneRecordModalMode("edit");
          editZoneRecord(zone, zr, row.asRR);
          const modalEl = document.getElementById("zrEditModal");
          const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
          modal.show();
        });
    }

    const hasTableControls = response.zone_record.length > 10;

    // Build merged info/length control element
    const infoEl = document.createElement("div");
    infoEl.className = "small text-body-secondary py-1";

    let pageLenSelect = null;
    if (hasTableControls) {
      pageLenSelect = document.createElement("select");
      pageLenSelect.className = "form-select form-select-sm d-inline-block";
      pageLenSelect.style.cssText = "width:auto;padding:0.1rem 1.5rem 0.1rem 0.4rem;font-size:inherit;vertical-align:baseline;";
      for (const n of [10, 25, 50]) {
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = n;
        if (n === 10) opt.selected = true;
        pageLenSelect.appendChild(opt);
      }
    }

    let zrDt;
    const updateInfoEl = (api) => {
      const dtApi = api ?? zrDt;
      if (!dtApi) return;
      const pg = dtApi.page.info();
      infoEl.innerHTML = "";
      if (hasTableControls) {
        infoEl.appendChild(document.createTextNode(`Showing ${pg.start + 1} to `));
        infoEl.appendChild(pageLenSelect);
        infoEl.appendChild(document.createTextNode(` of ${pg.recordsDisplay} resource records`));
      } else {
        infoEl.textContent = `Showing ${pg.start + 1} to ${pg.end} of ${pg.recordsDisplay} resource records`;
      }
    };

    if (pageLenSelect) {
      pageLenSelect.addEventListener("change", () => {
        zrDt?.page.len(+pageLenSelect.value).draw();
      });
    }

    zrDt = new DataTable(table, {
      order: [[0, "asc"], [1, "asc"]],
      orderFixed: { pre: [[0, "asc"]] },
      pageLength: 10,
      searching: false,
      paging: hasTableControls,
      info: false,
      lengthChange: false,
      layout: {
        topStart: null,
        topEnd: null,
        bottomStart: null,
      },
      columnDefs: [
        { visible: false, orderable: false, searchable: false, targets: [0] },
        { orderable: false, searchable: false, targets: [-1] },
      ],
      initComplete() {
        const api = this.api();
        const container = api.table().container();
        container.parentElement.insertBefore(infoEl, container);
        updateInfoEl(api);
      },
      drawCallback() {
        updateInfoEl();
      },
    });
    zoneRecordDataTables.set(zone.id, zrDt);
  });
}

function openCreateZoneModal() {
  const textFields = ["zoneCreateZone", "zoneCreateDescription", "zoneCreateMailaddr"];
  for (const id of textFields) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }

  const timeFields = ["Ttl", "Minimum", "Refresh", "Retry", "Expire"];
  const defaultKeys = { Ttl: "ttl", Minimum: "minimum", Refresh: "refresh", Retry: "retry", Expire: "expire" };
  for (const f of timeFields) {
    const el = document.getElementById(`zoneCreate${f}`);
    if (el) {
      el.value = String(zoneDefaults[defaultKeys[f]] ?? "");
      const disp = document.getElementById(`zoneCreate${f}Display`);
      if (disp) disp.textContent = secondsToHuman(el.value);
    }
    attachTimeField(`zoneCreate${f}`, `zoneCreate${f}Display`);
  }

  const zoneInput = document.getElementById("zoneCreateZone");
  const mailaddrInput = document.getElementById("zoneCreateMailaddr");
  if (zoneInput && mailaddrInput && !zoneInput.dataset.blurInitialized) {
    zoneInput.dataset.blurInitialized = "true";
    zoneInput.addEventListener("blur", () => {
      if (mailaddrInput.value.trim() !== "") return;
      const z = zoneInput.value.trim().replace(/\.$/, "");
      if (z) mailaddrInput.value = `hostmaster.${z}`;
    });
  }

  initZoneCreateActions();

  const modalEl = document.getElementById("zoneCreateModal");
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function initZoneCreateActions() {
  const saveButton = document.getElementById("zoneCreateSaveButton");
  if (!saveButton || saveButton.dataset.initialized === "true") return;
  saveButton.dataset.initialized = "true";

  saveButton.addEventListener("click", async () => {
    const zone = document.getElementById("zoneCreateZone").value.trim();
    if (!zone) { alert("Zone name is required."); return; }
    if (!currentGroupId) { alert("No active group. Please log in again."); return; }

    const now = new Date();
    const serial = parseInt(
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}01`,
      10,
    );

    const parseTime = (id, fallback) => {
      const raw = document.getElementById(id)?.value ?? "";
      return parseHumanTime(raw) ?? fallback;
    };

    const payload = {
      zone,
      gid: currentGroupId,
      serial,
      ttl:     parseTime("zoneCreateTtl",     zoneDefaults.ttl),
      minimum: parseTime("zoneCreateMinimum", zoneDefaults.minimum),
      refresh: parseTime("zoneCreateRefresh", zoneDefaults.refresh),
      retry:   parseTime("zoneCreateRetry",   zoneDefaults.retry),
      expire:  parseTime("zoneCreateExpire",  zoneDefaults.expire),
    };

    const description = document.getElementById("zoneCreateDescription").value.trim();
    if (description) payload.description = description;
    const mailaddr = document.getElementById("zoneCreateMailaddr").value.trim();
    if (mailaddr) payload.mailaddr = mailaddr;

    saveButton.disabled = true;
    try {
      const response = await ajax({ method: "POST", url: `${API_URI}/zone`, payload });
      if (!response || response?.error) {
        console.error("Create zone failed:", response, payload);
        alert(response?.message ?? "Create failed. See console for details.");
        return;
      }
      bootstrap.Modal.getOrCreateInstance(document.getElementById("zoneCreateModal")).hide();
      zoneDataTable.ajax.reload(null, false);
    } catch (error) {
      console.error("Create zone request failed:", error);
      alert("Create failed due to a network or server error.");
    } finally {
      saveButton.disabled = false;
    }
  });
}

let activeZoneContext = null;

function openEditZoneModal(zone) {
  activeZoneContext = zone;

  document.getElementById("zoneEditName").value        = zone.zone ?? "";
  document.getElementById("zoneEditDescription").value = zone.description ?? "";
  document.getElementById("zoneEditMailaddr").value    = zone.mailaddr ?? "";

  const timeFields = [
    ["zoneEditTtl",     zone.ttl,     "zoneEditTtlDisplay"],
    ["zoneEditMinimum", zone.minimum, "zoneEditMinimumDisplay"],
    ["zoneEditRefresh", zone.refresh, "zoneEditRefreshDisplay"],
    ["zoneEditRetry",   zone.retry,   "zoneEditRetryDisplay"],
    ["zoneEditExpire",  zone.expire,  "zoneEditExpireDisplay"],
  ];
  for (const [inputId, val, displayId] of timeFields) {
    const el = document.getElementById(inputId);
    if (el) el.value = val != null ? String(val) : "";
    const disp = document.getElementById(displayId);
    if (disp) disp.textContent = val != null ? secondsToHuman(val) : "";
    attachTimeField(inputId, displayId);
  }

  initZoneModalActions();

  const modalEl = document.getElementById("zoneEditModal");
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function initZoneModalActions() {
  const saveButton = document.getElementById("zoneEditSaveButton");
  if (!saveButton || saveButton.dataset.initialized === "true") return;
  saveButton.dataset.initialized = "true";

  saveButton.addEventListener("click", async () => {
    const zone = activeZoneContext;
    if (!zone?.id) return;

    const payload = {};
    const description = document.getElementById("zoneEditDescription").value;
    const mailaddr    = document.getElementById("zoneEditMailaddr").value;

    payload.description = description;
    payload.mailaddr    = mailaddr;

    for (const [key, inputId] of [
      ["ttl",     "zoneEditTtl"],
      ["minimum", "zoneEditMinimum"],
      ["refresh", "zoneEditRefresh"],
      ["retry",   "zoneEditRetry"],
      ["expire",  "zoneEditExpire"],
    ]) {
      const raw = document.getElementById(inputId)?.value ?? "";
      if (raw.trim() === "") continue;
      const parsed = parseHumanTime(raw);
      if (parsed !== null) payload[key] = parsed;
    }

    saveButton.disabled = true;
    try {
      const response = await ajax({
        method: "PUT",
        url: `${API_URI}/zone/${zone.id}`,
        payload,
      });

      if (!response || response?.error) {
        console.error("Update zone failed:", response);
        alert(response?.message ?? "Update failed. See console for details.");
        return;
      }

      bootstrap.Modal.getOrCreateInstance(document.getElementById("zoneEditModal")).hide();
      zoneDataTable.ajax.reload(null, false);
    } catch (error) {
      console.error("Update zone request failed:", error);
      alert("Update failed due to a network or server error.");
    } finally {
      saveButton.disabled = false;
    }
  });
}

function initZoneRecordModalActions() {
  const deleteButton = document.getElementById("zrDeleteButton");
  const saveButton = document.getElementById("zrSaveButton");
  if (!deleteButton || deleteButton.dataset.initialized === "true") return;

  deleteButton.dataset.initialized = "true";
  deleteButton.addEventListener("click", async () => {
    const context = activeZoneRecordContext;
    if (!context?.zr?.id || !context?.zone?.id) return;

    deleteButton.disabled = true;
    try {
      const response = await ajax({
        method: "DELETE",
        url: `${API_URI}/zone_record/${context.zr.id}`,
      });

      if (!response || response?.error) {
        console.error("Delete zone record failed:", response);
        alert(response?.message ?? "Delete failed. See console for details.");
        return;
      }

      const modalEl = document.getElementById("zrEditModal");
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.hide();

      showZoneRecords(context.zone);
    } catch (error) {
      console.error("Delete zone record request failed:", error);
      alert("Delete failed due to a network or server error.");
    } finally {
      deleteButton.disabled = false;
    }
  });

  if (!saveButton || saveButton.dataset.initialized === "true") return;
  saveButton.dataset.initialized = "true";
  saveButton.addEventListener("click", async () => {
    const context = activeZoneRecordContext;
    if (!context?.zone?.id) return;

    const ownerRaw = document.getElementById("zrEditOwner")?.value ?? "";
    const type = document.getElementById("zrEditType")?.value ?? "A";
    const ttlRaw = document.getElementById("zrEditTtl")?.value ?? "";
    const rrCtor = RR[type];
    if (!rrCtor) {
      alert(`Unsupported RR type: ${type}`);
      return;
    }

    const rr = new rrCtor(null);
    const ttl = parseOptionalTtlValue(`${ttlRaw}`);
    const payload = {
      zid: context.zone.id,
      owner: normalizeOwnerForZone(ownerRaw, context.zone.zone),
      type,
    };

    if (ttl !== undefined) payload.ttl = ttl;

    const desc = document.getElementById("zrEditDescription")?.value.trim() ?? "";
    if (desc) payload.description = desc;

    for (const field of rr.getRdataFields()) {
      const input = document.getElementById(`zrEdit${fieldToId(field)}`);
      if (!input) continue;
      payload[field] = parseInputValue(`${input.value ?? ""}`);
    }

    saveButton.disabled = true;
    try {
      if (context.mode === "create") {
        const response = await ajax({
          method: "POST",
          url: `${API_URI}/zone_record`,
          payload,
        });

        if (!response || response?.error) {
          console.error("Create zone record failed:", response, payload);
          alert(response?.message ?? "Create failed. See console for details.");
          return;
        }
      } else {
        const response = await ajax({
          method: "PUT",
          url: `${API_URI}/zone_record/${context.zr.id}`,
          payload,
        });

        if (!response || response?.error) {
          console.error("Update zone record failed:", response, payload);
          alert(response?.message ?? "Update failed. See console for details.");
          return;
        }
      }

      const modalEl = document.getElementById("zrEditModal");
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.hide();
      showZoneRecords(context.zone);
    } catch (error) {
      console.error("Zone record save request failed:", error);
      alert("Save failed due to a network or server error.");
    } finally {
      saveButton.disabled = false;
    }
  });
}

function populateZrEditType() {
  const sel = document.getElementById("zrEditType");

  const groups = {
    "LESS COMMON": document.createElement("optgroup"),
    "SECURITY":    document.createElement("optgroup"),
    "DNSSEC":      document.createElement("optgroup"),
    "DEPRECATED":  document.createElement("optgroup"),
    "OBSOLETE":    document.createElement("optgroup"),
  };
  for (const [label, el] of Object.entries(groups)) el.label = label;

  const tagToGroup = { security: "SECURITY", dnssec: "DNSSEC", deprecated: "DEPRECATED", obsolete: "OBSOLETE" };

  for (const rr in RR) {
    if (["default", "typeMap"].includes(rr)) continue;
    if (rr === "SOA") continue; // SOA is defined by the zone itself
    const instance = new RR[rr](null);
    const option = document.createElement("option");
    option.value = rr;
    option.innerHTML = `${rr}  -  ${instance.getDescription()}`;

    const tags = instance.getTags();
    if (tags.includes("common")) {
      sel.appendChild(option);
    } else {
      const groupName = tags.map((t) => tagToGroup[t]).find(Boolean) ?? "LESS COMMON";
      groups[groupName].appendChild(option);
    }
  }

  for (const el of Object.values(groups)) sel.appendChild(el);
}

function getRdataInput(field, value = "", rr, placeholder = " ") {
  const eid = `zrEdit${fieldToId(field)}`;

  let input = `<input type="text" class="form-control" id="${eid}" value="${escapeHtml(`${value ?? ""}`)}" placeholder="${escapeHtml(placeholder)}">`;

  if (rr[`get${rr.ucFirst(field)}Options`]) {
    input = `<select class="form-select" id="${eid}">`;
    for (const o of rr[`get${rr.ucFirst(field)}Options`]({ desc: true })) {
      input += `<option value="${escapeHtml(`${o[0]}`)}" ${value === o[0] ? "selected" : ""}>${escapeHtml(`${o[0]}`)}${o[1] ? ` - ${escapeHtml(`${o[1]}`)}` : ""}</option>`;
    }
    input += `</select>`;
  } else if (rr.get("type") === "NAPTR" && field === "flags") {
  } else {
    switch (field) {
      case "cert type":
      case "hash algorithm":
      case "flags":
      case "key tag":
      case "order":
      case "original ttl":
      case "port":
      case "precedence":
      case "preference":
      case "priority":
      case "protocol":
      case "service":
      case "weight":
        input = `<input type="number" class="form-control" id="${eid}" value="${escapeHtml(`${value ?? ""}`)}" placeholder="${escapeHtml(placeholder)}">`;
        break;
    }
  }

  return `
    <div class="form-floating mb-3">${input}
        <label for="${eid}" class="form-label text-capitalize" style="">${escapeHtml(field)}</label>
        <div id="zrEdit${rr.ucFirst(field)}Help" class="form-text"></div>
    </div>`;
}

function changeRDataField(name, rr, event) {
  if (name === "ttl" && `${event.target.value ?? ""}`.trim() === "") {
    rr.delete("ttl");
    event.target.classList.remove("is-valid");
    event.target.classList.remove("is-invalid");
    const help = document.getElementById(`zrEdit${rr.ucFirst(name)}Help`);
    help.innerHTML = "Leave blank to inherit the zone TTL.";
    return;
  }

  let value =
    event.target.type === "number"
      ? parseInt(event.target.value, 10)
      : /^\d+$/.test(event.target.value)
        ? parseInt(event.target.value, 10)
        : event.target.value;
  console.log(`${name} changed, value: ${value}`);
  const help = document.getElementById(`zrEdit${rr.ucFirst(name)}Help`);

  try {
    rr[`set${rr.ucFirst(name)}`](value);
    event.target.classList.add("is-valid");
    event.target.classList.remove("is-invalid");
    help.innerHTML = "";
  } catch (error) {
    // console.error(error);
    if (name === "type") {
      event.target.classList.add("is-valid");
      event.target.classList.remove("is-invalid");
      return;
    }
    event.target.classList.add("is-invalid");
    event.target.classList.remove("is-valid");
    help.innerHTML = `${error.message.split(/Example/)[0]}`;
  }
}

function populateZrEditRdata(rr, zr) {
  let editData = document.getElementById("zrEditRdata");
  editData.innerHTML = "";

  const canonical = rr.getCanonical();
  for (const f of rr.getRdataFields()) {
    const ph = canonical[f] !== undefined ? String(canonical[f]) : " ";
    editData.innerHTML += getRdataInput(f, zr[f], rr, ph);
  }

  for (const f of rr.getRdataFields()) {
    const t = document.getElementById(`zrEdit${fieldToId(f)}`);
    if (!t) continue;

    const helpEl = document.getElementById(`zrEdit${rr.ucFirst(f)}Help`);
    if (helpEl && !helpEl.textContent && canonical[f] !== undefined) {
      helpEl.textContent = `e.g. ${canonical[f]}`;
    }

    t.addEventListener("change", (event) => {
      changeRDataField(f, rr, event);
    });
    t.addEventListener("keyup", (event) => {
      changeRDataField(f, rr, event);
    });
  }
}

function editZoneRecord(zone, zr, rr) {
  console.log("editZoneRecord", zr);

  const owner = document.getElementById("zrEditOwner");
  owner.classList.remove("is-valid");
  owner.classList.remove("is-invalid");
  const validateOwner = (event) => {
    const normalized = normalizeOwnerForZone(event.target.value, zone.zone);
    const help = document.getElementById("zrEditOwnerHelp");
    try {
      rr.setOwner(normalized);
      event.target.classList.add("is-valid");
      event.target.classList.remove("is-invalid");
      help.innerHTML = "";
    } catch (error) {
      event.target.classList.add("is-invalid");
      event.target.classList.remove("is-valid");
      help.innerHTML = `${error.message.split(/Example/)[0]}`;
    }
  };
  owner.addEventListener("change", validateOwner);
  owner.addEventListener("keyup", validateOwner);
  owner.value = zr.owner;
  document.getElementById("zrEditOwnerZone").innerHTML = `.${zone.zone}.`;

  const ttl = document.getElementById("zrEditTtl");
  ttl.classList.remove("is-valid");
  ttl.classList.remove("is-invalid");
  ttl.addEventListener("change", (event) => {
    changeRDataField("ttl", rr, event);
  });
  ttl.addEventListener("keyup", (event) => {
    changeRDataField("ttl", rr, event);
  });
  ttl.value = formatZoneRecordTtl(zr.ttl);
  document.getElementById("zrEditTtlHelp").innerHTML =
    "Blank inherits the zone TTL.";

  const type = document.getElementById("zrEditType");
  type.classList.remove("is-valid");
  type.classList.remove("is-invalid");
  type.addEventListener("change", (event) => {
    changeRDataField("type", rr, event);
  });
  type.addEventListener("keyup", (event) => {
    changeRDataField("type", rr, event);
  });
  const typeRFCs = document.getElementById("zrEditTypeRFCs");
  typeRFCs.innerHTML = `RFCs: ${rr
    .getRFCs()
    .map(
      (r) =>
        `<a href="https://tools.ietf.org/html/rfc${r}" target="_blank">${r}</a>`,
    )
    .join(", ")}`;
  type.value = zr.type;

  type.addEventListener("change", (event) => {
    const selected = event.target.selectedOptions[0];
    console.log("selected", selected);
    const newRR = new RR[selected.value](null);
    populateZrEditRdata(newRR, zr);
    setRRTypePlaceholders(selected.value);
    typeRFCs.innerHTML = `RFCs: ${newRR
      .getRFCs()
      .map(
        (r) =>
          `<a href="https://tools.ietf.org/html/rfc${r}" target="_blank">${r}</a>`,
      )
      .join(", ")}`;
  });

  const descEl = document.getElementById("zrEditDescription");
  if (descEl) descEl.value = zr.description ?? "";

  populateZrEditRdata(rr, zr);
}

document.getElementById("login_form").addEventListener("submit", (e) => {
  e.preventDefault();
  attemptLogin();
});
document.getElementById("logout_button").addEventListener("click", (event) => {
  attemptLogout();
});
document.getElementById("profileMenuItem").addEventListener("click", (event) => {
  event.preventDefault();
  if (currentUser) openUserPane(currentUser);
});

onLoad();
