// Generates one sample WAV per voiceTone × coachMode using the app's REAL prompt
// builders + the same Gemini Live config as liveClient (native SDK path).
// Run: GEMINI_API_KEY=… npx vite-node voice-samples/gen.ts
import { writeFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
import {
  buildCoachSystemPrompt,
  buildShotPrompt,
  VOICE_NAMES,
} from '../src/coach/liveClient';
import type { CoachMode, Shot, VoiceTone } from '../src/types';

const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const VERBOSITY = (process.env.VERBOSITY as 'short' | 'medium' | 'long') || 'short';
const TONES: VoiceTone[] = ['gentleF', 'firmF', 'firmM', 'friendlyM'];
const MODES: CoachMode[] = ['encourage', 'hardcore', 'polite', 'buddy'];
const only = process.argv[2]; // optional "gentleF:encourage"

const angles = {
  rightElbowDeg: 112, leftElbowDeg: 150, rightShoulderDeg: 92, leftShoulderDeg: 40,
  rightKneeDeg: 165, leftKneeDeg: 160, leftHipDeg: 170, rightHipDeg: 168, trunkLeanDeg: 8, timestampMs: 100, wristSpeed: 2.6, bodyScale: 0.5,
} as any;
const shot: Shot = {
  id: 'sample', index: 3, type: 'forehand', startMs: 0, contactMs: 100, endMs: 200,
  contactAngles: angles, peakWristSpeed: 2.6, score: 72,
  issues: [{ key: 'elbow-too-bent', severity: 'warn' } as any, { key: 'no-knee-bend', severity: 'warn' } as any],
  captures: [],
} as any;

function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function one(tone: VoiceTone, mode: CoachMode) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: 'v1beta' } });
  const chunks: Buffer[] = [];
  let text = '';
  let done!: () => void, fail!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => { done = res; fail = rej; });
  const session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAMES[tone] } } },
      outputAudioTranscription: {},
      systemInstruction: buildCoachSystemPrompt('คุณลูกค้า', tone, mode, VERBOSITY),
    },
    callbacks: {
      onmessage: (m: any) => {
        for (const p of m.serverContent?.modelTurn?.parts ?? []) {
          if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
        }
        if (m.serverContent?.outputTranscription?.text) text += m.serverContent.outputTranscription.text;
        if (m.serverContent?.turnComplete) done();
      },
      onerror: (e: any) => fail(e?.message ?? e),
      onclose: (e: any) => fail(`closed: ${e?.reason ?? ''}`),
    },
  });
  const t = setTimeout(() => fail('timeout 45s'), 45000);
  session.sendClientContent({
    turns: buildShotPrompt(shot, 'th', 'right', 'both', 'คุณลูกค้า', [], undefined, VERBOSITY),
    turnComplete: true,
  });
  try { await finished; } finally { clearTimeout(t); try { session.close(); } catch {} }
  const pcm = Buffer.concat(chunks);
  const file = `voice-samples/${tone}-${VOICE_NAMES[tone]}__${mode}.wav`;
  writeFileSync(file, wav(pcm));
  return { tone, voice: VOICE_NAMES[tone], mode, file, seconds: +(pcm.length / 48000).toFixed(1), text: text.trim() };
}

const out: any[] = [];
for (const tone of TONES) for (const mode of MODES) {
  if (only && only !== `${tone}:${mode}`) continue;
  try { const r = await one(tone, mode); out.push(r); console.log(`OK  ${r.file}  ${r.seconds}s  ${r.text}`); }
  catch (e) { out.push({ tone, mode, error: String(e) }); console.log(`ERR ${tone}:${mode} ${e}`); }
}
writeFileSync('voice-samples/manifest.json', JSON.stringify({ model: MODEL, verbosity: VERBOSITY, shot: { index: 3, type: 'forehand', score: 72 }, samples: out }, null, 2));
process.exit(0);
