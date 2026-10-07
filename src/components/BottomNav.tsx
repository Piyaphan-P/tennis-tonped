import { useAppStore, selectShotCount } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import type { Screen } from '../types';

interface NavItem {
  screen: Screen;
  labelKey: I18nKey;
  icon: string;
}

const ITEMS: NavItem[] = [
  { screen: 'home', labelKey: 'nav.home', icon: '⌂' },
  { screen: 'history', labelKey: 'nav.history', icon: '▤' },
  { screen: 'summary', labelKey: 'nav.summary', icon: '≡' },
  { screen: 'devplan', labelKey: 'nav.devplan', icon: '◎' },
];

/** Shown only when the signed-in user has role 'admin' (UAM v1.5). */
const ADMIN_ITEM: NavItem = { screen: 'admin', labelKey: 'nav.admin', icon: '⛭' };

/**
 * Persistent bottom navigation. Hidden during the live session (that screen is
 * immersive and owns its own controls). The Settings entry opens the sheet
 * rather than routing to a screen.
 */
export default function BottomNav() {
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const shotCount = useAppStore(selectShotCount);
  const isAdmin = useAppStore((s) => s.auth?.role === 'admin');
  const t = useT();

  if (screen === 'live') return null;

  const items = isAdmin ? [...ITEMS, ADMIN_ITEM] : ITEMS;

  return (
    <nav className="bottom-nav" aria-label="primary">
      {items.map((item) => {
        const active = screen === item.screen;
        // Summary is only meaningful once a session has produced shots.
        const disabled = item.screen === 'summary' && shotCount === 0;
        return (
          <button
            key={item.screen}
            className={`nav-item tap${active ? ' active' : ''}`}
            disabled={disabled}
            aria-current={active ? 'page' : undefined}
            onClick={() => !disabled && setScreen(item.screen)}
          >
            <span className="nav-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="nav-label">{t(item.labelKey)}</span>
          </button>
        );
      })}
      <button className="nav-item tap" onClick={() => setSettingsOpen(true)}>
        <span className="nav-icon" aria-hidden>
          ⚙
        </span>
        <span className="nav-label">{t('nav.settings')}</span>
      </button>
    </nav>
  );
}
