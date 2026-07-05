import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import * as api from '../data/api';
import {
  DEFAULT_REFS,
  loadRefPrefs,
  parseReferenceUrl,
  saveRefPref,
  youtubeEmbedUrl,
} from '../compare/referenceSource';
import type { CloudSessionSummary, Shot, ShotType } from '../types';
import './compare.css';

type Clip = {
  key: string;
  label: string;
  src: string;
  shotType: ShotType;
};

function focusToDefaultType(focusShot: 'forehand' | 'backhand' | 'both'): 'forehand' | 'backhand' {
  return focusShot === 'backhand' ? 'backhand' : 'forehand';
}

/** New screen: user's captured clip side-by-side with a correct-technique reference video. */
export default function CompareScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const shots = useAppStore((s) => s.shots);
  const focusShot = useAppStore((s) => s.settings.focusShot);
  const compareClip = useAppStore((s) => s.compareClip);
  const setCompareClip = useAppStore((s) => s.setCompareClip);

  const [cloudSessions, setCloudSessions] = useState<CloudSessionSummary[] | null>(null);
  const [cloudClips, setCloudClips] = useState<Clip[]>([]);
  const [cloudTried, setCloudTried] = useState(false);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deepLinkClip, setDeepLinkClip] = useState<Clip | null>(null);
  const [shotType, setShotType] = useState<'forehand' | 'backhand'>(
    focusToDefaultType(focusShot),
  );
  const [refInput, setRefInput] = useState<string>(
    () => loadRefPrefs()[shotType] ?? DEFAULT_REFS[shotType],
  );
  const [appliedRef, setAppliedRef] = useState<string>(refInput);

  void lang; // reserved for future date/locale formatting

  // Session clips: shots with an attached (session-only) clip.
  const sessionClips: Clip[] = useMemo(
    () =>
      shots
        .filter((sh: Shot) => !!sh.clip)
        .map((sh) => ({
          key: `session:${sh.id}`,
          label: `#${sh.index} ${t(sh.type === 'backhand' ? 'shot.backhand' : sh.type === 'forehand' ? 'shot.forehand' : 'shot.unknown')} · ${sh.score}`,
          src: sh.clip!.url,
          shotType: sh.type,
        })),
    [shots, t],
  );

  // Cloud history clips: fetched lazily on mount, then per-session detail.
  useEffect(() => {
    let alive = true;
    api.fetchHistory().then((list) => {
      if (!alive) return;
      setCloudTried(true);
      setCloudSessions(list);
      if (!list || list.length === 0) return;
      Promise.all(list.map((sess) => api.fetchSessionDetail(sess.id))).then((details) => {
        if (!alive) return;
        const clips: Clip[] = [];
        for (const detail of details) {
          if (!detail) continue;
          for (const sh of detail.shots) {
            if (!sh.hasClip) continue;
            clips.push({
              key: `cloud:${sh.id}`,
              label: `#${sh.idx} ${t(sh.type === 'backhand' ? 'shot.backhand' : sh.type === 'forehand' ? 'shot.forehand' : 'shot.unknown')} · ${sh.score}`,
              src: api.clipUrl(sh.id),
              shotType: sh.type,
            });
          }
        }
        setCloudClips(clips);
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseClips: Clip[] = useMemo(
    () => [...sessionClips, ...cloudClips],
    [sessionClips, cloudClips],
  );
  // Deep-linked clip isn't necessarily in the merged list (e.g. picked from
  // History detail directly) — keep it as a synthesized entry at the front.
  const allClips: Clip[] = useMemo(
    () => (deepLinkClip ? [deepLinkClip, ...baseClips] : baseClips),
    [deepLinkClip, baseClips],
  );

  // Preselect: deep-link compareClip from store, else newest session clip.
  useEffect(() => {
    if (selectedKey) return;
    if (compareClip) {
      const clip: Clip = {
        key: 'deeplink:compareClip',
        label: t('compare.pickClip'),
        src: compareClip.url,
        shotType: compareClip.shotType,
      };
      setDeepLinkClip(clip);
      setSelectedKey(clip.key);
      setShotType(compareClip.shotType === 'backhand' ? 'backhand' : 'forehand');
      setCompareClip(null);
      return;
    }
    if (baseClips.length > 0) {
      // Newest current-session clip (last in append order) if any; otherwise
      // the first cloud clip (/api/history is newest-session-first).
      const pick =
        sessionClips.length > 0 ? sessionClips[sessionClips.length - 1] : baseClips[0];
      setSelectedKey(pick.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseClips, compareClip]);

  // Reload the reference input when the shot type changes (unless the user
  // already typed something for this session — we key off shotType each time).
  useEffect(() => {
    const next = loadRefPrefs()[shotType] ?? DEFAULT_REFS[shotType];
    setRefInput(next);
    setAppliedRef(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotType]);

  const selectedClip: Clip | undefined = allClips.find((c) => c.key === selectedKey);

  const refSource = useMemo(() => parseReferenceUrl(appliedRef), [appliedRef]);

  function handleApply() {
    saveRefPref(shotType, refInput);
    setAppliedRef(refInput);
  }

  function selectClip(clip: Clip) {
    setSelectedKey(clip.key);
    if (clip.shotType === 'forehand' || clip.shotType === 'backhand') {
      setShotType(clip.shotType);
    }
  }

  return (
    <div className="screen compare-screen">
      <h1>{t('compare.title')}</h1>

      <div className="compare-grid">
        <section className="compare-pane">
          <h2>{t('compare.yourSwing')}</h2>
          {selectedClip ? (
            <video
              key={selectedClip.key}
              controls
              loop
              muted
              playsInline
              src={selectedClip.src}
              className="compare-video"
            />
          ) : (
            <div className="compare-empty card">{t('compare.noClips')}</div>
          )}

          {cloudTried && cloudSessions === null && (
            <p className="dim compare-hint">{t('compare.cloudOffline')}</p>
          )}

          <div className="clip-picker">
            {allClips.length === 0 && !selectedClip ? null : (
              <div className="clip-picker-row">
                {allClips.map((clip) => (
                  <button
                    key={clip.key}
                    type="button"
                    className={`clip-card${clip.key === selectedKey ? ' active' : ''}`}
                    onClick={() => selectClip(clip)}
                  >
                    {clip.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="compare-pane">
          <h2>{t('compare.reference')}</h2>

          <div className="row compare-shot-type">
            <span className="dim">{t('compare.shotType')}</span>
            <div className="row">
              <button
                type="button"
                className={`chip${shotType === 'forehand' ? ' active' : ''}`}
                onClick={() => setShotType('forehand')}
              >
                {t('shot.forehand')}
              </button>
              <button
                type="button"
                className={`chip${shotType === 'backhand' ? ' active' : ''}`}
                onClick={() => setShotType('backhand')}
              >
                {t('shot.backhand')}
              </button>
            </div>
          </div>

          {refSource?.kind === 'youtube' && (
            <div className="compare-embed-wrap">
              <iframe
                src={youtubeEmbedUrl(refSource.videoId)}
                allow="autoplay; encrypted-media"
                allowFullScreen
                title="reference"
                className="compare-embed"
              />
            </div>
          )}
          {refSource?.kind === 'video' && (
            <video controls loop muted playsInline src={refSource.url} className="compare-video" />
          )}
          {refSource === null && <div className="compare-empty card">{t('compare.badUrl')}</div>}

          <div className="ref-input-row row">
            <input
              type="text"
              className="ref-input"
              placeholder={t('compare.urlPlaceholder')}
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
            />
            <button type="button" className="btn btn-primary" onClick={handleApply}>
              {t('compare.apply')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
