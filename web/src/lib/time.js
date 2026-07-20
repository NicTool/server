export function secondsToHuman(secs) {
  const n = parseInt(secs, 10)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return '0s'
  const units = [
    [604800, 'w', 1],
    [86400, 'd', 1],
    [3600, 'h', 1],
    [60, 'm', 0],
    [1, 's', 0],
  ]
  for (const [div, unit, decimals] of units) {
    if (n >= div) {
      const val = n / div
      const factor = Math.pow(10, decimals)
      const rounded = Math.round(val * factor) / factor
      return `${rounded}${unit}`
    }
  }
  return `${n}s`
}

export function parseHumanTime(raw) {
  const s = `${raw ?? ''}`.trim()
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([smhdwSMHDW])$/)
  if (!match) return null
  const val = parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }
  return Math.round(val * multipliers[unit])
}
