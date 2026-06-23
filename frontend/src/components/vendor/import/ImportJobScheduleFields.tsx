import React from 'react';
import { Plus, X } from 'lucide-react';
import {
  buildDailyCronUtc,
  defaultEasternSlot,
  formatEasternTime,
  formatScheduleSummary,
  parseVendorImportCron,
  sortEasternSlots,
  type EasternTimeSlot,
} from '../../../utils/vendorImportJobSchedule';

type Props = {
  cronScheduleUtc: string;
  onChange: (cron: string) => void;
  required?: boolean;
};

type ScheduleMode = 'friendly' | 'custom';

function hour24To12(hour: number): { hour12: number; ampm: 'AM' | 'PM' } {
  const ampm = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 || 12;
  return { hour12, ampm };
}

function hour12To24(hour12: number, ampm: 'AM' | 'PM'): number {
  if (ampm === 'AM') return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

function initFromCron(cron: string): {
  mode: ScheduleMode;
  minute: number;
  slots: EasternTimeSlot[];
  customCron: string;
} {
  const parsed = parseVendorImportCron(cron);
  if (parsed.kind === 'daily') {
    return {
      mode: 'friendly',
      minute: parsed.minute,
      slots: parsed.slots.length ? sortEasternSlots(parsed.slots) : [defaultEasternSlot()],
      customCron: cron,
    };
  }
  return {
    mode: 'custom',
    minute: 0,
    slots: [defaultEasternSlot()],
    customCron: cron,
  };
}

const ImportJobScheduleFields: React.FC<Props> = ({ cronScheduleUtc, onChange, required = true }) => {
  const [mode, setMode] = React.useState<ScheduleMode>('friendly');
  const [minute, setMinute] = React.useState(0);
  const [slots, setSlots] = React.useState<EasternTimeSlot[]>([defaultEasternSlot()]);
  const [customCron, setCustomCron] = React.useState('');

  React.useEffect(() => {
    const init = initFromCron(cronScheduleUtc);
    setMode(init.mode);
    setMinute(init.minute);
    setSlots(init.slots);
    setCustomCron(init.customCron);
  }, [cronScheduleUtc]);

  const emitFriendly = (nextMinute: number, nextSlots: EasternTimeSlot[]) => {
    const normalized = sortEasternSlots(
      nextSlots.map((s) => ({ hour: s.hour, minute: nextMinute })),
    );
    onChange(buildDailyCronUtc(nextMinute, normalized));
  };

  const updateMinute = (nextMinute: number) => {
    setMinute(nextMinute);
    if (mode === 'friendly') emitFriendly(nextMinute, slots);
  };

  const updateSlots = (nextSlots: EasternTimeSlot[]) => {
    const sorted = sortEasternSlots(nextSlots);
    setSlots(sorted);
    if (mode === 'friendly') emitFriendly(minute, sorted);
  };

  const switchToFriendly = () => {
    const init = initFromCron(cronScheduleUtc);
    if (init.mode === 'friendly') {
      setMode('friendly');
      setMinute(init.minute);
      setSlots(init.slots);
      emitFriendly(init.minute, init.slots);
      return;
    }
    setMode('friendly');
    const defaults = [defaultEasternSlot()];
    setMinute(0);
    setSlots(defaults);
    emitFriendly(0, defaults);
  };

  const switchToCustom = () => {
    setMode('custom');
    setCustomCron(cronScheduleUtc);
  };

  const friendlyCron = buildDailyCronUtc(
    minute,
    sortEasternSlots(slots.map((s) => ({ hour: s.hour, minute }))),
  );
  const summary = mode === 'friendly' ? formatScheduleSummary(friendlyCron) : formatScheduleSummary(customCron);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-gray-700">
          Schedule <span className="font-normal text-gray-400">(Eastern Time)</span>
        </label>
        {mode === 'friendly' ? (
          <button
            type="button"
            onClick={switchToCustom}
            className="text-xs text-oe-primary hover:underline"
          >
            Advanced cron
          </button>
        ) : (
          <button
            type="button"
            onClick={switchToFriendly}
            className="text-xs text-oe-primary hover:underline"
          >
            Use time picker
          </button>
        )}
      </div>

      {mode === 'friendly' ? (
        <>
          <p className="text-xs text-gray-500">
            Pick when this job runs each day. Times are Eastern (ET) and saved as UTC cron for the server.
          </p>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-600">At minute</span>
            <select
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
              value={minute}
              onChange={(e) => updateMinute(Number(e.target.value))}
            >
              {Array.from({ length: 60 }, (_, i) => (
                <option key={i} value={i}>{pad2(i)}</option>
              ))}
            </select>
            <span className="text-gray-500 text-xs">past the hour (usually :00)</span>
          </div>

          <div className="space-y-2">
            {slots.map((slot, index) => {
              const { hour12, ampm } = hour24To12(slot.hour);
              return (
                <div key={`${index}-${slot.hour}`} className="flex items-center gap-2">
                  <select
                    className="border border-gray-300 rounded-lg px-2 py-2 text-sm w-16"
                    value={hour12}
                    onChange={(e) => {
                      const next = [...slots];
                      next[index] = {
                        hour: hour12To24(Number(e.target.value), ampm),
                        minute,
                      };
                      updateSlots(next);
                    }}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  <select
                    className="border border-gray-300 rounded-lg px-2 py-2 text-sm w-20"
                    value={ampm}
                    onChange={(e) => {
                      const next = [...slots];
                      next[index] = {
                        hour: hour12To24(hour12, e.target.value as 'AM' | 'PM'),
                        minute,
                      };
                      updateSlots(next);
                    }}
                  >
                    <option value="AM">AM</option>
                    <option value="PM">PM</option>
                  </select>
                  <span className="text-sm text-gray-500 flex-1">
                    {formatEasternTime(slot.hour, minute)} ET
                  </span>
                  {slots.length > 1 && (
                    <button
                      type="button"
                      onClick={() => updateSlots(slots.filter((_, i) => i !== index))}
                      className="text-gray-400 hover:text-red-600"
                      aria-label="Remove run time"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => updateSlots([...slots, { hour: 12, minute }])}
            className="inline-flex items-center gap-1 text-sm text-oe-primary hover:underline"
          >
            <Plus className="h-4 w-4" /> Add another time
          </button>

          {friendlyCron && (
            <p className="text-xs text-gray-400 font-mono">
              UTC cron: {friendlyCron}
            </p>
          )}
        </>
      ) : (
        <>
          <input
            type="text"
            className="w-full font-mono border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={customCron}
            onChange={(e) => {
              setCustomCron(e.target.value);
              onChange(e.target.value);
            }}
            placeholder="0 0 5,17 * * *"
            required={required}
          />
          <p className="text-xs text-gray-400">
            6-part UTC cron: sec min hour day-of-month month day-of-week
          </p>
        </>
      )}

      {summary && (
        <p className="text-xs text-oe-primary">{summary}</p>
      )}
    </div>
  );
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export default ImportJobScheduleFields;
