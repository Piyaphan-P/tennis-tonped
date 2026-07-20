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

/** Root: screen switcher driven by store.screen + global sheet + bottom nav.
 *  Wrapped in LoginGate — the server's /api/* credential gate (SIT) must be
 *  passed before anything renders; fails open when no gate exists (dev). */
export default function App() {
  const screen = useAppStore((s) => s.screen);
  const isAdmin = useAppStore((s) => s.auth?.role === 'admin');

  return (
    <LoginGate>
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
    </LoginGate>
  );
}
