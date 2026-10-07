import { describe, it, expect } from 'vitest';
import {
  devPlanCardFilename,
  renderDevPlanCard,
  MAX_PLAN_AREAS,
  type DevPlanCardData,
  type PlanAreaCard,
} from './devPlanRenderer';

function area(patch: Partial<PlanAreaCard> = {}): PlanAreaCard {
  return {
    title: 'จุดสัมผัสและการเหยียดแขน',
    symptom: 'ศอกงอตอนโดนลูก',
    why: 'ทำให้พลังหาย',
    drill: 'เหยียดแขนหาลูกช้า ๆ 10 ครั้ง',
    cue: 'เหยียดแขนหาลูก',
    shots: 3,
    ...patch,
  };
}

function data(areas: PlanAreaCard[]): DevPlanCardData {
  return {
    lang: 'th',
    playerName: 'ท่านต้น',
    dateLabel: '28 ก.ค.',
    areas,
    cleanTitle: 'ฟอร์มวันนี้',
    cleanBody: 'ฟอร์มดีมาก ไม่มีจุดต้องแก้ รักษาไว้แบบนี้',
    labels: {
      guideTitle: 'แนวทางพัฒนา',
      symptom: 'อาการ',
      why: 'เพราะอะไร',
      drill: 'วิธีซ้อม',
      cue: 'cue สั้น',
      affected: 'พบใน',
      shotsUnit: 'ช็อต',
    },
  };
}

describe('devPlanRenderer', () => {
  it('devPlanCardFilename is a png with the adge-devplan base', () => {
    expect(devPlanCardFilename()).toBe('adge-devplan.png');
  });

  it('MAX_PLAN_AREAS keeps the card bounded to 3', () => {
    expect(MAX_PLAN_AREAS).toBe(3);
  });

  it('renders a Blob for a plan with areas (node: no document → empty png)', async () => {
    const blob = await renderDevPlanCard(data([area(), area({ shots: 1 })]));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });

  it('renders a Blob for a clean session (empty areas → positive card, never throws)', async () => {
    const blob = await renderDevPlanCard(data([]));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });
});
