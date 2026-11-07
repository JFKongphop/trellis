import { renderTrellisOg } from "./_og/trellis-og";

export const runtime = "nodejs";
// Render once at build (sharp + ImageResponse run in CI, never per request).
export const dynamic = "force-static";
export { size, contentType, alt } from "./_og/trellis-og";

export default function TwitterImage() {
  return renderTrellisOg();
}
