import { ImageResponse } from "next/og";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Shared renderer for the Open Graph / Twitter cards. Mirrors the site: the
// WebGL metaball glow (parts/gradient-field.tsx) — blue + green + gold blobs
// confined to the bottom-right over clean #f6f5f3, plus film grain — with the
// navbar logo lockup (lattice + "trellis") sized up and centered.
//
// The brand font ships as a variable woff2 Satori can't parse, so a static
// instance is committed: Brand-wordmark.ttf = wght 600 + STBL 0 + ss02 frozen
// (Satori can't apply OpenType features at render time), i.e. the navbar's
// `font-alt` rendering.

export const size = { width: 1200, height: 630 };
export const contentType = "image/jpeg";
export const alt = "Trellis: an AI DeFi agent on NEAR that acts only inside your rules";

const INK = "#111111";

// Film grain — resvg renders feTurbulence; black speckles with noise-driven
// alpha so it reads as grain on a normal composite (matches the shader's
// darkening grain).
const GRAIN =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='630'>` +
      `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/>` +
      `<feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.7 0 0 0 0'/></filter>` +
      `<rect width='100%' height='100%' filter='url(#g)'/></svg>`,
  );

/** The lattice brand mark (same paths as the navbar TrellisLogo). */
function Lattice({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 20 20 4M4 12l8-8M12 20l8-8M4 4l16 16M4 12l8 8M12 4l8 8"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export async function renderTrellisOg() {
  const wordmark = await readFile(
    join(process.cwd(), "src/app/Brand-wordmark.ttf"),
  );

  const png = new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Lift the lockup above true center — the bottom-right glow weights the
          // lower half, so dead-center reads low.
          paddingBottom: 48,
          backgroundColor: "#f6f5f3",
          // Metaball glow confined to the bottom-right (blue + green + gold),
          // fading to clean base toward the top-left — the site's hero wash.
          backgroundImage: [
            "radial-gradient(54% 66% at 102% 62%, rgba(251,199,104,0.75), rgba(251,199,104,0) 62%)",
            "radial-gradient(70% 80% at 62% 106%, rgba(50,142,250,0.62), rgba(50,142,250,0) 62%)",
            "radial-gradient(86% 96% at 96% 99%, rgba(71,208,150,0.92), rgba(71,208,150,0) 60%)",
          ].join(","),
          fontFamily: "BrandWord",
        }}
      >
        {/* Film grain overlay */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={GRAIN}
          width={1200}
          height={630}
          alt=""
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            opacity: 0.14,
          }}
        />

        {/* Logo lockup — seedling + wordmark, sized up */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
          }}
        >
          <Lattice size={150} color={INK} />
          <div
            style={{
              fontSize: 196,
              fontWeight: 600,
              color: INK,
              letterSpacing: "-0.05em",
              lineHeight: 1,
            }}
          >
            trellis
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "BrandWord", data: wordmark, weight: 600, style: "normal" },
      ],
    },
  );

  // ImageResponse only emits a full-quality PNG, and the film grain is
  // high-frequency noise that balloons PNG to ~1MB. Re-encode to JPEG (no alpha
  // needed — the canvas is opaque) for a ~50KB, universally-supported card.
  const jpeg = await sharp(Buffer.from(await png.arrayBuffer()))
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();

  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      // Static content; the metadata URL is content-hashed, so cache hard.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
