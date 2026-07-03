import { useAppStore } from './store';
import HomeScreen from './screens/HomeScreen';
import LiveScreen from './screens/LiveScreen';
import SummaryScreen from './screens/SummaryScreen';
import DevPlanScreen from './screens/DevPlanScreen';
import SettingsSheet from './components/SettingsSheet';
import BottomNav from './components/BottomNav';

/** Root: screen switcher driven by store.screen + global sheet + bottom nav. */
export default function App() {
  const screen = useAppStore((s) => s.screen);

  return (
    <div className={`app-root${screen !== 'live' ? ' has-nav' : ''}`}>
      {screen === 'home' && <HomeScreen />}
      {screen === 'live' && <LiveScreen />}
      {screen === 'summary' && <SummaryScreen />}
      {screen === 'devplan' && <DevPlanScreen />}
      <SettingsSheet />
      <BottomNav />
    </div>
  );
}
