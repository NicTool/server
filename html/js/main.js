import * as RR from "/nictool/dns-resource-record/index.js";

const API_URI = "https://mattbook-m3.home.simerson.net:3000";
let nsDataTable;
let zoneDataTable;
let userDataTable;
const zoneRecordDataTables = new Map();
const zoneColumnSearchTimers = new Map();
const RR_DATA_PREVIEW_CHARS = 72;
const DANGEROUS_MODE_COOKIE = "nt-dangerous-mode";
let activeZoneRecordContext;

function isDangerousModeEnabled() {
  return Cookie.get(DANGEROUS_MODE_COOKIE) === "1";
}

function initDangerousModeToggle() {
  const toggle = document.getElementById("dangerousModeToggle");
  if (!toggle || toggle.dataset.initialized === "true") return;

  toggle.checked = isDangerousModeEnabled();
  toggle.dataset.initialized = "true";
  toggle.addEventListener("change", () => {
    Cookie.set(DANGEROUS_MODE_COOKIE, toggle.checked ? "1" : "0", { days: 365 });
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

const RR_PLACEHOLDERS = {
  A:          { owner: 'host',        address: '192.0.99.5' },
  AAAA:       { owner: 'host',        address: '2001:db8:f00d::2' },
  CAA:        { owner: '',            address: '' },
  CNAME:      { owner: 'host',        address: 'fqdn.example.com.' },
  DNAME:      { owner: 'subdomain',   address: 'fqdn.example.com.' },
  HINFO:      { owner: 'host',        address: 'CPU OS' },
  LOC:        { owner: 'host',        address: '47 43 47.000 N 122 21 35.000 W 132.00m 100m 100m 2m' },
  MX:         { owner: '@',           address: 'mail.example.com.' },
  NAPTR:      { owner: '',            address: '"" "" "/urn:cid:.+@([^\\.]+\\.)(.*)$/\\2/i"' },
  NS:         { owner: 'subdomain',   address: 'ns1.example.com.' },
  NSEC:       { owner: '',            address: 'host.example.com.' },
  NSEC3:      { owner: '',            address: '1 1 12 aabbccdd ( 2t7b4g4vsa5smi47k61mv5bv1a22bojr MX DNSKEY NS SOA NSEC3PARAM RRSIG )' },
  NSEC3PARAM: { owner: '',            address: '1 1 12 aa99ffdd' },
  PTR:        { owner: '',            address: 'host.example.com.' },
  RRSIG:      { owner: '',            address: 'A 5 3 86400 20030322173103 ( 20030220173103 2642 example.com. oJB1W6...)' },
  SPF:        { owner: '@',           address: 'v=spf1 mx a -all' },
  SRV:        { owner: '_dns._udp',   address: 'ns1.example.com.' },
  SSHFP:      { owner: 'host',        address: '' },
  TXT:        { owner: '',            address: '' },
  URI:        { owner: '_ftp._tcp',   address: 'ftp://ftp1.example.com/public' },
}

function setRRTypePlaceholders(type) {
  const p = RR_PLACEHOLDERS[type] ?? {}

  const ownerEl = document.getElementById("zrEditOwner")
  if (ownerEl && p.owner !== undefined) ownerEl.placeholder = p.owner

  if (p.address !== undefined) {
    // rdata fields are generated as zrEdit${fieldName}; try 'address' first,
    // then fall back to the first text input in the rdata container
    const addrEl =
      document.getElementById("zrEditaddress") ??
      document.querySelector("#zrEditRdata input[type='text'], #zrEditRdata textarea")
    if (addrEl) addrEl.placeholder = p.address
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

function onLoggedIn(response) {
  document.getElementById("login_div").style.display = "none";
  document.getElementById("loggedInMain").style.display = "block";
  document.getElementById("loggedInMain").classList.add("show");

  const groupLabel = document.getElementById("group_dropdown_label");
  const groupMenu = document.getElementById("group_dropdown_menu");
  if (groupLabel && groupMenu) {
    groupLabel.textContent = response.group?.name ?? "Group";
    groupMenu.innerHTML = "";

    const groupItem = document.createElement("li");
    groupItem.innerHTML = `<a class="dropdown-item active" href="#" data-group-id="${response.group?.id ?? ""}">${response.group?.name ?? "Group"}</a>`;
    groupMenu.appendChild(groupItem);
  }

  // ajax({
  //     method: 'GET',
  //     url: `${API_URI}/permission/${response.user.id}`,
  // })
  // .then((response) => {
  //     console.log('GET /permission response', response);
  // })

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
  console.log("attempting login");

  try {
    ajax({
      method: "POST",
      url: `${API_URI}/session`,
      payload: {
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
      },
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
  ajax({
    method: "GET",
    url: `${API_URI}/nameserver`,
  }).then((response) => {
    console.log("GET /nameserver response", response);
    const table = document.getElementById("ns_table");
    const tableHead = table.querySelector("thead");

    // Remove existing filter row before re-initializing.
    while (tableHead.rows.length > 1) {
      tableHead.deleteRow(1);
    }

    if (nsDataTable) {
      nsDataTable.destroy();
      nsDataTable = undefined;
    }

    const body = table.querySelector("tbody");
    body.innerHTML = "";

    const sorted = response.nameserver
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id));

    for (const ns of sorted) {
      const row = document.createElement("tr");
      row.classList.add("accordion-item");
      row.id = `ns_${ns.id}_tr`;
      row.innerHTML = `
                <td>${ns.name ?? ""}</td>
                <td>${ns.description ?? ""}</td>
                <td style="text-align: right;">${ns.address ?? ""}</td>
                <td style="text-align: right;">${ns.address6 ?? ""}</td>
                <td style="text-align: center">${ns.export?.type ?? ""}</td>
                <td style="text-align: center"><button type="button" class="btn btn-sm btn-outline-secondary">⛭</button></td>
            `;
      body.appendChild(row);
    }

    const filterRow = tableHead.rows[0].cloneNode(true);
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

    nsDataTable = new DataTable(table, {
      orderCellsTop: true,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100],
      columnDefs: [
        { orderable: false, searchable: false, targets: [5] },
      ],
      initComplete() {
        const api = this.api();
        api.columns().every(function (index) {
          const input = filterRow.cells[index].querySelector("input");
          if (!input) return;

          input.addEventListener("input", () => {
            if (this.search() !== input.value) {
              this.search(input.value).draw();
            }
          });
        });
      },
    });
  });
}

function showUsers() {
  ajax({
    method: "GET",
    url: `${API_URI}/user`,
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
      row.innerHTML = `
        <td>${u.username ?? ""}</td>
        <td>${u.first_name ?? ""} ${u.last_name ?? ""}</td>
        <td>${u.email ?? ""}</td>
        <td style="text-align: center">${u.is_admin ? "✓" : ""}</td>
        <td style="text-align: center"><button type="button" class="btn btn-sm btn-outline-secondary">⛭</button></td>
      `;
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
      columnDefs: [
        { orderable: false, searchable: false, targets: [4] },
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
      },
    });
  });
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
        defaultContent:
          '<div class="d-inline-flex align-items-center gap-2"><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-add-zr-btn" aria-label="Add resource record" title="Add resource record" style="text-decoration: none; font-size: 1rem; line-height: 1;">+</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-edit-btn" aria-label="Edit zone" title="Edit zone" style="text-decoration: none; font-size: 0.9rem; line-height: 1;">✎</button><button type="button" class="btn btn-sm btn-link text-body-secondary p-0 zone-delete-btn" aria-label="Delete zone" title="Delete zone" style="text-decoration: none; font-size: 0.9rem; line-height: 1;">🗑</button></div>',
      },
    ],
    async ajax(data, callback) {
      const params = new URLSearchParams();
      params.set("limit", `${data.length}`);
      params.set("offset", `${data.start}`);

      const includeDeleted = document.getElementById("zoneSearchDeleted")?.checked === true;
      if (includeDeleted) params.set("deleted", "true");

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
      api.columns().every(function (index) {
        const input = filterRow.cells[index].querySelector("input");
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

    const deleteButton = event.target.closest("button.zone-delete-btn");
    if (deleteButton) {
      const tr = deleteButton.closest("tr");
      if (!tr) return;

      const row = zoneDataTable.row(tr);
      const zone = row.data();
      if (!zone) return;

      if (!isDangerousModeEnabled()) {
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
                                <th>Name</th>
                                <th>Type</th>
                                <th>TTL</th>
                                <th>Data</th>
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
  const rdata = `${mname} ${rname} ${serial} ${refresh} ${retry} ${expire} ${minimum}`;

  const row = document.createElement("tr");
  row.classList.add("zone-record-soa");
  row.innerHTML = `
    <td class="small text-muted">${escapeHtml(zoneFqdn)}</td>
    <td class="small text-muted">SOA</td>
    <td class="small text-muted">${escapeHtml(formatZoneRecordTtl(zone.ttl))}</td>
    <td class="small text-muted" style="width: 50%;">
      <span class="text-truncate" style="display:inline-block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(rdata)}">${escapeHtml(rdata)}</span>
    </td>
    <td class="small text-center"></td>
  `;
  return row;
}

function showZoneRecords(zone) {
  const zrTable = zoneRecordDataTables.get(zone.id);
  if (zrTable) {
    zrTable.destroy();
    zoneRecordDataTables.delete(zone.id);
  }

  const table = document.getElementById(`zone_${zone.id}_table`);
  if (!table) return;

  const tbody = document.getElementById(`zone_${zone.id}_tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";

  tbody.appendChild(buildSyntheticSoaRow(zone));

  ajax({
    method: "GET",
    url: `${API_URI}/zone_record/?zid=${zone.id}`,
  }).then((response) => {
    // console.log('GET /zone_record response', response);

    for (const zr of response.zone_record) {
      console.log(zr);
      const row = document.createElement("tr");
      try {
        const owner =
          zr.owner === `${zone.zone}.`
            ? zr.owner
            : zr.owner.endsWith(`${zone.zone}.`)
              ? zr.owner
              : `${zr.owner}.${zone.zone}.`;
        // console.log('owner', owner);
        const rrCtor = RR[zr.type];
        const asRR = new rrCtor({ ...zr, owner, type: rrCtor.name });
        // console.log('asRR', asRR)
        row.asRR = asRR;
        zr.rdata = asRR
          .getRdataFields()
          .map((f) => asRR.get(f))
          .join(" ");
      } catch (error) {
        console.error("Error creating RR:", error);
      }
      row.id = `zr_${zr.id}_tr`;

      const ownerDisplay = escapeHtml(zr.owner);
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
                    >Copy</button>`
        : "";
      const deleteButtonHtml = `<button
                      type="button"
                      class="btn btn-sm btn-link text-body-secondary p-0 zr-delete-btn"
                      aria-label="Delete zone record"
                      title="Delete zone record"
                      style="text-decoration: none; font-size: 0.95rem; line-height: 1;"
                    >🗑</button>`;

      row.innerHTML = `
                <td class="small" id="zr_${zr.id}_td">${ownerDisplay}</td>
                <td class="small">${typeDisplay}</td>
                <td class="small">${ttlDisplay}</td>
                <td class="small" style="width: 50%;">
                  <div class="d-flex align-items-center gap-2" style="min-width: 0;">
                    <span
                      class="text-truncate"
                      style="display: inline-block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
                      title="${rdataFull}"
                    >${rdataDisplay}</span>${trimmedMarker}
                    ${copyButtonHtml}
                  </div>
                </td>
                <td class="small text-center">${deleteButtonHtml}</td>
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
          if (event.target.closest(".zr-copy-btn, .zr-delete-btn")) return;

          activeZoneRecordContext = { zone, zr, mode: "edit" };
          setZoneRecordModalMode("edit");
          editZoneRecord(zone, zr, row.asRR);
          const modalEl = document.getElementById("zrEditModal");
          const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
          modal.show();
        });
    }

    const hasTableControls = response.zone_record.length >= 10;

    const dt = new DataTable(table, {
      order: [[0, "asc"]],
      pageLength: 10,
      lengthMenu: [10, 25, 50],
      searching: hasTableControls,
      paging: hasTableControls,
      info: hasTableControls,
      lengthChange: hasTableControls,
      language: {
        lengthMenu: "_MENU_ resource records per page",
        info: "Showing _START_ to _END_ of _TOTAL_ resource records",
        infoEmpty: "Showing 0 resource records",
        infoFiltered: "(filtered from _MAX_ resource records)",
      },
    });
    zoneRecordDataTables.set(zone.id, dt);
  });
}

let activeZoneContext = null;

function openEditZoneModal(zone) {
  activeZoneContext = zone;

  document.getElementById("zoneEditName").value        = zone.zone ?? "";
  document.getElementById("zoneEditDescription").value = zone.description ?? "";
  document.getElementById("zoneEditMailaddr").value    = zone.mailaddr ?? "";
  document.getElementById("zoneEditTtl").value         = zone.ttl ?? "";
  document.getElementById("zoneEditMinimum").value     = zone.minimum ?? "";
  document.getElementById("zoneEditRefresh").value     = zone.refresh ?? "";
  document.getElementById("zoneEditRetry").value       = zone.retry ?? "";
  document.getElementById("zoneEditExpire").value      = zone.expire ?? "";

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
    const ttl         = document.getElementById("zoneEditTtl").value;
    const minimum     = document.getElementById("zoneEditMinimum").value;
    const refresh     = document.getElementById("zoneEditRefresh").value;
    const retry       = document.getElementById("zoneEditRetry").value;
    const expire      = document.getElementById("zoneEditExpire").value;

    payload.description = description;
    payload.mailaddr    = mailaddr;
    if (ttl     !== "") payload.ttl     = Number(ttl);
    if (minimum !== "") payload.minimum = Number(minimum);
    if (refresh !== "") payload.refresh = Number(refresh);
    if (retry   !== "") payload.retry   = Number(retry);
    if (expire  !== "") payload.expire  = Number(expire);

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

    if (context.mode !== "create") return;

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

    for (const field of rr.getRdataFields()) {
      const input = document.getElementById(`zrEdit${field}`);
      if (!input) continue;
      payload[field] = parseInputValue(`${input.value ?? ""}`);
    }

    saveButton.disabled = true;
    try {
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

      const modalEl = document.getElementById("zrEditModal");
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modal.hide();
      showZoneRecords(context.zone);
    } catch (error) {
      console.error("Create zone record request failed:", error);
      alert("Create failed due to a network or server error.");
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

function getRdataInput(field, value = "", rr) {
  // console.log('getRdataInput', field)

  let input = `<input type="text" class="form-control" id="zrEdit${field}" value="${value}" placeholder=" ">`;

  if (rr[`get${rr.ucFirst(field)}Options`]) {
    input = `<select class="form-select" id="zrEdit${field}">`;
    for (const o of rr[`get${rr.ucFirst(field)}Options`]({ desc: true })) {
      input += `<option value="${o[0]}" ${value === o[0] ? "selected" : ""}>${o[0]}${o[1] ? ` - ${o[1]}` : ""}</option>`;
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
        input = `<input type="number" class="form-control" id="zrEdit${field}" value="${value}" placeholder=" ">`;
        break;
    }
  }

  return `
    <div class="form-floating mb-3">${input}
        <label for="zrEdit${field}" class="form-label text-capitalize" style="">${field}</label>
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

  for (const f of rr.getRdataFields()) {
    editData.innerHTML += getRdataInput(f, zr[f], rr);
  }

  for (const f of rr.getRdataFields()) {
    const t = document.getElementById(`zrEdit${f}`);

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

  populateZrEditRdata(rr, zr);
}

document
  .getElementById("login_form_submit")
  .addEventListener("click", (event) => {
    attemptLogin();
  });
document.getElementById("logout_button").addEventListener("click", (event) => {
  attemptLogout();
});

onLoad();
