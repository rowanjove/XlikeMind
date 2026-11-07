import React from 'react';
import { sanitizeUrl } from '../../domain/sanitize';

interface SafeExternalLinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
}

/** Renders an external link only when the URL is http(s). Unsafe values stay as text. */
export const SafeExternalLink: React.FC<SafeExternalLinkProps> = ({ href, className, children }) => {
  const safe = sanitizeUrl(href);
  if (!safe) {
    return <span className={className}>{children}</span>;
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
};
