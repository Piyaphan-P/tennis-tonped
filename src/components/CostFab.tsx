// ============================================================================
// ต้นและเพชร Tennis Club — CostFab
//
// COST DEMOTED: the big live cost meter is gone from the Live screen. This is
// the replacement — a small corner "฿" button that, on tap, opens a compact
// panel with the THB total + a per-modality breakdown. It exists purely for
// TESTING THE NUMBERS; full cost tracking keeps running under the hood
// (store.cost) regardless of whether this panel is ever opened.
//
// Self-contained: ships its own scoped CSS (below) so it does not depend on
// edits to the shared theme.css. Manages its own open/close state — the Live
// screen just renders <CostFab/> inside its (positioned) overlay stage.
// ============================================================================

import { useEffect, useState } from 'react';
import { useAppStore, selectTHBPerShot } from '../store';
import { useT, type I18nKey } from '../i18n';
import { formatTHB, formatTokens } from '../cost/pricing';
import type { CostBreakdown, TokenTotals } from '../types';

interface Row {
  tokenKey: keyof TokenTotals;
  thbKey: keyof CostBreakdown;
  labelKey: I18nKey;
}

const ROWS: Row[] = [
  { tokenKey: 'textIn', thbKey: 'textInTHB', labelKey: 'token.textIn' },
  { tokenKey: 'audioIn', thbKey: 'audioInTHB', labelKey: 'token.audioIn' },
  { tokenKey: 'videoIn', thbKey: 'videoInTHB', labelKey: 'token.videoIn' },
  { tokenKey: 'textOut', thbKey: 'textOutTHB', labelKey: 'token.textOut' },
  { tokenKey: 'audioOut', thbKey: 'audioOutTHB', labelKey: 'token.audioOut' },
  { tokenKey: 'thoughts', thbKey: 'thoughtsTHB', labelKey: 'token.thoughts' },
];

/** Small corner ฿ button + tap-to-open THB/per-modality testing panel. */
export default function CostFab() {
  const [open, setOpen] = useState(false);
  const t = useT();
  const tokens = useAppStore((s) => s.cost.tokens);
  const breakdown = useAppStore((s) => s.cost.breakdown);
  const usageEvents = useAppStore((s) => s.cost.usageEvents);
  const perShot = useAppStore(selectTHBPerShot);

  // Escape closes the panel too (keyboard/desktop testing convenience).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="cost-fab">
      <style>{`
        .cost-fab {
          position: absolute;
          right: max(env(safe-area-inset-right, 0px), 0px);
          bottom: max(env(safe-area-inset-bottom, 0px), 0px);
          margin: 0 10px 10px;
          z-index: 35;
        }
        .cost-fab-btn {
          width: 44px;
          height: 44px;
          min-height: 0;
          border-radius: 50%;
          border: 1px solid var(--line, rgba(255,255,255,0.12));
          background: var(--surface, #0e181a);
          color: var(--text, #f2f6f4);
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 1.05rem;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          cursor: pointer;
          box-shadow: var(--shadow-1, 0 1px 2px rgba(0,0,0,0.4));
        }
        .cost-fab-btn:active {
          transform: scale(0.96);
        }
        .cost-fab-backdrop {
          position: fixed;
          inset: 0;
          z-index: 34;
          background: transparent;
        }
        .cost-fab-panel {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          z-index: 36;
          width: 232px;
          background: var(--surface, #0e181a);
          border: 1px solid var(--line, rgba(255,255,255,0.12));
          border-radius: var(--radius, 14px);
          box-shadow: var(--shadow-2, 0 8px 28px rgba(0,0,0,0.5));
          padding: 12px;
        }
        .cost-fab-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
        }
        .cost-fab-title {
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--text-dim, #9fb0ad);
        }
        .cost-fab-close {
          appearance: none;
          border: 0;
          background: transparent;
          color: var(--text-dim, #9fb0ad);
          font-size: 0.75rem;
          font-weight: 700;
          cursor: pointer;
          padding: 2px 4px;
        }
        .cost-fab-total {
          font-family: var(--font-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          font-size: 1.5rem;
          font-weight: 800;
          color: var(--accent, #d6f441);
          margin-bottom: 8px;
        }
        .cost-fab-rows {
          display: flex;
          flex-direction: column;
          gap: 4px;
          border-top: 1px solid var(--line, rgba(255,255,255,0.12));
          padding-top: 6px;
        }
        .cost-fab-row {
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 8px;
          align-items: baseline;
          font-size: 0.75rem;
        }
        .cost-fab-row-label {
          color: var(--text, #f2f6f4);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cost-fab-row-tokens {
          font-family: var(--font-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          color: var(--text-dim, #9fb0ad);
          text-align: right;
        }
        .cost-fab-row-thb {
          font-family: var(--font-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          color: var(--text, #f2f6f4);
          text-align: right;
          min-width: 5ch;
        }
        .cost-fab-foot {
          margin-top: 8px;
          padding-top: 6px;
          border-top: 1px solid var(--line, rgba(255,255,255,0.12));
          font-family: var(--font-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums;
          font-size: 0.7rem;
          color: var(--text-faint, #63736f);
        }
      `}</style>

      {open && <div className="cost-fab-backdrop" onClick={() => setOpen(false)} />}

      <button
        type="button"
        className="cost-fab-btn tap"
        aria-label={t('cost.button')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ฿
      </button>

      {open && (
        <div className="cost-fab-panel" onClick={(e) => e.stopPropagation()}>
          <div className="cost-fab-head">
            <span className="cost-fab-title">{t('cost.title')}</span>
            <button
              type="button"
              className="cost-fab-close tap"
              onClick={() => setOpen(false)}
            >
              {t('common.close')}
            </button>
          </div>

          <div className="cost-fab-total">{formatTHB(breakdown.thbTotal)}</div>

          <div className="cost-fab-rows">
            {ROWS.map((row) => (
              <div className="cost-fab-row" key={row.tokenKey}>
                <span className="cost-fab-row-label">{t(row.labelKey)}</span>
                <span className="cost-fab-row-tokens">
                  {formatTokens(tokens[row.tokenKey])}
                </span>
                <span className="cost-fab-row-thb">
                  {formatTHB(breakdown[row.thbKey])}
                </span>
              </div>
            ))}
          </div>

          <div className="cost-fab-foot">
            ~{formatTHB(perShot)} {t('common.perShot')} · {usageEvents}{' '}
            {t('cost.usageEvents')} · {t('common.approx')}
          </div>
        </div>
      )}
    </div>
  );
}
