import * as RR from '@nictool/dns-resource-record'

import { Cookie } from './lib/cookie.js'
import {
  escapeHtml,
  fieldToId,
  formatZoneRecordTtl,
  getRdataPreview,
  parseInputValue,
  parseOptionalTtlValue,
} from './lib/format.js'
import { parseHumanTime, secondsToHuman } from './lib/time.js'
import { normalizeOwnerForZone } from './lib/zone-name.js'
import './components/zone-records.js'
import './components/zone-table.js'
import './components/group-nav.js'
import './components/ns-table.js'
import './components/user-table.js'

const API_URI = '/api'
const CONFIRM_DELETES_COOKIE = 'nt-confirm-deletes'
let activeZoneRecordContext
let currentUser = null

function isConfirmDeletesEnabled() {
  // Default ON (confirm) when no cookie set; cookie "0" means skip confirms
  return Cookie.get(CONFIRM_DELETES_COOKIE) !== '0'
}

function initDangerousModeToggle() {
  const toggle = document.getElementById('dangerousModeToggle')
  if (!toggle || toggle.dataset.initialized === 'true') return

  toggle.checked = isConfirmDeletesEnabled()
  toggle.dataset.initialized = 'true'
  toggle.addEventListener('change', () => {
    Cookie.set(CONFIRM_DELETES_COOKIE, toggle.checked ? '1' : '0', { days: 365 })
  })
}

let currentGroupId = null
let rootGroupId = null
let zoneDefaults = {
  ttl: 86400,
  refresh: 16384,
  retry: 900,
  expire: 1048576,
  minimum: 2560,
}

function attachTimeField(inputId, displayId) {
  const input = document.getElementById(inputId)
  const display = document.getElementById(displayId)
  if (!input || !display) return
  if (input.dataset.timeAttached === 'true') {
    // Just update display for new value
    const parsed = parseHumanTime(input.value)
    display.textContent = parsed !== null ? secondsToHuman(parsed) : ''
    return
  }
  input.dataset.timeAttached = 'true'

  const update = () => {
    const parsed = parseHumanTime(input.value)
    display.textContent = parsed !== null ? secondsToHuman(parsed) : ''
  }

  input.addEventListener('blur', () => {
    const parsed = parseHumanTime(input.value)
    if (parsed !== null && !/^\d+$/.test(input.value.trim())) {
      input.value = String(parsed)
    }
    update()
  })
  input.addEventListener('input', update)
  update()
}

function setRRTypePlaceholders(type) {
  if (!RR[type]) return

  const rr = new RR[type](null)
  const canonical = rr.getCanonical()

  const ownerEl = document.getElementById('zrEditOwner')
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
  const title = document.getElementById('zrEditModalLabel')
  const deleteButton = document.getElementById('zrDeleteButton')
  const saveButton = document.getElementById('zrSaveButton')

  if (title)
    title.textContent =
      mode === 'create' ? 'Create Resource Record' : 'Edit Resource Record'
  if (deleteButton) deleteButton.style.display = mode === 'create' ? 'none' : ''
  if (saveButton) saveButton.textContent = mode === 'create' ? 'Create' : 'Save'
}

function openCreateZoneRecordModal(zone) {
  const zoneFqdn = `${zone.zone}`.endsWith('.') ? zone.zone : `${zone.zone}.`
  const defaultType = zoneFqdn.endsWith('.arpa.') ? 'PTR' : 'A'
  const rrCtor = RR[defaultType]
  const rr = new rrCtor(null)
  const zr = { zid: zone.id, owner: '', type: defaultType, address: '' }

  activeZoneRecordContext = { zone, mode: 'create', rr }
  setZoneRecordModalMode('create')
  editZoneRecord(zone, zr, rr)
  setRRTypePlaceholders(defaultType)

  const modalEl = document.getElementById('zrEditModal')
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl)
  modal.show()
}

async function copyTextToClipboard(value) {
  const text = `${value ?? ''}`

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'absolute'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

const ajax = async (config) => {
  const request = await fetch(config.url, {
    method: config.method,
    mode: 'cors',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${Cookie.get('nt-token')}`,
      ...config.headers,
    },
    body: JSON.stringify(config.payload),
  })
  try {
    let response = await request.json()
    return response
  } catch (error) {
    console.error('Error with fetch:', error)
    // alert error;
  }
}

function onLoad() {
  console.log('onLoad')
  populateZrEditType()
  initZoneRecordModalActions()
  initZoneTable()
  initGroupNav()
  initZoneRecordsComponent()
  initDangerousModeToggle()
  initNsControls()
  initNsTable()
  initUserControls()
  initUserTable()

  if (!Cookie.get('nt-token')) {
    console.log(`Cookie/token not found`)
    document.getElementById('login_div').style.display = 'block'
    return
  }

  ajax({
    method: 'GET',
    url: `${API_URI}/session`,
  })
    .then((response) => {
      console.log('GET /session response', response)
      console.log(response)
      if (response?.error) {
        switch (response.message) {
          case 'Token expired':
          case 'Token maximum age exceeded':
            Cookie.delete('nt-token')
            document.getElementById('login_div').style.display = 'block'
            break
          default:
            console.error(response.message)
            break
        }
      }
      if (response?.user?.id) onLoggedIn(response)
    })
    .catch((error) => {
      console.error('Error fetching session:', error)
    })
}

function switchGroup(gid, name) {
  currentGroupId = gid
  const groupNav = document.getElementById('groupNav')
  if (groupNav) groupNav.currentGid = gid
  showZones()
  showNameservers()
  showUsers()
}

function initGroupNav() {
  const groupNav = document.getElementById('groupNav')
  if (!groupNav || groupNav.dataset.initialized === 'true') return
  groupNav.dataset.initialized = 'true'
  groupNav.addEventListener('group-select', (event) => {
    const { id, name } = event.detail
    if (id === currentGroupId) return
    switchGroup(id, name)
  })
}

function onLoggedIn(response) {
  document.getElementById('login_div').style.display = 'none'
  document.getElementById('loggedInMain').style.display = 'block'
  document.getElementById('loggedInMain').classList.add('show')

  currentUser = response.user ?? null
  currentGroupId = response.group?.id ?? null
  rootGroupId = currentGroupId

  const groupNav = document.getElementById('groupNav')
  if (groupNav) {
    groupNav.token = Cookie.get('nt-token')
    groupNav.rootGid = currentGroupId
    groupNav.currentGid = currentGroupId
  }

  fetch('/nt/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg?.zone) zoneDefaults = { ...zoneDefaults, ...cfg.zone }
    })
    .catch(() => {})

  showNameservers()
  showZones()
  showUsers()
}

function onLoggedOut() {
  document.getElementById('loggedInMain').style.display = 'none'
  document.getElementById('login_div').style.display = 'block'
}

const ZONE_SUBGROUPS_COOKIE = 'nt-zone-include-subgroups'

function attemptLogin() {
  const username = document.getElementById('username').value.trim()
  const password = document.getElementById('password').value
  if (!username || !password) return

  console.log('attempting login')

  try {
    ajax({
      method: 'POST',
      url: `${API_URI}/session`,
      payload: { username, password },
    }).then((response) => {
      console.log('login response', response)
      if (response.session) {
        Cookie.set('nt-token', response.session.token, { days: 1 })
        onLoggedIn(response)
      }
      console.log('document.cookie', document.cookie)
    })
  } catch (error) {
    console.error('Error logging in:', error)
    alert('Login failed. Please check your username and password.')
  }
}

function attemptLogout() {
  console.log('attempting logout')
  ajax({
    method: 'DELETE',
    url: `${API_URI}/session`,
  })
    .then((response) => {
      // console.log('logout response', response);
      if (response) {
        Cookie.delete('nt-token')
        onLoggedOut()
      }
    })
    .catch((error) => {
      console.error('Error logging out:', error)
      // alert('Logout failed. Please try again.');
    })

  return false
}

function showNameservers() {
  const el = document.getElementById('nsTable')
  if (!el) return
  el.token = Cookie.get('nt-token')
  el.confirmDeletes = isConfirmDeletesEnabled()
  if (el.gid === currentGroupId) el.refresh()
  else el.gid = currentGroupId
}

function initNsTable() {
  const el = document.getElementById('nsTable')
  if (!el || el.dataset.initialized === 'true') return
  el.dataset.initialized = 'true'
  el.addEventListener('ns-create', () => openNsPane(null))
  el.addEventListener('ns-edit', (event) => openNsPane(event.detail.ns))
}

let activeNsContext = null

function openNsPane(ns) {
  activeNsContext = ns ? { mode: 'edit', ns } : { mode: 'create' }
  const isCreate = !ns
  document.getElementById('nsEditPaneLabel').textContent = isCreate
    ? 'Create Nameserver'
    : 'Edit Nameserver'
  document.getElementById('nsEditName').value = ns?.name ?? ''
  document.getElementById('nsEditDescription').value = ns?.description ?? ''
  document.getElementById('nsEditTtl').value = ns?.ttl ?? 86400
  document.getElementById('nsEditAddress').value = ns?.address ?? ''
  document.getElementById('nsEditAddress6').value = ns?.address6 ?? ''
  document.getElementById('nsEditExportType').value = ns?.export?.type ?? 'bind'
  document.getElementById('nsEditSaveBtn').textContent = isCreate ? 'Create' : 'Save'
  bootstrap.Modal.getOrCreateInstance(document.getElementById('nsEditPane')).show()
}

function initNsControls() {
  const saveBtn = document.getElementById('nsEditSaveBtn')
  if (saveBtn && !saveBtn.dataset.initialized) {
    saveBtn.dataset.initialized = 'true'
    saveBtn.addEventListener('click', async () => {
      const ctx = activeNsContext
      if (!ctx) return

      const name = document.getElementById('nsEditName').value.trim()
      if (!name) {
        alert('Name is required.')
        return
      }

      const ttlRaw = parseInt(document.getElementById('nsEditTtl').value, 10)
      const payload = {
        name,
        description: document.getElementById('nsEditDescription').value.trim(),
        ttl: Number.isFinite(ttlRaw) ? ttlRaw : 86400,
        address: document.getElementById('nsEditAddress').value.trim() || undefined,
        address6: document.getElementById('nsEditAddress6').value.trim() || undefined,
        export: { type: document.getElementById('nsEditExportType').value },
      }
      if (ctx.mode === 'create') payload.gid = currentGroupId

      const method = ctx.mode === 'create' ? 'POST' : 'PUT'
      const url =
        ctx.mode === 'create'
          ? `${API_URI}/nameserver`
          : `${API_URI}/nameserver/${ctx.ns.id}`

      saveBtn.disabled = true
      try {
        const response = await ajax({ method, url, payload })
        if (!response || response?.error) {
          alert(response?.message ?? 'Save failed. See console for details.')
          return
        }
        bootstrap.Modal.getOrCreateInstance(document.getElementById('nsEditPane')).hide()
        showNameservers()
      } catch (err) {
        console.error('NS save failed:', err)
        alert('Save failed due to a network error.')
      } finally {
        saveBtn.disabled = false
      }
    })
  }
}

function showUsers() {
  const el = document.getElementById('userTable')
  if (!el) return
  el.token = Cookie.get('nt-token')
  el.confirmDeletes = isConfirmDeletesEnabled()
  if (el.gid === currentGroupId) el.refresh()
  else el.gid = currentGroupId
}

function initUserTable() {
  const el = document.getElementById('userTable')
  if (!el || el.dataset.initialized === 'true') return
  el.dataset.initialized = 'true'
  el.addEventListener('user-create', () => openUserPane(null))
  el.addEventListener('user-edit', (event) => openUserPane(event.detail.user))
}

let activeUserContext = null

function openUserPane(user) {
  activeUserContext = user ? { mode: 'edit', user } : { mode: 'create' }
  const isCreate = !user
  document.getElementById('userEditPaneLabel').textContent = isCreate
    ? 'Create User'
    : 'Edit User'
  document.getElementById('userEditUsername').value = user?.username ?? ''
  document.getElementById('userEditFirstName').value = user?.first_name ?? ''
  document.getElementById('userEditLastName').value = user?.last_name ?? ''
  document.getElementById('userEditEmail').value = user?.email ?? ''
  document.getElementById('userEditPassword').value = ''
  document.getElementById('userEditIsAdmin').checked = user?.is_admin ?? false
  document.getElementById('userEditSaveBtn').textContent = isCreate ? 'Create' : 'Save'
  bootstrap.Modal.getOrCreateInstance(document.getElementById('userEditPane')).show()
}

function initUserControls() {
  const pwField = document.getElementById('userEditPassword')
  const hintsEl = document.getElementById('userPasswordHints')
  if (pwField && hintsEl && !pwField.dataset.hintsInitialized) {
    pwField.dataset.hintsInitialized = 'true'
    const checkHint = (id, ok) => {
      const el = document.getElementById(id)
      if (!el) return
      el.className = ok ? 'text-success' : 'text-danger'
      el.textContent = `${ok ? '✓' : '✗'} ${el.dataset.msg}`
    }
    pwField.addEventListener('input', () => {
      const v = pwField.value
      if (!v) {
        hintsEl.classList.add('d-none')
        return
      }
      hintsEl.classList.remove('d-none')
      checkHint('pwHintLength', v.length >= 8)
      checkHint('pwHintUpper', (v.match(/[A-Z]/g) ?? []).length >= 2)
      checkHint('pwHintLower', (v.match(/[a-z]/g) ?? []).length >= 2)
      checkHint('pwHintNumber', (v.match(/[0-9]/g) ?? []).length >= 2)
      checkHint('pwHintSpecial', (v.match(/[^a-zA-Z0-9]/g) ?? []).length >= 2)
      const vl = v.toLowerCase()
      checkHint(
        'pwHintBanned',
        !['password', 'abc', '123', 'asdf'].some((s) => vl.includes(s)),
      )
    })
  }

  const saveBtn = document.getElementById('userEditSaveBtn')
  if (saveBtn && !saveBtn.dataset.initialized) {
    saveBtn.dataset.initialized = 'true'
    saveBtn.addEventListener('click', async () => {
      const ctx = activeUserContext
      if (!ctx) return

      const username = document.getElementById('userEditUsername').value.trim()
      if (!username) {
        alert('Username is required.')
        return
      }

      const payload = {
        username,
        is_admin: document.getElementById('userEditIsAdmin').checked,
      }
      const firstName = document.getElementById('userEditFirstName').value.trim()
      const lastName = document.getElementById('userEditLastName').value.trim()
      const email = document.getElementById('userEditEmail').value.trim()
      const password = document.getElementById('userEditPassword').value
      if (firstName) payload.first_name = firstName
      if (lastName) payload.last_name = lastName
      if (email) payload.email = email
      if (password) payload.password = password
      if (ctx.mode === 'create') payload.gid = currentGroupId

      const method = ctx.mode === 'create' ? 'POST' : 'PUT'
      const url =
        ctx.mode === 'create' ? `${API_URI}/user` : `${API_URI}/user/${ctx.user.id}`

      saveBtn.disabled = true
      try {
        const response = await ajax({ method, url, payload })
        if (!response || response?.error) {
          alert(response?.message ?? 'Save failed. See console for details.')
          return
        }
        bootstrap.Modal.getOrCreateInstance(
          document.getElementById('userEditPane'),
        ).hide()
        showUsers()
      } catch (err) {
        console.error('User save failed:', err)
        alert('Save failed due to a network error.')
      } finally {
        saveBtn.disabled = false
      }
    })
  }
}

function showZones() {
  const el = document.getElementById('zoneTable')
  if (!el) return
  el.token = Cookie.get('nt-token')
  el.confirmDeletes = isConfirmDeletesEnabled()
  el.includeSubgroups = Cookie.get(ZONE_SUBGROUPS_COOKIE) === '1'
  if (el.gid === currentGroupId) el.refresh()
  else el.gid = currentGroupId
}

function refreshZones() {
  document.getElementById('zoneTable')?.refresh()
}

function initZoneTable() {
  const el = document.getElementById('zoneTable')
  if (!el || el.dataset.initialized === 'true') return
  el.dataset.initialized = 'true'
  el.addEventListener('zone-open-records', (e) => openZoneRecordsModal(e.detail.zone))
  el.addEventListener('zone-create', () => openCreateZoneModal())
  el.addEventListener('zone-edit', (e) => openEditZoneModal(e.detail.zone))
  el.addEventListener('zone-add-record', (e) => openCreateZoneRecordModal(e.detail.zone))
  el.addEventListener('subgroups-change', (e) => {
    Cookie.set(ZONE_SUBGROUPS_COOKIE, e.detail.value ? '1' : '0', { days: 365 })
  })
}

function openZoneRecordsModal(zone) {
  const modalEl = document.getElementById('zoneRecordsModal')
  const component = document.getElementById('zoneRecordsComponent')
  if (!modalEl || !component) return

  const titleEl = document.getElementById('zoneRecordsModalLabel')
  if (titleEl) titleEl.textContent = `${zone.zone} — records`

  component.token = Cookie.get('nt-token')
  component.confirmDeletes = isConfirmDeletesEnabled()
  component.zone = zone

  bootstrap.Modal.getOrCreateInstance(modalEl).show()
}

function refreshZoneRecordsComponent() {
  const component = document.getElementById('zoneRecordsComponent')
  if (component?.zone) component.refresh()
}

function initZoneRecordsComponent() {
  const component = document.getElementById('zoneRecordsComponent')
  if (!component || component.dataset.initialized === 'true') return
  component.dataset.initialized = 'true'

  component.addEventListener('zr-create', (event) => {
    openCreateZoneRecordModal(event.detail.zone)
  })

  component.addEventListener('zr-edit', (event) => {
    const { zone, zr } = event.detail
    const rrCtor = RR[zr.type]
    const rr = rrCtor ? new rrCtor(null) : null
    activeZoneRecordContext = { zone, zr, mode: 'edit' }
    setZoneRecordModalMode('edit')
    editZoneRecord(zone, zr, rr)
    bootstrap.Modal.getOrCreateInstance(document.getElementById('zrEditModal')).show()
  })
}

function openCreateZoneModal() {
  const textFields = ['zoneCreateZone', 'zoneCreateDescription', 'zoneCreateMailaddr']
  for (const id of textFields) {
    const el = document.getElementById(id)
    if (el) el.value = ''
  }

  const timeFields = ['Ttl', 'Minimum', 'Refresh', 'Retry', 'Expire']
  const defaultKeys = {
    Ttl: 'ttl',
    Minimum: 'minimum',
    Refresh: 'refresh',
    Retry: 'retry',
    Expire: 'expire',
  }
  for (const f of timeFields) {
    const el = document.getElementById(`zoneCreate${f}`)
    if (el) {
      el.value = String(zoneDefaults[defaultKeys[f]] ?? '')
      const disp = document.getElementById(`zoneCreate${f}Display`)
      if (disp) disp.textContent = secondsToHuman(el.value)
    }
    attachTimeField(`zoneCreate${f}`, `zoneCreate${f}Display`)
  }

  const zoneInput = document.getElementById('zoneCreateZone')
  const mailaddrInput = document.getElementById('zoneCreateMailaddr')
  if (zoneInput && mailaddrInput && !zoneInput.dataset.blurInitialized) {
    zoneInput.dataset.blurInitialized = 'true'
    zoneInput.addEventListener('blur', () => {
      if (mailaddrInput.value.trim() !== '') return
      const z = zoneInput.value.trim().replace(/\.$/, '')
      if (z) mailaddrInput.value = `hostmaster.${z}`
    })
  }

  initZoneCreateActions()

  const modalEl = document.getElementById('zoneCreateModal')
  bootstrap.Modal.getOrCreateInstance(modalEl).show()
}

function initZoneCreateActions() {
  const saveButton = document.getElementById('zoneCreateSaveButton')
  if (!saveButton || saveButton.dataset.initialized === 'true') return
  saveButton.dataset.initialized = 'true'

  saveButton.addEventListener('click', async () => {
    const zone = document.getElementById('zoneCreateZone').value.trim()
    if (!zone) {
      alert('Zone name is required.')
      return
    }
    if (!currentGroupId) {
      alert('No active group. Please log in again.')
      return
    }

    const now = new Date()
    const serial = parseInt(
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}01`,
      10,
    )

    const parseTime = (id, fallback) => {
      const raw = document.getElementById(id)?.value ?? ''
      return parseHumanTime(raw) ?? fallback
    }

    const payload = {
      zone,
      gid: currentGroupId,
      serial,
      ttl: parseTime('zoneCreateTtl', zoneDefaults.ttl),
      minimum: parseTime('zoneCreateMinimum', zoneDefaults.minimum),
      refresh: parseTime('zoneCreateRefresh', zoneDefaults.refresh),
      retry: parseTime('zoneCreateRetry', zoneDefaults.retry),
      expire: parseTime('zoneCreateExpire', zoneDefaults.expire),
    }

    const description = document.getElementById('zoneCreateDescription').value.trim()
    if (description) payload.description = description
    const mailaddr = document.getElementById('zoneCreateMailaddr').value.trim()
    if (mailaddr) payload.mailaddr = mailaddr

    saveButton.disabled = true
    try {
      const response = await ajax({ method: 'POST', url: `${API_URI}/zone`, payload })
      if (!response || response?.error) {
        console.error('Create zone failed:', response, payload)
        alert(response?.message ?? 'Create failed. See console for details.')
        return
      }
      bootstrap.Modal.getOrCreateInstance(
        document.getElementById('zoneCreateModal'),
      ).hide()
      refreshZones()
    } catch (error) {
      console.error('Create zone request failed:', error)
      alert('Create failed due to a network or server error.')
    } finally {
      saveButton.disabled = false
    }
  })
}

let activeZoneContext = null

function openEditZoneModal(zone) {
  activeZoneContext = zone

  document.getElementById('zoneEditName').value = zone.zone ?? ''
  document.getElementById('zoneEditDescription').value = zone.description ?? ''
  document.getElementById('zoneEditMailaddr').value = zone.mailaddr ?? ''

  const timeFields = [
    ['zoneEditTtl', zone.ttl, 'zoneEditTtlDisplay'],
    ['zoneEditMinimum', zone.minimum, 'zoneEditMinimumDisplay'],
    ['zoneEditRefresh', zone.refresh, 'zoneEditRefreshDisplay'],
    ['zoneEditRetry', zone.retry, 'zoneEditRetryDisplay'],
    ['zoneEditExpire', zone.expire, 'zoneEditExpireDisplay'],
  ]
  for (const [inputId, val, displayId] of timeFields) {
    const el = document.getElementById(inputId)
    if (el) el.value = val != null ? String(val) : ''
    const disp = document.getElementById(displayId)
    if (disp) disp.textContent = val != null ? secondsToHuman(val) : ''
    attachTimeField(inputId, displayId)
  }

  initZoneModalActions()

  const modalEl = document.getElementById('zoneEditModal')
  bootstrap.Modal.getOrCreateInstance(modalEl).show()
}

function initZoneModalActions() {
  const saveButton = document.getElementById('zoneEditSaveButton')
  if (!saveButton || saveButton.dataset.initialized === 'true') return
  saveButton.dataset.initialized = 'true'

  saveButton.addEventListener('click', async () => {
    const zone = activeZoneContext
    if (!zone?.id) return

    const payload = {}
    const description = document.getElementById('zoneEditDescription').value
    const mailaddr = document.getElementById('zoneEditMailaddr').value

    payload.description = description
    payload.mailaddr = mailaddr

    for (const [key, inputId] of [
      ['ttl', 'zoneEditTtl'],
      ['minimum', 'zoneEditMinimum'],
      ['refresh', 'zoneEditRefresh'],
      ['retry', 'zoneEditRetry'],
      ['expire', 'zoneEditExpire'],
    ]) {
      const raw = document.getElementById(inputId)?.value ?? ''
      if (raw.trim() === '') continue
      const parsed = parseHumanTime(raw)
      if (parsed !== null) payload[key] = parsed
    }

    saveButton.disabled = true
    try {
      const response = await ajax({
        method: 'PUT',
        url: `${API_URI}/zone/${zone.id}`,
        payload,
      })

      if (!response || response?.error) {
        console.error('Update zone failed:', response)
        alert(response?.message ?? 'Update failed. See console for details.')
        return
      }

      bootstrap.Modal.getOrCreateInstance(document.getElementById('zoneEditModal')).hide()
      refreshZones()
    } catch (error) {
      console.error('Update zone request failed:', error)
      alert('Update failed due to a network or server error.')
    } finally {
      saveButton.disabled = false
    }
  })
}

function initZoneRecordModalActions() {
  const deleteButton = document.getElementById('zrDeleteButton')
  const saveButton = document.getElementById('zrSaveButton')
  if (!deleteButton || deleteButton.dataset.initialized === 'true') return

  deleteButton.dataset.initialized = 'true'
  deleteButton.addEventListener('click', async () => {
    const context = activeZoneRecordContext
    if (!context?.zr?.id || !context?.zone?.id) return

    deleteButton.disabled = true
    try {
      const response = await ajax({
        method: 'DELETE',
        url: `${API_URI}/zone_record/${context.zr.id}`,
      })

      if (!response || response?.error) {
        console.error('Delete zone record failed:', response)
        alert(response?.message ?? 'Delete failed. See console for details.')
        return
      }

      const modalEl = document.getElementById('zrEditModal')
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl)
      modal.hide()

      refreshZoneRecordsComponent()
    } catch (error) {
      console.error('Delete zone record request failed:', error)
      alert('Delete failed due to a network or server error.')
    } finally {
      deleteButton.disabled = false
    }
  })

  if (!saveButton || saveButton.dataset.initialized === 'true') return
  saveButton.dataset.initialized = 'true'
  saveButton.addEventListener('click', async () => {
    const context = activeZoneRecordContext
    if (!context?.zone?.id) return

    const ownerRaw = document.getElementById('zrEditOwner')?.value ?? ''
    const type = document.getElementById('zrEditType')?.value ?? 'A'
    const ttlRaw = document.getElementById('zrEditTtl')?.value ?? ''
    const rrCtor = RR[type]
    if (!rrCtor) {
      alert(`Unsupported RR type: ${type}`)
      return
    }

    const rr = new rrCtor(null)
    const ttl = parseOptionalTtlValue(`${ttlRaw}`)
    const payload = {
      zid: context.zone.id,
      owner: normalizeOwnerForZone(ownerRaw, context.zone.zone),
      type,
    }

    if (ttl !== undefined) payload.ttl = ttl

    const desc = document.getElementById('zrEditDescription')?.value.trim() ?? ''
    if (desc) payload.description = desc

    for (const field of rr.getRdataFields()) {
      const input = document.getElementById(`zrEdit${fieldToId(field)}`)
      if (!input) continue
      payload[field] = parseInputValue(`${input.value ?? ''}`)
    }

    saveButton.disabled = true
    try {
      if (context.mode === 'create') {
        const response = await ajax({
          method: 'POST',
          url: `${API_URI}/zone_record`,
          payload,
        })

        if (!response || response?.error) {
          console.error('Create zone record failed:', response, payload)
          alert(response?.message ?? 'Create failed. See console for details.')
          return
        }
      } else {
        const response = await ajax({
          method: 'PUT',
          url: `${API_URI}/zone_record/${context.zr.id}`,
          payload,
        })

        if (!response || response?.error) {
          console.error('Update zone record failed:', response, payload)
          alert(response?.message ?? 'Update failed. See console for details.')
          return
        }
      }

      const modalEl = document.getElementById('zrEditModal')
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl)
      modal.hide()
      refreshZoneRecordsComponent()
    } catch (error) {
      console.error('Zone record save request failed:', error)
      alert('Save failed due to a network or server error.')
    } finally {
      saveButton.disabled = false
    }
  })
}

function populateZrEditType() {
  const sel = document.getElementById('zrEditType')

  const groups = {
    'LESS COMMON': document.createElement('optgroup'),
    SECURITY: document.createElement('optgroup'),
    DNSSEC: document.createElement('optgroup'),
    DEPRECATED: document.createElement('optgroup'),
    OBSOLETE: document.createElement('optgroup'),
  }
  for (const [label, el] of Object.entries(groups)) el.label = label

  const tagToGroup = {
    security: 'SECURITY',
    dnssec: 'DNSSEC',
    deprecated: 'DEPRECATED',
    obsolete: 'OBSOLETE',
  }

  for (const rr in RR) {
    if (['default', 'typeMap'].includes(rr)) continue
    if (rr === 'SOA') continue // SOA is defined by the zone itself
    const instance = new RR[rr](null)
    const option = document.createElement('option')
    option.value = rr
    option.innerHTML = `${rr}  -  ${instance.getDescription()}`

    const tags = instance.getTags()
    if (tags.includes('common')) {
      sel.appendChild(option)
    } else {
      const groupName = tags.map((t) => tagToGroup[t]).find(Boolean) ?? 'LESS COMMON'
      groups[groupName].appendChild(option)
    }
  }

  for (const el of Object.values(groups)) sel.appendChild(el)
}

function getRdataInput(field, value = '', rr, placeholder = ' ') {
  const eid = `zrEdit${fieldToId(field)}`

  let input = `<input type="text" class="form-control" id="${eid}" value="${escapeHtml(`${value ?? ''}`)}" placeholder="${escapeHtml(placeholder)}">`

  if (rr[`get${rr.ucFirst(field)}Options`]) {
    input = `<select class="form-select" id="${eid}">`
    for (const o of rr[`get${rr.ucFirst(field)}Options`]({ desc: true })) {
      input += `<option value="${escapeHtml(`${o[0]}`)}" ${value === o[0] ? 'selected' : ''}>${escapeHtml(`${o[0]}`)}${o[1] ? ` - ${escapeHtml(`${o[1]}`)}` : ''}</option>`
    }
    input += `</select>`
    // NAPTR flags are characters, not numeric (RFC 3403)
  } else if (!(rr.get('type') === 'NAPTR' && field === 'flags')) {
    switch (field) {
      case 'cert type':
      case 'hash algorithm':
      case 'flags':
      case 'key tag':
      case 'order':
      case 'original ttl':
      case 'port':
      case 'precedence':
      case 'preference':
      case 'priority':
      case 'protocol':
      case 'service':
      case 'weight':
        input = `<input type="number" class="form-control" id="${eid}" value="${escapeHtml(`${value ?? ''}`)}" placeholder="${escapeHtml(placeholder)}">`
        break
    }
  }

  return `
    <div class="form-floating mb-3">${input}
        <label for="${eid}" class="form-label text-capitalize" style="">${escapeHtml(field)}</label>
        <div id="zrEdit${rr.ucFirst(field)}Help" class="form-text"></div>
    </div>`
}

function changeRDataField(name, rr, event) {
  if (name === 'ttl' && `${event.target.value ?? ''}`.trim() === '') {
    rr.delete('ttl')
    event.target.classList.remove('is-valid')
    event.target.classList.remove('is-invalid')
    const help = document.getElementById(`zrEdit${rr.ucFirst(name)}Help`)
    help.innerHTML = 'Leave blank to inherit the zone TTL.'
    return
  }

  let value =
    event.target.type === 'number'
      ? parseInt(event.target.value, 10)
      : /^\d+$/.test(event.target.value)
        ? parseInt(event.target.value, 10)
        : event.target.value
  console.log(`${name} changed, value: ${value}`)
  const help = document.getElementById(`zrEdit${rr.ucFirst(name)}Help`)

  try {
    rr[`set${rr.ucFirst(name)}`](value)
    event.target.classList.add('is-valid')
    event.target.classList.remove('is-invalid')
    help.innerHTML = ''
  } catch (error) {
    // console.error(error);
    if (name === 'type') {
      event.target.classList.add('is-valid')
      event.target.classList.remove('is-invalid')
      return
    }
    event.target.classList.add('is-invalid')
    event.target.classList.remove('is-valid')
    help.innerHTML = `${error.message.split(/Example/)[0]}`
  }
}

function populateZrEditRdata(rr, zr) {
  let editData = document.getElementById('zrEditRdata')
  editData.innerHTML = ''

  const canonical = rr.getCanonical()
  for (const f of rr.getRdataFields()) {
    const ph = canonical[f] !== undefined ? String(canonical[f]) : ' '
    editData.innerHTML += getRdataInput(f, zr[f], rr, ph)
  }

  for (const f of rr.getRdataFields()) {
    const t = document.getElementById(`zrEdit${fieldToId(f)}`)
    if (!t) continue

    const helpEl = document.getElementById(`zrEdit${rr.ucFirst(f)}Help`)
    if (helpEl && !helpEl.textContent && canonical[f] !== undefined) {
      helpEl.textContent = `e.g. ${canonical[f]}`
    }

    t.addEventListener('change', (event) => {
      changeRDataField(f, rr, event)
    })
    t.addEventListener('keyup', (event) => {
      changeRDataField(f, rr, event)
    })
  }
}

function editZoneRecord(zone, zr, rr) {
  console.log('editZoneRecord', zr)

  const owner = document.getElementById('zrEditOwner')
  owner.classList.remove('is-valid')
  owner.classList.remove('is-invalid')
  const validateOwner = (event) => {
    const normalized = normalizeOwnerForZone(event.target.value, zone.zone)
    const help = document.getElementById('zrEditOwnerHelp')
    try {
      rr.setOwner(normalized)
      event.target.classList.add('is-valid')
      event.target.classList.remove('is-invalid')
      help.innerHTML = ''
    } catch (error) {
      event.target.classList.add('is-invalid')
      event.target.classList.remove('is-valid')
      help.innerHTML = `${error.message.split(/Example/)[0]}`
    }
  }
  owner.addEventListener('change', validateOwner)
  owner.addEventListener('keyup', validateOwner)
  owner.value = zr.owner
  document.getElementById('zrEditOwnerZone').innerHTML = `.${zone.zone}.`

  const ttl = document.getElementById('zrEditTtl')
  ttl.classList.remove('is-valid')
  ttl.classList.remove('is-invalid')
  ttl.addEventListener('change', (event) => {
    changeRDataField('ttl', rr, event)
  })
  ttl.addEventListener('keyup', (event) => {
    changeRDataField('ttl', rr, event)
  })
  ttl.value = formatZoneRecordTtl(zr.ttl)
  document.getElementById('zrEditTtlHelp').innerHTML = 'Blank inherits the zone TTL.'

  const type = document.getElementById('zrEditType')
  type.classList.remove('is-valid')
  type.classList.remove('is-invalid')
  type.addEventListener('change', (event) => {
    changeRDataField('type', rr, event)
  })
  type.addEventListener('keyup', (event) => {
    changeRDataField('type', rr, event)
  })
  const typeRFCs = document.getElementById('zrEditTypeRFCs')
  typeRFCs.innerHTML = `RFCs: ${rr
    .getRFCs()
    .map((r) => `<a href="https://tools.ietf.org/html/rfc${r}" target="_blank">${r}</a>`)
    .join(', ')}`
  type.value = zr.type

  type.addEventListener('change', (event) => {
    const selected = event.target.selectedOptions[0]
    console.log('selected', selected)
    const newRR = new RR[selected.value](null)
    populateZrEditRdata(newRR, zr)
    setRRTypePlaceholders(selected.value)
    typeRFCs.innerHTML = `RFCs: ${newRR
      .getRFCs()
      .map(
        (r) => `<a href="https://tools.ietf.org/html/rfc${r}" target="_blank">${r}</a>`,
      )
      .join(', ')}`
  })

  const descEl = document.getElementById('zrEditDescription')
  if (descEl) descEl.value = zr.description ?? ''

  populateZrEditRdata(rr, zr)
}

document.getElementById('login_form').addEventListener('submit', (e) => {
  e.preventDefault()
  attemptLogin()
})
document.getElementById('logout_button').addEventListener('click', (event) => {
  attemptLogout()
})
document.getElementById('profileMenuItem').addEventListener('click', (event) => {
  event.preventDefault()
  if (currentUser) openUserPane(currentUser)
})

onLoad()
