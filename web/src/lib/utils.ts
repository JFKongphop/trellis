import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register the app's custom font-size tokens (globals.css @theme) so
// tailwind-merge classifies them as font-size, not text-color. Without this,
// `text-caption`/`text-body-sm`/… get treated as colors and are silently
// dropped when a real color (e.g. text-midnight-ink) is in the same cn() call.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "caption",
            "body-sm",
            "body",
            "body-lg",
            "display-sm",
            "display",
            "hero",
            "subhead",
            "title",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
