import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  onSelect(): void;
}

const MENU_W = 200;
const MENU_H = 90;

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onAway = () => onClose();
    document.addEventListener('keydown', onKey);
    // Fase de captura: o React Flow consome mousedown/pointerdown/wheel no canvas antes de chegarem ao document.
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onAway, true);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onAway, true);
      window.removeEventListener('blur', onAway);
      previous?.focus?.();
    };
  }, [onClose]);

  const move = (dir: 1 | -1) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + dir + els.length) % els.length]!.focus();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="Menu do canvas"
      style={{ left: Math.max(0, Math.min(x, window.innerWidth - MENU_W)), top: Math.max(0, Math.min(y, window.innerHeight - MENU_H)) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      }}
    >
      {items.map((it) => (
        <button key={it.label} role="menuitem" className="menu-item" onClick={() => { onClose(); it.onSelect(); }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
