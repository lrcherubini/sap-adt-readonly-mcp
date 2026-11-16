// The ABAP 14-digit timestamp (yyyymmddhhmmss) as ISO 8601, without inventing a time zone.
//
// The ADT and the tables it reads write times two ways, and only a measurement says which:
//   UTC          the `from` of the dump feed's self link: the newest dump published at
//                12:17:59Z had `from=…121759` (measured 2026-11-12);
//   system-local CTS `tm:lastchanged_timestamp`: the request created at 16:30:46Z answered
//                `…173046` (measured 2026-11-12), an hour ahead -- the system's zone;
//   not measured the TMS tables' own stamps (TCEVERS CHANGED, ACTIVATION, DEACTIVAT).
//
// A UTC stamp gets its `Z`. Every other one is written without an offset, which in ISO 8601
// means local time: the reading is the system's clock, and the answer does not claim a zone it
// does not know. All zeros (or blank) is no time at all: null.

const STAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

export function isoOfStamp(value, { utc = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s || /^0+$/.test(s)) return null;
  const m = STAMP.exec(s);
  if (!m) return value;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${utc ? 'Z' : ''}`;
}
