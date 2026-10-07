import { useEffect, useRef, type ReactNode } from 'react';
import { useAppStore } from '../store';
import { audioPlayer } from '../coach/audioPlayer';
import { installKioskFetch, stripKioskTokenFromUrl, type KioskParams } from '../kiosk';

// ============================================================================
// KioskGate — replaces LoginGate when the app is embedded in a room-control
// iframe (`?kiosk=1&k=<KIOSK_KEY>&…`). Auth is stateless (an `x-kiosk-token`
// header on every /api/* fetch — see installKioskFetch), so there is NO network
// round-trip to gate on: children render immediately. On mount (once) it wires
// the fetch patch, hides the token from the URL, pushes the kiosk params into
// the store (voice/mode/verbosity/hand + LINE identity + synthetic auth), then
// starts the session and jumps to the Live screen — mirroring HomeScreen's
// "start" tap so LiveScreen's mount effect auto-runs camera + pose + coach.
// ============================================================================

export default function KioskGate({
  params,
  children,
}: {
  params: KioskParams;
  children: ReactNode;
}) {
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // 1. Carry the kiosk token on same-origin /api/* fetches, then scrub it
    //    from the visible URL so the key isn't shoulder-surfed.
    installKioskFetch(params.token);
    stripKioskTokenFromUrl();

    const s = useAppStore.getState();

    // 2. Coach preferences from the params (validated in readKioskParams).
    s.setVoiceTone(params.voiceTone);
    s.setCoachMode(params.coachMode);
    s.setVerbosity(params.verbosity);
    s.updateSettings({ dominantHand: params.dominantHand }); // no dedicated setter — updateSettings covers it

    // 3. LINE player identity for this session (also seeds userName). Only when
    //    a lineUserId was supplied — an empty profile would clobber a real one.
    if (params.lineUserId || params.displayName) {
      s.setLineProfile({
        lineUserId: params.lineUserId,
        displayName: params.displayName,
        pictureUrl: '',
        email: '',
      });
    }
    if (params.displayName) s.setUserName(params.displayName);

    // 4. Synthetic auth so store consumers (userName seeding, admin gating) see
    //    a consistent identity — matches the server's kiosk req.user.
    s.setAuth({ roomUser: 'kiosk', role: 'player', displayName: params.displayName || 'Kiosk' });

    // 5. Unlock audio defensively (the room page provides the real tap gesture
    //    before loading the iframe; this may no-op without one).
    try {
      void audioPlayer.unlock();
    } catch {
      /* no gesture yet — LiveScreen retries on the first pose tick */
    }

    // 6. Jump straight into the live coaching session (mirrors HomeScreen.start).
    s.startSession();
    s.setScreen('live');
  }, [params]);

  return <>{children}</>;
}
