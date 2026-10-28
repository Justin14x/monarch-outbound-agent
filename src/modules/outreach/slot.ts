export type OutreachSlot = "morning" | "late";

export function slotBounds(value: OutreachSlot, now = new Date()): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "shortOffset",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday");
  const minuteOfDay = Number(part("hour")) * 60 + Number(part("minute"));
  const start = value === "morning" ? 8 * 60 + 30 : 10 * 60 + 15;
  if (["Sat", "Sun"].includes(weekday) || minuteOfDay < start || minuteOfDay >= start + 45) {
    throw new Error(`The ${value} live slot runs only on weekdays within 45 minutes of its scheduled America/Chicago start`);
  }
  const offset = part("timeZoneName").match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!offset) throw new Error("Could not calculate the America/Chicago timezone offset");
  const signedMinutes = (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0));
  const startEpoch = Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")),
    Math.floor(start / 60), start % 60) - signedMinutes * 60_000;
  return { start: new Date(startEpoch).toISOString(), end: new Date(startEpoch + 45 * 60_000).toISOString() };
}
