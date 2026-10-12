import type { ReactNode } from 'react';

/** Seletor em forma de pílula (como os do campo do Claude Code): rótulo discreto + lista nativa. */
export function OptionSelect(props: { label: string; value: string; onChange(value: string): void; disabled?: boolean; title?: string; children: ReactNode }) {
  const { label, value, onChange, disabled, title, children } = props;
  return (
    <label className="pill" title={title}>
      <span className="pill-label">{label}</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}
