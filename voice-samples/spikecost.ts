// Cost per shot, OLD (3.1 + realtime frames = blind) vs NEW (3.8 + inline frames),
// over one 5-shot session with the app's real prompts. Reads usageMetadata per turn.
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
import { buildCoachSystemPrompt, buildShotPrompt, VOICE_NAMES } from '../src/coach/liveClient';
const IMG = readFileSync(process.env.IMG_FILE || 'voice-samples/probe.jpg').toString('base64');
const N = Number(process.env.N || 5);
const RATE = { TEXT: 0.75, IMAGE: 1.0, AUDIO_IN: 3.0, AUDIO_OUT: 12.0, TEXT_OUT: 4.5 }; // USD/1M, Gemini 3.x Live
const THB = 36.5;
const angles: any = { timestampMs: 1, leftElbowDeg: 150, rightElbowDeg: 112, leftShoulderDeg: 40, rightShoulderDeg: 92, leftKneeDeg: 160, rightKneeDeg: 165, leftHipDeg: 170, rightHipDeg: 168, trunkLeanDeg: 8, wristSpeed: 2.6, bodyScale: 0.5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, model: string, inline: boolean) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: 'v1beta' } });
  let usage: any = null, done: (() => void) | null = null;
  const s = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAMES.gentleF } } },
      outputAudioTranscription: {},
      systemInstruction: buildCoachSystemPrompt('คุณลูกค้า', 'gentleF', 'encourage', 'short'),
    },
    callbacks: {
      onmessage: (m: any) => { if (m.usageMetadata) usage = m.usageMetadata; if (m.serverContent?.turnComplete) done?.(); },
      onerror: (e: any) => console.log('err', e?.message ?? e), onclose: () => {},
    },
  });
  const rows: any[] = [];
  for (let i = 1; i <= N; i++) {
    const caps: any[] = ['backswing', 'contact', 'follow-through'].map((phase, k) => ({ id: `c${i}${k}`, phase, tMs: k, angles, statuses: {}, jpegBase64: IMG, landmarks: [] }));
    const shot: any = { id: `s${i}`, index: i, type: i % 2 ? 'forehand' : 'backhand', startMs: 0, contactMs: 1, endMs: 2, contactAngles: angles, peakWristSpeed: 2.6, score: 60 + i * 5, issues: [{ key: 'elbow-too-bent', severity: 'warn' }], captures: caps };
    let text = buildShotPrompt(shot, 'th', 'right', 'both', 'คุณลูกค้า', caps, undefined, 'short');
    text += '\nThe still frames of this swing are attached in the order listed above — read them as one motion and ground your correction in what you see.';
    usage = null;
    const fin = new Promise<void>((r) => (done = r));
    if (inline) {
      s.sendClientContent({ turns: [{ role: 'user', parts: [...caps.map((c) => ({ inlineData: { mimeType: 'image/jpeg', data: c.jpegBase64 } })), { text }] }], turnComplete: true });
    } else {
      for (const c of caps) s.sendRealtimeInput({ video: { data: c.jpegBase64, mimeType: 'image/jpeg' } });
      s.sendClientContent({ turns: text, turnComplete: true });
    }
    await Promise.race([fin, sleep(40000)]);
    await sleep(300); // let the trailing usageMetadata land
    const by = (arr: any[] | undefined, mod: string) => (arr ?? []).filter((d) => d.modality === mod).reduce((a, d) => a + (d.tokenCount ?? 0), 0);
    const p = usage?.promptTokensDetails, r = usage?.responseTokensDetails;
    const row = { shot: i, inText: by(p, 'TEXT'), inImage: by(p, 'IMAGE'), inAudio: by(p, 'AUDIO'), outAudio: by(r, 'AUDIO'), outText: by(r, 'TEXT'), thoughts: usage?.thoughtsTokenCount ?? 0 };
    const usd = (row.inText * RATE.TEXT + row.inImage * RATE.IMAGE + row.inAudio * RATE.AUDIO_IN + row.outAudio * RATE.AUDIO_OUT + (row.outText + row.thoughts) * RATE.TEXT_OUT) / 1e6;
    rows.push({ ...row, thb: +(usd * THB).toFixed(4) });
    await sleep(1500);
  }
  s.close();
  const tot = rows.reduce((a, r) => a + r.thb, 0);
  console.log(`\n== ${label} (${model}) ==`);
  console.table(rows);
  console.log(`total ${N} shots = ${tot.toFixed(4)} THB  | avg/shot = ${(tot / N).toFixed(4)} THB`);
}
await run('OLD: realtime frames (blind)', 'gemini-3.1-flash-live-preview', false);
await run('NEW: inline frames', 'gemini-3.8-live', true);
process.exit(0);
