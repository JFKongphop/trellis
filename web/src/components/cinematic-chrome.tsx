"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { ChatResetProvider } from "@/components/chat-reset";
import { GradientField } from "@/components/parts/gradient-field";
import { AmbientGlow } from "@/components/parts/ambient-glow";

export type CinematicMode = "bright" | "dim";

type Ctx = {
  mode: CinematicMode;
  setMode: (m: CinematicMode) => void;
};

const CinematicModeContext = createContext<Ctx>({
  mode: "dim",
  setMode: () => {},
});

/**
 * Mounted ONCE at the root layout. Renders the canvas-white base + the
 * Amplemarket gradient washes + the light header that persist across
 * page/state changes. Pages opt into a wash intensity via
 * `useSetCinematicMode("bright")` (landing hero — washes more present) or
 * "dim" (in-app — quiet) through the `<CinematicShell mode>` wrapper.
 */
export function CinematicChrome({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<CinematicMode>("dim");
  return (
    <CinematicModeContext.Provider value={{ mode, setMode }}>
      <AmbientGlow />
      <GradientField mode={mode} />
      <ChatResetProvider>
        <SiteHeader />
        <div className="relative z-20 flex min-h-screen w-full flex-col">
          {children}
        </div>
      </ChatResetProvider>
    </CinematicModeContext.Provider>
  );
}

export function useCinematicMode() {
  return useContext(CinematicModeContext);
}

/** Set the wash intensity for the lifetime of the calling component. */
export function useSetCinematicMode(mode: CinematicMode) {
  const { setMode } = useContext(CinematicModeContext);
  useEffect(() => {
    setMode(mode);
  }, [mode, setMode]);
}
