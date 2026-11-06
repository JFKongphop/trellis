import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors outline-hidden",
        "bg-light-taupe data-checked:bg-deliver-green",
        "focus-visible:ring-2 focus-visible:ring-deliver-green/40",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "block size-4 rounded-full bg-canvas-white shadow-button transition-transform",
          "data-checked:translate-x-4 data-unchecked:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
