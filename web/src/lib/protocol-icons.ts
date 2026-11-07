/**
 * Brand-ish color seed for the letter fallback. Stable per-name.
 * Dark/neutral tones with white initials — reads cleanly on canvas-white.
 */
const FALLBACK_PALETTE = [
  "#0b0b0f", // black
  "#1f3a8a", // navy
  "#7c2d12", // burnt
  "#581c87", // plum
  "#9a3412", // rust
  "#0c4a6e", // deep blue
  "#4c1d95", // violet
];

export function fallbackBg(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

export function initials(label: string): string {
  const parts = label.replace(/\(.*\)/g, "").trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
