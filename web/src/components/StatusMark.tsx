const SYMBOL: Record<string, string> = {
  blocked: "×",
  working: "●",
  done: "✓",
  idle: "○",
  unknown: "·",
};

export function StatusMark({ status, symbols }: { status: string; symbols: boolean }) {
  const name = SYMBOL[status] ? status : "unknown";
  if (!symbols) return <span className={`mark mark-dot status-${name}`} aria-hidden="true" />;
  return (
    <span className={`mark mark-symbol status-${name}`} aria-hidden="true">
      {SYMBOL[name]}
    </span>
  );
}

export function IndicatorSample({ symbols }: { symbols: boolean }) {
  return (
    <span className="indicator-sample" aria-hidden="true">
      {["blocked", "working", "done", "idle", "unknown"].map((status) => (
        <StatusMark key={status} status={status} symbols={symbols} />
      ))}
    </span>
  );
}
