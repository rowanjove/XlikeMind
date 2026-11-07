import { useEffect, useRef } from 'react';

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]') &&
      !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden' &&
      (element.getClientRects().length > 0 || !dialog.getClientRects().length));
}

export function useDialogFocus(open: boolean, onEscape: () => void, active = true) {
  const ref = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const enabled = useRef(active);
  enabled.current = active;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const trigger = document.activeElement;
    const focusInside = (last = false) => {
      const controls = tabbableElements(dialog);
      (controls.at(last ? -1 : 0) ?? dialog).focus();
    };
    focusInside();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabled.current || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
      } else if (event.key === 'Tab') {
        const controls = tabbableElements(dialog);
        const focused = document.activeElement;
        if (!controls.some((control) => control === focused) ||
          focused === controls.at(event.shiftKey ? 0 : -1)) {
          event.preventDefault();
          focusInside(event.shiftKey);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  return ref;
}
