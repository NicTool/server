// https://stackoverflow.com/questions/4825683/how-do-i-create-and-read-a-value-from-cookie-with-javascript
export const Cookie = {
  get: (name) => {
    let c = document.cookie.match(`(?:(?:^|.*; *)${name} *= *([^;]*).*$)|^.*$`)[1]
    if (c) return decodeURIComponent(c)
  },
  set: (name, value, opts = {}) => {
    if (opts.days) {
      opts['max-age'] = opts.days * 60 * 60 * 24
      delete opts.days
    }

    opts = Object.entries(opts).reduce(
      (accumulatedStr, [k, v]) => `${accumulatedStr}; ${k}=${v}`,
      '',
    )

    document.cookie = name + '=' + encodeURIComponent(value) + opts
  },
  // path & domain must match cookie being deleted
  delete: (name, opts) => Cookie.set(name, '', { 'max-age': -1, ...opts }),
}
