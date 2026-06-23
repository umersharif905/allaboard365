# Anatomy reference images

Drop the 5 procedure-selector pictures here (white background OK):

- `body.png` — full-body overview (areas: 1 Head & neck, 2 Torso, 3 Arm & hand, 4 Leg & foot)
- `head.png` — 1 Brain & skull, 2 Eyes, 3 Ears/nose/sinus/throat, 4 Face/jaw/mouth, 5 Neck & thyroid
- `torso.png` — 1 Chest, 2 Breast, 3 Upper abdomen, 4 Lower abdomen, 5 Pelvis, 6 Back & spine
- `arms.png` — 1 Shoulder, 2 Upper arm & elbow, 3 Hand & wrist
- `legs.png` — 1 Hip, 2 Knee, 3 Thigh & lower leg, 4 Foot & ankle

Served statically at `/anatomy/<file>` — swapping a file needs no rebuild (just refresh).
The numbered/colored list in the selector matches the numbers on these images.
Filenames + colors are configured in `src/components/forms/anatomy/anatomyImages.ts`.
