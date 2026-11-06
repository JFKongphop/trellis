"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Dialog } from "@base-ui/react";
import { Menu, X } from "lucide-react";
import { WalletButton } from "@/components/wallet-button";
import { useChatReset } from "@/components/chat-reset";
import { SPRING_BOUNCY } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Lattice brand mark (a small trellis): Midnight Ink via currentColor. */
function TrellisLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <path
        d="M4 20 20 4M4 12l8-8M12 20l8-8M4 4l16 16M4 12l8 8M12 4l8 8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Brand({
  logoSize = 18,
  onClick,
}: {
  logoSize?: number;
  onClick?: () => void;
}) {
  const resetChat = useChatReset();
  // The logo always returns home AND wipes chat history → the idle hero.
  // On the home route the <Link> is a no-op nav, so the reset is what
  // actually clears an in-progress conversation.
  const handleClick = () => {
    resetChat();
    onClick?.();
  };
  return (
    <Link
      href="/"
      onClick={handleClick}
      className="flex items-center gap-0.5 text-canvas-white"
    >
      <TrellisLogo size={logoSize} />
      <span className="ml-1 font-alt text-2xl font-semibold lowercase tracking-tight mb-0.5">
        trellis
      </span>
    </Link>
  );
}

const TABS = [
  { href: "/", label: "Chat" },
  { href: "/vault", label: "Vault" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/feed", label: "Feed" },
];

function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className="relative rounded-button px-4 py-1.5 font-medium font-alt tracking-tight transition-colors"
          >
            {active && (
              <motion.span
                layoutId="nav-active-pill"
                transition={SPRING_BOUNCY}
                className="absolute inset-0 rounded-button bg-canvas-white/15 backdrop-blur-sm ring-1 ring-hairline shadow-button"
              />
            )}
            <span
              className={cn(
                "relative z-10",
                active
                  ? "text-canvas-white font-semibold"
                  : "text-canvas-white/55 hover:text-canvas-white"
              )}
            >
              {t.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile menu: hamburger trigger + left slide-in drawer carrying the tabs.
 *  Below `md` the centered pill can't fit brand + 3 tabs + wallet, so nav
 *  moves into a drawer; brand + wallet stay on the bar. */
function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="inline-flex size-9 items-center justify-center text-canvas-white/80 transition-colors hover:text-canvas-white rounded-button"
      >
        <Menu className="size-5" strokeWidth={2.2} />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <AnimatePresence>
          {open && (
            <Dialog.Portal keepMounted>
              <Dialog.Backdrop
                render={
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 z-40 bg-midnight-ink/30 backdrop-blur-sm"
                  />
                }
              />
              <Dialog.Popup
                render={
                  <motion.div
                    initial={{ x: "-100%" }}
                    animate={{ x: 0 }}
                    exit={{ x: "-100%" }}
                    transition={{ type: "spring", visualDuration: 0.28, bounce: 0.08 }}
                    className="fixed inset-y-0 left-0 z-50 flex w-[78%] max-w-xs flex-col gap-6 bg-surface-charcoal p-5 shadow-header"
                  />
                }
              >
                <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                <div className="flex items-center justify-between">
                  <Brand onClick={() => setOpen(false)} />
                  <Dialog.Close
                    render={
                      <button
                        type="button"
                        aria-label="Close menu"
                        className="inline-flex size-8 items-center justify-center text-canvas-white/70 transition-colors hover:text-canvas-white rounded-button"
                      >
                        <X className="size-4" strokeWidth={2.4} />
                      </button>
                    }
                  />
                </div>
                <nav className="flex flex-col gap-1">
                  {TABS.map((t) => {
                    const active = pathname === t.href;
                    return (
                      <Link
                        key={t.href}
                        href={t.href}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex items-center justify-between rounded-button px-3.5 py-2.5 font-alt font-medium tracking-tight transition-colors",
                          active
                            ? "bg-canvas-white/15 text-canvas-white ring-1 ring-hairline"
                            : "text-canvas-white/55 hover:bg-canvas-white/10 hover:text-canvas-white",
                        )}
                      >
                        {t.label}
                        {active && (
                          <span className="inline-block size-1.5 rounded-full bg-deliver-green" />
                        )}
                      </Link>
                    );
                  })}
                </nav>
              </Dialog.Popup>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
    </>
  );
}

export function SiteHeader() {
  // Desktop: a single centered floating capsule (brand · tabs · wallet).
  // Mobile (<md): a full-width bar — menu + brand left, wallet right — with the
  // tabs tucked into a slide-in drawer (the capsule can't fit them on a phone).
  return (
    <header className="fixed inset-x-0 top-3 z-30 flex w-full justify-center px-4">
      {/* Desktop pill */}
      <div className="hidden items-center gap-1.5 rounded-md bg-surface-charcoal py-1.5 pl-4 pr-1.5 ring-1 ring-canvas-white/15 shadow-header md:flex">
        <Brand />
        <span
          className="mx-2 h-5 w-px shrink-0 bg-canvas-white/15"
          aria-hidden
        />
        <NavTabs />
        <span
          className="mx-2 h-5 w-px shrink-0 bg-canvas-white/15"
          aria-hidden
        />
        <WalletButton tone="glass" />
      </div>

      {/* Mobile bar */}
      <div className="flex w-full items-center justify-between gap-2 rounded-md bg-surface-charcoal px-1.5 py-1.5 ring-1 ring-canvas-white/15 shadow-header md:hidden">
        <div className="flex items-center gap-1">
          <MobileNav />
          <Brand />
        </div>
        <WalletButton tone="glass" />
      </div>
    </header>
  );
}
