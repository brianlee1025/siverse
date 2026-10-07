const FIRST_NAMES = [
  "Ava", "Kai", "Mei", "Omar", "Lena", "Ravi", "Zoe", "Hiro", "Nia", "Mateo", "Aisha", "Finn",
  "Priya", "Leo", "Sofia", "Jun", "Amara", "Theo", "Yuki", "Noah", "Ines", "Arjun", "Maya", "Felix",
  "Lin", "Sami", "Elena", "Kofi", "Hana", "Diego", "Iris", "Tariq", "Nora", "Wei", "Lucia", "Emeka",
];

/** Picks a first name that no current worker is using, when possible. */
export function pickWorkerName(inUse: Set<string>): string {
  const free = FIRST_NAMES.filter((n) => !inUse.has(n));
  const pool = free.length ? free : FIRST_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}
