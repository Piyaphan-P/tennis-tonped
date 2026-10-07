// Which image-send pattern does the Live model actually SEE?
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const KEY = process.env.GEMINI_API_KEY!;
const IMG = readFileSync('voice-samples/probe.jpg').toString('base64');
const Q = 'What shape and which two colors are in the image? Answer in under 10 words.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, send: (s: any) => Promise<void>) {
  const ai = new GoogleGenAI({ apiKey: KEY, httpOptions: { apiVersion: 'v1beta' } });
  let text = '', usage: any = null, done!: () => void;
  const fin = new Promise<void>((r) => (done = r));
  const s = await ai.live.connect({
    model: MODEL,
    config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {}, systemInstruction: 'Answer briefly in English.' },
    callbacks: {
      onmessage: (m: any) => {
        if (m.serverContent?.outputTranscription?.text) text += m.serverContent.outputTranscription.text;
        if (m.usageMetadata) usage = m.usageMetadata;
        if (m.serverContent?.turnComplete) done();
      },
      onerror: (e: any) => console.log('  err', e?.message ?? e), onclose: () => {},
    },
  });
  await send(s);
  await Promise.race([fin, sleep(30000)]);
  const img = (usage?.promptTokensDetails ?? []).find((d: any) => d.modality === 'IMAGE');
  console.log(`${label.padEnd(34)} IMAGE=${img?.tokenCount ?? 0}  "${text.trim()}"`);
  s.close();
}

await run('A realtime video → text (now)', async (s) => {
  s.sendRealtimeInput({ video: { data: IMG, mimeType: 'image/jpeg' } });
  s.sendClientContent({ turns: Q, turnComplete: true });
});
await run('B realtime video, wait 2s → text', async (s) => {
  s.sendRealtimeInput({ video: { data: IMG, mimeType: 'image/jpeg' } });
  await sleep(2000);
  s.sendClientContent({ turns: Q, turnComplete: true });
});
await run('C clientContent inlineData+text', async (s) => {
  s.sendClientContent({ turns: [{ role: 'user', parts: [{ inlineData: { data: IMG, mimeType: 'image/jpeg' } }, { text: Q }] }], turnComplete: true });
});
await run('D realtime video → realtime text', async (s) => {
  s.sendRealtimeInput({ video: { data: IMG, mimeType: 'image/jpeg' } });
  await sleep(500);
  s.sendRealtimeInput({ text: Q });
});
process.exit(0);
