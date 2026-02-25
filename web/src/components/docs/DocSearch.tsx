import { useState, useEffect, useRef, useCallback } from 'react';
import Fuse from 'fuse.js';

interface SearchItem {
  title: string;
  description: string;
  section: string;
  slug: string;
  url: string;
  excerpt: string;
}

interface SearchResult {
  item: SearchItem;
  score?: number;
}

export default function DocSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fuse, setFuse] = useState<Fuse<SearchItem> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load search index lazily on first focus
  const loadIndex = useCallback(async () => {
    if (fuse) return;
    try {
      const res = await fetch('/search.json');
      const data: SearchItem[] = await res.json();
      const instance = new Fuse(data, {
        keys: [
          { name: 'title', weight: 0.4 },
          { name: 'description', weight: 0.3 },
          { name: 'excerpt', weight: 0.2 },
          { name: 'section', weight: 0.1 },
        ],
        threshold: 0.4,
        includeScore: true,
      });
      setFuse(instance);
    } catch {
      // silently fail — search just won't work
    }
  }, [fuse]);

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Click outside to close
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Search on query change
  useEffect(() => {
    if (!fuse || query.length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    const hits = fuse.search(query).slice(0, 8);
    setResults(hits);
    setIsOpen(hits.length > 0);
    setSelectedIndex(0);
  }, [query, fuse]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      window.location.href = results[selectedIndex].item.url;
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }

  return (
    <div ref={containerRef} className="doc-search">
      <div className="doc-search-input-wrap">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search docs..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={loadIndex}
          onKeyDown={onKeyDown}
          aria-label="Search documentation"
          aria-expanded={isOpen}
          role="combobox"
          aria-controls="doc-search-results"
          autoComplete="off"
        />
        <kbd className="doc-search-shortcut">/</kbd>
      </div>

      {isOpen && (
        <ul id="doc-search-results" className="doc-search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.item.slug}
              role="option"
              aria-selected={i === selectedIndex}
              className={i === selectedIndex ? 'selected' : ''}
            >
              <a href={r.item.url}>
                <span className="doc-search-result-title">{r.item.title}</span>
                {r.item.section && (
                  <span className="doc-search-result-section">{r.item.section}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
