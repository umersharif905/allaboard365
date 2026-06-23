import React, { useState } from 'react';

import { Package } from 'lucide-react';

import type { TrainingPackage } from '../trainingTypes';

export function packageDisplaySubtitle(trainingPackage: TrainingPackage): string {
  const purpose = trainingPackage.packagePurpose?.trim();
  if (purpose) {
    return purpose;
  }
  const certName = trainingPackage.certificate?.certificateName?.trim();
  if (certName) {
    return certName;
  }
  return `${trainingPackage.status} · v${trainingPackage.version}`;
}

export function packageDisplayImageUrl(trainingPackage: TrainingPackage): string {
  return (
    trainingPackage.packageImageUrl?.trim() ||
    trainingPackage.certificate?.certificateImageUrl ||
    ''
  );
}

export function PackageCardGraphic(props: { imageUrl: string }) {
  const { imageUrl } = props;
  const [failed, setFailed] = useState(false);
  const url = imageUrl?.trim();

  if (!url || failed) {
    return (
      <div
        className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-b from-slate-100 to-slate-50"
        aria-hidden
      >
        <Package className="h-14 w-14 text-slate-400" strokeWidth={1.25} />
      </div>
    );
  }

  return (
    <div className="flex aspect-[4/3] w-full items-center justify-center bg-white px-6 py-5">
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full object-contain object-center"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function PackagePickCardInner(props: { trainingPackage: TrainingPackage }) {
  const { trainingPackage } = props;
  const imageUrl = packageDisplayImageUrl(trainingPackage);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
      <PackageCardGraphic imageUrl={imageUrl} />

      <hr className="border-t border-slate-200" />

      <div className="p-3">
        <div className="rounded-lg border border-blue-200 bg-gradient-to-b from-sky-50 via-blue-50/90 to-white px-3 py-3 text-center shadow-sm">
          <p className="text-base font-semibold leading-snug text-slate-900">{trainingPackage.title}</p>
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-700">
            {packageDisplaySubtitle(trainingPackage)}
          </p>
        </div>
      </div>
    </div>
  );
}

export function TrainingPackageTocChip(props: {
  trainingPackage: TrainingPackage;
  onChangePackage: () => void;
}) {
  const { trainingPackage, onChangePackage } = props;
  const url = packageDisplayImageUrl(trainingPackage);

  return (
    <div className="flex w-full max-w-[560px] items-center gap-3 rounded-xl border border-indigo-200 bg-white py-3 pl-3 pr-2 shadow-md">
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-10 w-10 text-slate-400" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-slate-900">{trainingPackage.title}</p>
        <p className="truncate text-sm text-slate-600">{packageDisplaySubtitle(trainingPackage)}</p>
      </div>
      <button
        type="button"
        onClick={onChangePackage}
        className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
      >
        Change
      </button>
    </div>
  );
}
