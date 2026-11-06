"use client";

import { type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { Menu } from "@base-ui/react/menu";
import { ArrowUp, ChevronsUpDown, Check } from "lucide-react";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/chat-limits";
import { selectableModels } from "@/lib/ai/pricing";
import { cn } from "@/lib/utils";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Selected model id. Renders the picker when paired with onModelChange. */
  model?: string;
  onModelChange?: (id: string) => void;
};

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "what do you want to do?",
  autoFocus,
  model,
  onModelChange,
}: Props) {
  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) onSubmit();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 bg-canvas-white px-3 py-2.5 shadow-button ring-1 ring-hairline transition-[box-shadow] focus-within:ring-midnight-ink/20 rounded-card">
      <textarea
        autoFocus={autoFocus}
        value={value}
        rows={1}
        maxLength={MAX_USER_MESSAGE_CHARS}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_USER_MESSAGE_CHARS))}
        onKeyDown={handleKey}
        className={cn(
          "relative w-full flex-1 resize-none border-0 bg-transparent px-3 text-midnight-ink placeholder:text-muted-ash/70 focus:outline-none disabled:opacity-50",
          "py-1.5 text-body-lg leading-[1.5] tracking-[-0.015em]",
        )}
      />

      {/* Config toolbar: model picker (left) · send (right). */}
      <div className="flex items-center justify-between gap-2 pl-1">
        {model && onModelChange ? (
          <ModelSelector model={model} onModelChange={onModelChange} />
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-1">
          <motion.button
            type="button"
            onClick={onSubmit}
            disabled={!value.trim() || disabled}
            aria-label="Send"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", visualDuration: 0.2, bounce: 0.4 }}
            className="inline-flex size-9 shrink-0 items-center justify-center bg-midnight-ink text-canvas-white disabled:bg-light-taupe disabled:text-muted-ash rounded-button"
          >
            <ArrowUp className="size-5" strokeWidth={2.5} />
          </motion.button>
        </div>
      </div>
    </div>
  );
}

function ModelSelector({
  model,
  onModelChange,
}: {
  model: string;
  onModelChange: (id: string) => void;
}) {
  const models = selectableModels();
  const active = models.find((m) => m.id === model);

  return (
    // modal={false}: a dropdown shouldn't lock page scroll — the scroll lock
    // removes the scrollbar/adds compensation and fights `scrollbar-gutter:
    // stable`, which shifts the whole page when the menu opens.
    <Menu.Root modal={false}>
      <Menu.Trigger
        render={
          <button
            type="button"
            className="inline-flex max-w-[60%] items-center gap-1 px-2 py-1 text-caption text-muted-ash transition-colors hover:bg-whisper-gray hover:text-midnight-ink rounded-button"
          />
        }
      >
        <span className="truncate font-medium">{active?.name ?? model}</span>
        <ChevronsUpDown className="size-3 shrink-0 opacity-70" strokeWidth={2.2} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Menu.Popup
            className={cn(
              "max-h-[60vh] w-[280px] max-w-[calc(100vw-2rem)] overflow-y-auto p-1 surface-card shadow-header rounded-card outline-none",
              "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:duration-100",
            )}
          >
            <Menu.RadioGroup
              value={model}
              onValueChange={(v) => onModelChange(String(v))}
            >
              {models.map((m) => (
                <Menu.RadioItem
                  key={m.id}
                  value={m.id}
                  className="flex cursor-pointer items-start gap-2 px-2.5 py-2 text-left outline-none transition-colors data-[highlighted]:bg-whisper-gray rounded-[10px]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body-sm font-medium text-midnight-ink">
                      {m.name}
                    </span>
                    <span className="mt-0.5 block text-caption leading-snug text-muted-ash">
                      {m.description}
                    </span>
                  </span>
                  <Menu.RadioItemIndicator className="mt-0.5 shrink-0">
                    <Check className="size-4 text-deliver-green" strokeWidth={2.6} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
