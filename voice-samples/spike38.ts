// Spike: is gemini-3.8-live a drop-in for the app's coach path?
//  (1) ephemeral token (v1alpha mint → v1beta connect, like the browser)
//  (2) reads a JPEG on the SAME sendRealtimeInput({video}) channel (can't-parrot probe)
//  (3) proactive audio: does it speak unprompted before/after a turn?
//  (4) stroke-name fidelity: does the coach say the stroke the prompt gives?
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
import { buildCoachSystemPrompt, buildShotPrompt, VOICE_NAMES } from '../src/coach/liveClient';

const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const KEY = process.env.GEMINI_API_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const minter = new GoogleGenAI({ apiKey: KEY, httpOptions: { apiVersion: 'v1alpha' } });
  const t = await minter.authTokens.create({
    config: { uses: 1, expireTime: new Date(Date.now() + 10 * 60_000).toISOString() },
  });
  return t.name!;
}

type Turn = { text: string; audioBytes: number; usage: any };
async function session(systemInstruction: string, voice = 'Aoede') {
  const ai = new GoogleGenAI({ apiKey: await token(), httpOptions: { apiVersion: 'v1beta' } });
  const turns: Turn[] = [];
  let cur: Turn = { text: '', audioBytes: 0, usage: null };
  let onDone: (() => void) | null = null;
  const s = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      outputAudioTranscription: {},
      systemInstruction,
    },
    callbacks: {
      onmessage: (m: any) => {
        for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) cur.audioBytes += p.inlineData.data.length * 0.75;
        if (m.serverContent?.outputTranscription?.text) cur.text += m.serverContent.outputTranscription.text;
        if (m.usageMetadata) cur.usage = m.usageMetadata;
        if (m.serverContent?.turnComplete) { turns.push(cur); cur = { text: '', audioBytes: 0, usage: null }; onDone?.(); }
      },
      onerror: (e: any) => console.log('  onerror', e?.message ?? e),
      onclose: (e: any) => console.log('  onclose', e?.code ?? '', e?.reason ?? ''),
    },
  });
  const waitTurn = (ms = 40000) => new Promise<void>((res, rej) => { onDone = res; setTimeout(() => rej(new Error('turn timeout')), ms); });
  return { s, turns, waitTurn, pending: () => cur };
}

async function main() {
  console.log('MODEL', MODEL);
  // (1)+(2)+(3)
  {
    const { s, turns, waitTurn, pending } = await session('You are a helpful assistant. Answer briefly in English.');
    console.log('[1] token connect OK');
    await sleep(6000);
    console.log(`[3a] unprompted before input: turns=${turns.length} audioBytes=${pending().audioBytes}`);
    s.sendRealtimeInput({ video: { data: readFileSync('voice-samples/probe.jpg').toString('base64'), mimeType: 'image/jpeg' } });
    s.sendClientContent({ turns: 'Describe the image I just sent: what shape and which two colors? Answer in under 10 words.', turnComplete: true });
    await waitTurn();
    const t = turns[turns.length - 1];
    const img = (t.usage?.promptTokensDetails ?? []).find((d: any) => d.modality === 'IMAGE');
    console.log(`[2] reply="${t.text.trim()}" IMAGE tokens=${img?.tokenCount ?? 0}`);
    const before = turns.length;
    await sleep(8000);
    console.log(`[3b] unprompted after turn: extraTurns=${turns.length - before} pendingAudio=${pending().audioBytes}`);
    s.close();
  }
  // (4) stroke fidelity
  const base: any = {
    id: 'x', index: 4, startMs: 0, contactMs: 100, endMs: 200, peakWristSpeed: 2.6, score: 72, captures: [],
    issues: [{ key: 'elbow-too-bent', severity: 'warn' }],
    contactAngles: { timestampMs: 100, leftElbowDeg: 150, rightElbowDeg: 112, leftShoulderDeg: 40, rightShoulderDeg: 92, leftKneeDeg: 160, rightKneeDeg: 165, leftHipDeg: 170, rightHipDeg: 168, trunkLeanDeg: 8, wristSpeed: 2.6, bodyScale: 0.5 },
  };
  const N = Number(process.env.N || 3);
  for (const type of ['backhand', 'unknown'] as const) {
    for (let i = 0; i < N; i++) {
      const { s, turns, waitTurn } = await session(buildCoachSystemPrompt('คุณลูกค้า', 'gentleF', 'encourage', 'short'), VOICE_NAMES.gentleF);
      s.sendClientContent({ turns: buildShotPrompt({ ...base, type }, 'th', 'right', 'both', 'คุณลูกค้า', [], undefined, 'short'), turnComplete: true });
      await waitTurn();
      const txt = turns[0].text.replace(/\s+/g, '');
      const says = txt.includes('แบ็คแฮนด์') || txt.includes('แบคแฮนด์') ? 'BACKHAND' : txt.includes('โฟร์แฮนด์') || txt.includes('โฟแฮนด์') ? 'FOREHAND' : 'none';
      console.log(`[4] type=${type} run${i + 1} says=${says} :: ${turns[0].text.trim()}`);
      s.close();
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
