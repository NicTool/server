import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'

import { NtTableBase } from './table-base.js'
import { filterRows, sortRows } from '../lib/table-client.js'

const FIELDS = ['username', 'first_name', 'last_name', 'email']

const fullName = (u) => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()

/**
 * <nt-user-table .gid=${gid} .token=${jwt}>
 *
 * Client-side sortable/searchable user table (small set, no server pagination).
 * Emits `user-edit` / `user-create` for the app's offcanvas pane.
 */
export class UserTable extends NtTableBase {
  static properties = {
    gid: { attribute: false },
  }

  constructor() {
    super()
    this.gid = null
    this._sortBy = 'username'
    this._entityPath = '/user'
  }

  willUpdate(changed) {
    if (changed.has('gid')) this._load()
  }

  async _load() {
    this._loading = true
    this._error = ''
    try {
      const params = new URLSearchParams()
      if (this.gid) params.set('gid', `${this.gid}`)
      if (this._showDeleted) params.set('deleted', 'true')
      const data = await this._api(`/user?${params.toString()}`)
      this._rows = data?.user ?? []
    } catch {
      this._error = 'Failed to load users'
      this._rows = []
    } finally {
      this._loading = false
    }
  }

  _itemLabel(user) {
    return user.username
  }

  _confirmDeleteText(user) {
    return `Delete user ${user.username}?`
  }

  _onRowClick(e, user) {
    if (e.target.closest('button')) return
    this._emit('user-edit', { user })
  }

  render() {
    const view = sortRows(
      filterRows(this._rows, this._search, FIELDS),
      this._sortBy,
      this._sortDir,
    )
    return html`
      <div class="d-flex align-items-center gap-2 mb-2">
        <input
          type="search"
          class="form-control form-control-sm"
          style="max-width: 20rem"
          placeholder="Search users…"
          .value=${live(this._search)}
          @input=${(e) => (this._search = e.target.value)}
        />
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click=${() => this._emit('user-create', {})}
        >
          + Create
        </button>
        <div class="form-check form-switch mb-0 ms-1">
          <input
            class="form-check-input nt-show-deleted"
            type="checkbox"
            role="switch"
            id="nt-user-show-deleted"
            .checked=${live(this._showDeleted)}
            @change=${this._toggleShowDeleted}
          />
          <label
            class="form-check-label small text-body-secondary"
            for="nt-user-show-deleted"
          >
            Deleted
          </label>
        </div>
        <span class="ms-auto small text-body-secondary">
          ${this._loading ? 'Loading…' : `${view.length} user${view.length === 1 ? '' : 's'}`}
        </span>
      </div>

      ${this._error ? html`<div class="alert alert-danger py-1 px-2 small">${this._error}</div>` : nothing}
      ${this._renderNotice()}

      <table class="table table-sm table-striped table-hover align-middle mb-0">
        <thead>
          <tr>
            ${this._sortableTh('Username', 'username')}
            ${this._sortableTh('Name', 'first_name')}
            ${this._sortableTh('Email', 'email')}
            <th class="text-center" style="width: 5rem">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${view.map((u) => this._renderRow(u))}
          ${
            !this._loading && view.length === 0
              ? html`<tr>
                  <td colspan="4" class="text-center text-body-secondary py-3">
                    ${this._search ? 'No users match your search.' : 'No users.'}
                  </td>
                </tr>`
              : nothing
          }
        </tbody>
      </table>
    `
  }

  _renderRow(user) {
    const deleted = user.deleted === true
    return html`
      <tr
        class="user-row ${deleted ? 'text-body-secondary' : ''} ${this._deletingId === user.id ? 'opacity-50' : ''}"
        data-user-id=${user.id}
        style=${deleted ? '' : 'cursor: pointer'}
        @click=${deleted ? undefined : (e) => this._onRowClick(e, user)}
      >
        <td>${user.username ?? ''}</td>
        <td>${fullName(user)}</td>
        <td>${user.email ?? ''}</td>
        <td class="text-center text-nowrap">
          ${
            deleted
              ? html`<button
                  type="button"
                  class="btn btn-sm btn-link text-success p-0 user-restore-btn"
                  title="Restore user"
                  @click=${() => this._restoreRecord(user)}
                >
                  ↩ Restore
                </button>`
              : html`<button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 me-2 user-edit-btn"
                    title="Edit user"
                    @click=${() => this._emit('user-edit', { user })}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary p-0 user-delete-btn"
                    title="Delete user"
                    ?disabled=${this._deletingId === user.id}
                    @click=${() => this._deleteRecord(user)}
                  >
                    🗑
                  </button>`
          }
        </td>
      </tr>
    `
  }
}

customElements.define('nt-user-table', UserTable)
