/** Botão de envio: avião de papel branco sobre fundo roxo. O rótulo vai no aria-label e na dica. */
export function SendButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick(): void }) {
  return (
    <button className="send-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </button>
  );
}
