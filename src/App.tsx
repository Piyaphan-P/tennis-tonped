import { useAppStore } from './store';
import HomeScreen from './screens/HomeScreen';
import LiveScreen from './screens/LiveScreen';
import SummaryScreen from './screens/SummaryScreen';
import DevPlanScreen from './screens/DevPlanScreen';
import HistoryScreen from './screens/HistoryScreen';
import AdminScreen from './screens/AdminScreen';
import SettingsSheet from './components/SettingsSheet';
import BottomNav from './components/BottomNav';
import LoginGate from './components/LoginGate';
import KioskGate from './components/KioskGate';
import { readKioskParams } from './kiosk';

/** Root: screen switcher driven by store.screen + global sheet + bottom nav.
 *  Normally wrapped in LoginGate — the server's /api/* credential gate (SIT)
 *  must be passed before anything renders; fails open when no gate exists (dev).
 *  When the app is embedded in a room iframe (`?kiosk=1`, see readKioskParams),
 *  KioskGate replaces LoginGate: auth is a stateless x-kiosk-token header, so
 *  it renders immediately and auto-starts the live session. Both branches
 *  render the SAME screen children. */
export default function App() {
  const screen = useAppStore((s) => s.screen);
  const isAdmin = useAppStore((s) => s.auth?.role === 'admin');
  // Parsed once per mount — kiosk mode is fixed for the life of the iframe.
  const kiosk = readKioskParams();

  const screenChildren = (
    <div className={`app-root${screen !== 'live' ? ' has-nav' : ''}`}>
      {screen === 'home' && <HomeScreen />}
      {screen === 'live' && <LiveScreen />}
      {screen === 'summary' && <SummaryScreen />}
      {screen === 'devplan' && <DevPlanScreen />}
      {/* Compare is un-routed (2026-07-20): the screen value falls back to
          Home like the admin fallback. CompareScreen stays on disk. */}
      {screen === 'compare' && <HomeScreen />}
      {screen === 'history' && <HistoryScreen />}
      {/* Admin is role-gated: a non-admin landing here (e.g. after logout)
          falls back to Home instead of a blank screen. */}
      {screen === 'admin' && (isAdmin ? <AdminScreen /> : <HomeScreen />)}
      <SettingsSheet />
      <BottomNav />
    </div>
  );

  if (kiosk) return <KioskGate params={kiosk}>{screenChildren}</KioskGate>;
  return <LoginGate>{screenChildren}</LoginGate>;
}
