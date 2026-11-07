import { LIBRARY_BOOKMARK, LIBRARY_PAGES } from '../../domain/libraryMark';

export function BrandMark({ className = 'h-7 w-7' }: { className?: string }) {
  return <img src="icons/icon48.png" alt="" className={`shrink-0 ${className}`} />;
}

export function LibraryMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d={LIBRARY_PAGES} fill="currentColor" />
      <path d={LIBRARY_BOOKMARK} fill="#c06f49" />
    </svg>
  );
}
