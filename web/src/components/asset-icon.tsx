"use client";

import { useState } from "react";
import { fallbackBg, initials } from "@/lib/protocol-icons";

type Props = {
  src?: string;
  label: string;
  size?: number;
};

/**
 * Logo-mark primitive per DESIGN.md.
 *
 * 14px border-radius (rounded-mark), no border, no shadow.
 * Falls back to an initials block on the same lime/dark palette.
 */
export function AssetIcon({ src, label, size = 40 }: Props) {
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    return (
      <div
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center text-midnight-ink rounded-card text-[Math.max(11,size*0.36)] font-semibold tracking-[-0.015em]"
        style={{ width: size, height: size, background: fallbackBg(label) }}
      >
        {initials(label)}
      </div>
    );
  }

  return (
    // Token icons are data URIs / arbitrary hosts: next/image doesn't help here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErrored(true)}
      className="shrink-0 object-cover rounded-card"
    />
  );
}
