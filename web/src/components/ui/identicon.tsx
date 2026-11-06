// Deterministic gradient avatar for an account id. A 2-color linear base on the
// Amplemarket accent palette, overlaid with a few soft radial "blobs" (a mesh
// gradient) seeded by the address hash — smoothly blended, no hard edges, yet
// distinct per address. Each blob fades to its own transparent color (`#rrggbb00`)
// so there's no dark halo. Inline style is allowed here — these are the
// runtime-dynamic hashed avatar values, the explicit carve-out in the design rules.

const PALETTE = [
  "#328efa", // intelligence blue
  "#47d096", // deliver green
  "#fbc768", // engagement gold
  "#e16540", // lead-gen red
  "#10054d", // deep indigo
  "#2e2460", // midnight violet
  "#e8400d", // phoenix orange
  "#272625", // surface charcoal
];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** mulberry32 — a tiny deterministic PRNG so one seed yields many varied values. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Identicon({
  address,
  size = 40,
  className,
}: {
  address: string;
  size?: number;
  className?: string;
}) {
  const r = rng(hash(address));
  const pick = () => PALETTE[Math.floor(r() * PALETTE.length)];

  const c1 = pick();
  const c2 =
    PALETTE[(PALETTE.indexOf(c1) + 3 + Math.floor(r() * 3)) % PALETTE.length];
  const angle = Math.floor(r() * 360);

  // Soft color blobs painted on top of the base, each fading to transparent so
  // they melt together. Layers paint first-on-top, so blobs precede the base.
  const blobs = Array.from({ length: 4 }, () => {
    const x = Math.round(r() * 100);
    const y = Math.round(r() * 100);
    const radius = Math.round(40 + r() * 50);
    const color = pick();
    return `radial-gradient(circle at ${x}% ${y}%, ${color} 0%, ${color}00 ${radius}%)`;
  });

  const backgroundImage = [
    ...blobs,
    `linear-gradient(${angle}deg, ${c1}, ${c2})`,
  ].join(", ");

  return (
    <span
      aria-hidden
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        backgroundImage,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}
