/** Piecewise-linear maps between fader / meter positions (0 bottom … 1 top) and decibels. */

type Table = [pos: number, db: number][]

// A console-style fader law: most of the travel goes to the useful range around 0 dB.
const FADER: Table = [
  [0, -60],
  [0.25, -30],
  [0.5, -12],
  [0.75, 0],
  [1, 12],
]

const METER: Table = [
  [0, -60],
  [0.2, -40],
  [0.44, -24],
  [0.66, -12],
  [0.78, -6],
  [0.9, 0],
  [1, 6],
]

function toPos(table: Table, db: number) {
  if (!Number.isFinite(db) || db <= table[0][1]) return 0
  for (let i = 1; i < table.length; i++) {
    const [p0, d0] = table[i - 1]
    const [p1, d1] = table[i]
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0)
  }
  return 1
}

function toDb(table: Table, pos: number) {
  if (pos <= 0) return table[0][1]
  for (let i = 1; i < table.length; i++) {
    const [p0, d0] = table[i - 1]
    const [p1, d1] = table[i]
    if (pos <= p1) return d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0)
  }
  return table[table.length - 1][1]
}

export const faderPos = (db: number) => toPos(FADER, db)
export const faderDb = (pos: number) => toDb(FADER, pos)
export const meterPos = (db: number) => toPos(METER, db)

export const FADER_MARKS = [12, 6, 0, -6, -12, -24, -40, -60]

export const formatDb = (db: number) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)}`)
