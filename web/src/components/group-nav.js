import { LitElement, html, nothing } from 'lit'

/**
 * <nt-group-nav .rootGid=${gid} .currentGid=${gid} .token=${jwt}>
 *
 * Left-side collapsible group navigator. Lazily loads the group tree, auto-
 * expands the branch to the current group, and lets you jump to any group in a
 * single click. Collapsed, it shows just the selected group's name. Emits
 * `group-select` ({ id, name }) when a group is chosen.
 *
 * The API doesn't report whether a group has children, so we do a one-level
 * lookahead (fetch each child's children) to draw accurate expand carets — the
 * same approach the old dropdown used.
 */
export class GroupNav extends LitElement {
  static properties = {
    rootGid: { attribute: false },
    currentGid: { attribute: false },
    token: { attribute: false },
    apiBase: { attribute: 'api-base' },
    _collapsed: { state: true },
    _ready: { state: true },
    _version: { state: true },
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    // The host element is the flex item in the app's layout row, but it renders
    // into light DOM, so the sizing has to live here rather than on the inner
    // markup. Without flex: 0 0 auto the wide zone table shrinks the rail and
    // paints over it.
    Object.assign(this.style, {
      display: 'flex',
      flex: '0 0 auto',
      alignSelf: 'stretch',
    })
  }

  constructor() {
    super()
    this.rootGid = null
    this.currentGid = null
    this.token = null
    this.apiBase = '/api'
    this._collapsed = false
    this._ready = false
    this._version = 0
    this._nodes = new Map()
  }

  willUpdate(changed) {
    if (changed.has('rootGid') && this.rootGid != null) {
      this._init()
    } else if (changed.has('currentGid') && this.currentGid != null && this._ready) {
      if (!this._nodes.has(this.currentGid)) this._init()
    }
  }

  async _api(path) {
    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        headers: {
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      })
      return await res.json()
    } catch {
      return {}
    }
  }

  _bump() {
    this._version++
  }

  async _group(id) {
    // GET /group/{id} returns { group: [array] } like the other object types;
    // tolerate a bare object too, in case of an older API.
    const res = await this._api(`/group/${id}`)
    const g = res?.group
    return Array.isArray(g) ? g[0] : g
  }

  _storeNode(g, hasChildren) {
    const existing = this._nodes.get(g.id)
    this._nodes.set(g.id, {
      id: g.id,
      name: g.name,
      parent_gid: g.parent_gid,
      hasChildren: hasChildren ?? existing?.hasChildren,
      children: existing?.children ?? null,
      expanded: existing?.expanded ?? false,
    })
  }

  async _loadChildren(gid) {
    const node = this._nodes.get(gid)
    if (!node || node.children) return
    const res = await this._api(`/group?parent_gid=${gid}`)
    const kids = (res?.group ?? [])
      .slice()
      .sort((a, b) => `${a.name}`.localeCompare(`${b.name}`))
    // One-level lookahead so each child gets an accurate expand caret.
    await Promise.all(
      kids.map(async (k) => {
        const kr = await this._api(`/group?parent_gid=${k.id}`)
        k._has = (kr?.group ?? []).length > 0
      }),
    )
    for (const k of kids) this._storeNode(k, k._has)
    node.children = kids.map((k) => k.id)
    node.hasChildren = node.children.length > 0
    this._bump()
  }

  async _init() {
    this._ready = false
    this._nodes = new Map()

    // Walk up from the current group to the root to get the ancestor chain.
    const chain = []
    let cur = this.currentGid ?? this.rootGid
    const seen = new Set()
    while (cur != null && !seen.has(cur)) {
      seen.add(cur)
      const g = await this._group(cur)
      if (!g) break
      this._storeNode(g)
      chain.unshift(g.id)
      if (g.id === this.rootGid) break
      cur = g.parent_gid
    }
    if (this.rootGid != null && !this._nodes.has(this.rootGid)) {
      const r = await this._group(this.rootGid)
      if (r) {
        this._storeNode(r)
        chain.unshift(r.id)
      }
    }

    // Load + expand each node along the path so the current group is visible.
    for (const gid of chain) {
      await this._loadChildren(gid)
      const n = this._nodes.get(gid)
      if (n?.children?.length) n.expanded = true
    }

    this._ready = true
    this._bump()
  }

  async _toggle(gid) {
    const node = this._nodes.get(gid)
    if (!node) return
    if (!node.children) await this._loadChildren(gid)
    node.expanded = !node.expanded
    this._bump()
  }

  _select(gid, name) {
    this.dispatchEvent(
      new CustomEvent('group-select', {
        detail: { id: gid, name },
        bubbles: true,
        composed: true,
      }),
    )
  }

  render() {
    const current = this._nodes.get(this.currentGid)
    const name = current?.name ?? '…'

    // Collapsed: a skinny full-height left rail with the group name rotated 90°.
    // A click anywhere on the rail expands it.
    if (this._collapsed) {
      return html`
        <button
          type="button"
          class="nt-group-nav nt-group-collapsed nt-group-toggle btn btn-light border-end rounded-0 p-1"
          style="writing-mode: vertical-rl; flex: 1 1 auto; text-align: start; overflow: hidden"
          title=${`Show groups — ${name}`}
          @click=${() => (this._collapsed = false)}
        >
          <span aria-hidden="true" class="me-2">▸</span>
          <span class="text-body-secondary small text-uppercase me-2">Group</span>
          <span class="fw-semibold">${name}</span>
        </button>
      `
    }

    // Expanded: full-height sidebar. Clicking the empty tree background (but not
    // a group row) collapses it back to the rail.
    return html`
      <div
        class="nt-group-nav border-end d-flex flex-column"
        style="width: 15rem; flex: 1 1 auto; min-height: 0"
      >
        <div class="d-flex align-items-center gap-1 p-2 border-bottom">
          <button
            type="button"
            class="btn btn-sm btn-link p-0 text-body-secondary nt-group-toggle"
            title="Hide groups"
            @click=${() => (this._collapsed = true)}
          >
            ◂
          </button>
          <span class="text-body-secondary small text-uppercase">Group</span>
          <span class="fw-semibold text-truncate" title=${name}>${name}</span>
        </div>
        <div
          class="nt-group-tree py-1 flex-grow-1"
          style="overflow: auto"
          title="Click empty space to collapse"
          @click=${this._onTreeBackgroundClick}
        >
          ${
            this._ready && this.rootGid != null
              ? this._renderNode(this.rootGid, 0)
              : html`<div class="small text-body-secondary p-2">Loading…</div>`
          }
        </div>
      </div>
    `
  }

  _onTreeBackgroundClick(e) {
    if (e.target === e.currentTarget) this._collapsed = true
  }

  _renderNode(gid, depth) {
    const node = this._nodes.get(gid)
    if (!node) return nothing
    const isCurrent = node.id === this.currentGid
    // The root is always shown expanded — collapsing it to an empty list is
    // pointless — so it gets no toggle caret.
    const showCaret = node.hasChildren && depth > 0
    const expanded = depth === 0 ? true : node.expanded
    return html`
      <div>
        <div
          class="d-flex align-items-center nt-group-row ${isCurrent ? 'active fw-semibold' : ''}"
          style="padding-left: ${0.25 + depth * 0.85}rem"
        >
          <a
            href="#"
            class="text-decoration-none text-body flex-grow-1 text-truncate nt-group-link"
            title=${node.name}
            @click=${(e) => {
              e.preventDefault()
              this._select(node.id, node.name)
            }}
            >${node.name}</a
          >
          ${
            showCaret
              ? html`<button
                  type="button"
                  class="btn btn-sm btn-link p-0 ms-1 text-body-tertiary nt-group-caret"
                  aria-label="Toggle subgroups"
                  @click=${() => this._toggle(node.id)}
                >
                  ${node.expanded ? '▾' : '▸'}
                </button>`
              : nothing
          }
        </div>
        ${
          expanded && node.children
            ? node.children.map((c) => this._renderNode(c, depth + 1))
            : nothing
        }
      </div>
    `
  }
}

customElements.define('nt-group-nav', GroupNav)
