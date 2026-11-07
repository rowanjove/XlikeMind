import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  badge?: string;
  badgeColor?: 'sky' | 'emerald' | 'amber' | 'rose' | 'slate';
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  icon: Icon,
  badge,
  badgeColor = 'sky',
}) => {
  const badgeClasses = {
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
  }[badgeColor];

  return (
    <div className="lm-metric-card px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-stone-500">{title}</span>
        {badge ? (
          <span className={`rounded-full border px-2 py-0.5 text-xs ${badgeClasses}`}>{badge}</span>
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e6eee8]">
            <Icon className="h-3.5 w-3.5 text-[#315846]" />
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 tabular-nums">{value}</div>
      {subtitle && <p className="mt-1 text-xs text-stone-500">{subtitle}</p>}
    </div>
  );
};
