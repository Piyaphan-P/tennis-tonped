import { useAppStore } from '../store';

/** TH / EN language switch. */
export default function LangToggle() {
  const lang = useAppStore((s) => s.lang);
  const setLang = useAppStore((s) => s.setLang);
  return (
    <div className="chip tap" role="group" aria-label="language">
      <button
        className="btn-ghost tap"
        style={{ border: 0, padding: '2px 8px', color: lang === 'th' ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 700, background: 'transparent', cursor: 'pointer' }}
        onClick={() => setLang('th')}
      >
        TH
      </button>
      <span className="faint">/</span>
      <button
        className="btn-ghost tap"
        style={{ border: 0, padding: '2px 8px', color: lang === 'en' ? 'var(--accent)' : 'var(--text-dim)', fontWeight: 700, background: 'transparent', cursor: 'pointer' }}
        onClick={() => setLang('en')}
      >
        EN
      </button>
    </div>
  );
}
