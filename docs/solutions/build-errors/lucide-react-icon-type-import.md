---
title: "lucide-react: 'Cannot use namespace LucideIcon as a type'"
category: build-errors
component: frontend
problem_type: build_error
symptoms:
  - "TS2709: Cannot use namespace 'LucideIcon' as a type"
  - "TS6133: 'LucideIcon' is declared but its value is never read"
related_libraries:
  - lucide-react
versions_seen:
  - lucide-react@^0.510.0
  - typescript via Vite (frontend/)
status: resolved
date: 2026-05-04
tags:
  - typescript
  - lucide-react
  - icon-prop-typing
---

# lucide-react: typing icon component props

## Symptom

When typing a component prop that accepts a lucide icon (so callers can swap
which icon renders), the natural import fails:

```ts
import type { LucideIcon } from 'lucide-react';

interface ComingSoonPanelProps {
  icon?: LucideIcon;  // ← TS2709 / TS6133 here
}
```

TypeScript reports both:

- `error TS6133: 'LucideIcon' is declared but its value is never read.`
- `error TS2709: Cannot use namespace 'LucideIcon' as a type.`

The first error is misleading — it implies the import is unused. The second
is the real cause: in lucide-react `0.510.x`, `LucideIcon` resolves as a
**namespace**, not a type, when imported through the package's TypeScript
declarations under this project's `tsconfig`. Both errors disappear together
once the type is replaced.

The same pattern fails when using the inline `type` modifier:

```ts
import {
  Package,
  type LucideIcon,  // ← also fails with TS2709
} from 'lucide-react';
```

## Root cause

`lucide-react` exports `LucideIcon` in a way that this project's TypeScript
configuration interprets as a namespace rather than a usable type alias.
Using `import type` doesn't change the resolution — the underlying export
shape is the issue, not how it's imported. (Other repos with different
`moduleResolution` settings or library versions may not hit this.)

There is no shared `IconComponent` type in the codebase yet — every existing
file just imports concrete icon components like `<Package className="..." />`
inline rather than passing them through props. That's why this is the first
file to hit the problem.

## Fix

Type the icon prop as a generic SVG component instead of relying on
`LucideIcon`. Lucide icons are forward-ref components that accept SVG props,
so this is a structural superset and works for any lucide icon:

```ts
import { Sparkles } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

interface ComingSoonPanelProps {
  title: string;
  description?: string;
  icon?: IconComponent;
}

const ComingSoonPanel = ({ title, icon: Icon = Sparkles }: ComingSoonPanelProps) => (
  <Icon className="h-7 w-7 text-oe-primary" />
);
```

This passes `tsc --noEmit` cleanly and accepts any lucide icon at the call
site:

```tsx
import { Phone } from 'lucide-react';
<ComingSoonPanel icon={Phone} title="Call Log" />
```

`className` is added explicitly to the prop intersection because lucide
icons accept it as a real prop (it ends up on the wrapping `<svg>`), and
narrowing the type without it surfaces inference issues in some callers.

## Where this lives in the repo

- `frontend/src/components/vendor/members/ComingSoonPanel.tsx` —
  defines and uses `IconComponent`.
- `frontend/src/components/vendor/members/MemberWorkspaceTabs.tsx` —
  same `IconComponent` alias inlined for the per-tab icon registry.

If a third place needs the same alias, lift it to a shared types file
rather than redeclaring a third time.

## Prevention

- **Don't reach for `LucideIcon`.** It looks like the obvious choice but
  isn't usable as a type in this project. The structural alias above is
  the supported path.
- **If lucide-react is upgraded to a new major** and this becomes resolvable
  as a type again, leave the structural alias in place — it works on every
  version and is no less precise for the limited surface lucide actually
  uses.
- **No need to add an ESLint rule.** A future dev hitting this error will
  search for `LucideIcon` and land on this file.

## Verification

```
cd frontend && npx tsc --noEmit | grep -E "LucideIcon|TS2709"
# → no output (zero matches)
```

## Related context

- Discovered while building the vendor portal Members split-pane workspace
  (see `docs/plans/2026-05-04-feat-vendor-portal-members-workspace-plan.md`).
  Workspace tabs needed an `icon` prop on a placeholder panel and on the
  per-tab registry, which forced typed icon props for the first time in
  this codebase.
