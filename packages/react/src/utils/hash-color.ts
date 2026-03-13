const COLORS_500 = [
  "bg-indigo-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-sky-500",
  "bg-teal-500",
];

const COLORS_600 = [
  "bg-indigo-600",
  "bg-violet-600",
  "bg-cyan-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-sky-600",
  "bg-teal-600",
];

const cache = new Map<string, string>();

export function hashColor(str: string, intensity: 500 | 600 = 500): string {
  const key = `${str}\0${intensity}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = intensity === 600 ? COLORS_600 : COLORS_500;
  const result = colors[Math.abs(hash) % colors.length]!;
  cache.set(key, result);
  return result;
}
