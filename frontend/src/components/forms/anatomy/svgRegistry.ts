// frontend/src/components/forms/anatomy/svgRegistry.ts
// Drop raw SVG markup here to light up the visual body picker. Each selectable
// shape in the SVG must carry data-region="<id>" (area-head/area-torso/... for
// the overview; the subRegion id for each zoom). Until an entry is filled, the
// selector falls back to buttons for that step.
export const ANATOMY_SVGS: Record<string, string | undefined> = {
  overview: undefined,   // 4 shapes: area-head, area-torso, area-arm, area-leg
  head: undefined,       // brain, eyes, ent, face-jaw, neck
  torso: undefined,      // chest, breast, upper-abdomen, lower-abdomen, pelvis, back-spine
  arm: undefined,        // shoulder, elbow-arm, hand-wrist
  leg: undefined,        // hip, knee, lower-leg, foot-ankle
};
