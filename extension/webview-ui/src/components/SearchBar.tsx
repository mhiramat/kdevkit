import React from 'react';

export interface SearchBarProps {
  query: string;
  onlyChanged: boolean;
  onSearchChange: (query: string, onlyChanged: boolean) => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  query,
  onlyChanged,
  onSearchChange,
}) => {
  return (
    <div className="kdev-search-bar">
      <input
        type="search"
        className="kdev-search-input"
        placeholder="Search CONFIG_ symbol or prompt..."
        value={query}
        onChange={(e) => onSearchChange(e.target.value, onlyChanged)}
        aria-label="Search Kconfig symbols"
      />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input
          type="checkbox"
          checked={onlyChanged}
          onChange={(e) => onSearchChange(query, e.target.checked)}
        />
        Modified Only
      </label>
    </div>
  );
};
