import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className
      )}
      aria-label="Loading"
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  label: string;
  children: ReactNode;
}

export function IconButton({ active, label, children, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors',
        'text-muted hover:bg-surface-2 hover:text-fg',
        active && 'text-accent',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted',
        className
      )}
    >
      {children}
    </span>
  );
}
