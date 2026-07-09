import { useAppStore } from './store';
import HomeScreen from './screens/HomeScreen';
import LiveScreen from './screens/LiveScreen';
import SummaryScreen from './screens/SummaryScreen';
import DevPlanScreen from './screens/DevPlanScreen';
import CompareScreen from './screens/CompareScreen';
import HistoryScreen from './screens/HistoryScreen';
import SettingsSheet from './components/SettingsSheet';
import BottomNav from './components/BottomNav';
import LoginGate from './components/LoginGate';

/** Root: screen switcher driven by store.screen + global sheet + bottom nav.
 *  Wrapped in LoginGate — the server's /api/* credential gate (SIT) must be
 *  passed before anything renders; fails open when no gate exists (dev). */
export default function App() {
  const screen = useAppStore((s) => s.screen);

  return (
    <LoginGate>
      <div className={`app-root${screen !== 'live' ? ' has-nav' : ''}`}>
        {screen === 'home' && <HomeScreen />}
        {screen === 'live' && <LiveScreen />}
        {screen === 'summary' && <SummaryScreen />}
        {screen === 'devplan' && <DevPlanScreen />}
        {screen === 'compare' && <CompareScreen />}
        {screen === 'history' && <HistoryScreen />}
        <SettingsSheet />
        <BottomNav />
      </div>
    </LoginGate>
  );
}
