import { useEffect, useRef, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";

export function useComposerPopover(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open, setOpen]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const trigger = root.current?.querySelector<HTMLButtonElement>("button");
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger?.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!open && event.target !== trigger) return;
    event.preventDefault(); event.stopPropagation();
    const focusOption = () => {
      const choices = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".composer-popover button:not(:disabled)") ?? []);
      if (!choices.length) return;
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : index < 0 ? 0 : (index + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
      choices[next]?.focus();
    };
    if (!open) { setOpen(true); window.setTimeout(focusOption, 0); } else focusOption();
  };
  return { ref: root, onKeyDown };
}
