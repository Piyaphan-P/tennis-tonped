// Voice catalog on the target Live model: one fixed, particle-free Thai line per
// prebuilt voice so timbre is the only variable. A name the model rejects → ERR.
import { writeFileSync } from 'node:fs';
import { GoogleGenAI, Modality } from '@google/genai';
const MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const LINE = 'ช็อตที่สาม โฟร์แฮนด์ วงสวิงเริ่มนิ่งแล้ว ลองเหยียดแขนออกไปอีกนิด แล้วย่อเข่าลงหน่อย';
const ONLY = process.env.ONLY?.split(',');
const VOICES_ALL = ['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
function wav(pcm: Buffer, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const VOICES = ONLY ?? VOICES_ALL;
const out: any[] = [];
for (const v of VOICES) {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: 'v1beta' } });
    const chunks: Buffer[] = []; let text = ''; let done!: () => void, fail!: (e: unknown) => void;
    const fin = new Promise<void>((r, j) => { done = r; fail = j; });
    const s = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v } } },
        outputAudioTranscription: {},
        systemInstruction: 'You are a voice actor. Read the user\'s Thai line aloud EXACTLY as written, once, in a natural warm tennis-coach tone. Add nothing before or after it.',
      },
      callbacks: {
        onmessage: (m: any) => {
          for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
          if (m.serverContent?.outputTranscription?.text) text += m.serverContent.outputTranscription.text;
          if (m.serverContent?.turnComplete) done();
        },
        onerror: (e: any) => fail(e?.message ?? e), onclose: (e: any) => fail(`closed ${e?.code ?? ''} ${e?.reason ?? ''}`),
      },
    });
    const t = setTimeout(() => fail('timeout'), 40000);
    s.sendClientContent({ turns: LINE, turnComplete: true });
    try { await fin; } finally { clearTimeout(t); try { s.close(); } catch {} }
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) throw new Error('no audio');
    writeFileSync(`voice-samples/catalog/${v}.wav`, wav(pcm));
    out.push({ voice: v, seconds: +(pcm.length / 48000).toFixed(1), text: text.trim() });
    console.log(`OK  ${v.padEnd(14)} ${(pcm.length / 48000).toFixed(1)}s  ${text.trim()}`);
  } catch (e) { out.push({ voice: v, error: String(e) }); console.log(`ERR ${v.padEnd(14)} ${e}`); }
}
if (!ONLY) writeFileSync('voice-samples/catalog/manifest.json', JSON.stringify({ model: MODEL, line: LINE, voices: out }, null, 2));
process.exit(0);
