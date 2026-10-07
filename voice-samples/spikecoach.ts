// Real coach prompt + 3 inline frames (the exact v2.7 wire shape) on the target model.
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
import { buildCoachSystemPrompt, buildShotPrompt, VOICE_NAMES } from '../src/coach/liveClient';
const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const IMG = readFileSync('voice-samples/probe.jpg').toString('base64');
const mint = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: 'v1alpha' } });
const tok = (await mint.authTokens.create({ config: { uses: 1, expireTime: new Date(Date.now() + 600000).toISOString() } })).name!;
const ai = new GoogleGenAI({ apiKey: tok, httpOptions: { apiVersion: 'v1beta' } });
let text = '', usage: any = null, done!: () => void;
const fin = new Promise<void>((r) => (done = r));
const s = await ai.live.connect({
  model: MODEL,
  config: {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAMES.firmM } } },
    outputAudioTranscription: {},
    systemInstruction: buildCoachSystemPrompt('คุณลูกค้า', 'firmM', 'encourage', 'short'),
  },
  callbacks: {
    onmessage: (m: any) => {
      if (m.serverContent?.outputTranscription?.text) text += m.serverContent.outputTranscription.text;
      if (m.usageMetadata) usage = m.usageMetadata;
      if (m.serverContent?.turnComplete) done();
    },
    onerror: (e: any) => console.log('err', e?.message ?? e), onclose: () => {},
  },
});
const angles: any = { timestampMs: 1, leftElbowDeg: 150, rightElbowDeg: 112, leftShoulderDeg: 40, rightShoulderDeg: 92, leftKneeDeg: 160, rightKneeDeg: 165, leftHipDeg: 170, rightHipDeg: 168, trunkLeanDeg: 8, wristSpeed: 2.6, bodyScale: 0.5 };
const caps: any[] = ['backswing', 'contact', 'follow-through'].map((phase, i) => ({ id: `c${i}`, phase, tMs: i, angles, statuses: {}, jpegBase64: IMG, landmarks: [] }));
const shot: any = { id: 'x', index: 2, type: 'backhand', startMs: 0, contactMs: 1, endMs: 2, contactAngles: angles, peakWristSpeed: 2.6, score: 70, issues: [{ key: 'elbow-too-bent', severity: 'warn' }], captures: caps };
let turns = buildShotPrompt(shot, 'th', 'right', 'both', 'คุณลูกค้า', caps, undefined, 'short');
turns += '\nThe still frames of this swing are attached in the order listed above — read them as one motion and ground your correction in what you see.';
s.sendClientContent({ turns: [{ role: 'user', parts: [...caps.map((c) => ({ inlineData: { mimeType: 'image/jpeg', data: c.jpegBase64 } })), { text: turns }] }], turnComplete: true });
await Promise.race([fin, new Promise((r) => setTimeout(r, 40000))]);
const img = (usage?.promptTokensDetails ?? []).find((d: any) => d.modality === 'IMAGE');
console.log(`${MODEL}: IMAGE tokens=${img?.tokenCount ?? 0} prompt=${usage?.promptTokenCount} :: ${text.trim()}`);
s.close(); process.exit(0);
