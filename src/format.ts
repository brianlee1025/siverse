// Shared text formatters for the UI (round 13: the first piece of one formatter module, R7-M29).

/** "15:00" today, otherwise "Tue 09:00". */
export function formatTime(at: number) {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
