import { useT } from '../i18n';

/**
 * Tennis-ball dot + wordmark.
 * compact=true: small inline mark (used inside chips/headers elsewhere).
 * compact=false (default): banner-grade — big, bold, high-contrast — this IS
 * the prominent brand banner required on Home.
 */
export default function BrandMark({ compact = false }: { compact?: boolean }) {
  const t = useT();
  return (
    <span
      className="brand"
      style={
        compact
          ? { fontSize: '1rem' }
          : {
              fontSize: 'clamp(1.35rem, 6vw, 1.75rem)',
              fontWeight: 900,
              letterSpacing: '-0.03em',
              color: 'var(--text)',
              textShadow: '0 0 24px rgba(214, 244, 65, 0.25)',
            }
      }
    >
      <span
        className="brand-dot"
        aria-hidden
        style={compact ? undefined : { width: 20, height: 20, boxShadow: '0 0 18px rgba(214, 244, 65, 0.75)' }}
      />
      {t('brand.name')}
    </span>
  );
}
