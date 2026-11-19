import React from 'react';
import { KconfigNode } from '../../../src/shared/protocol';

export interface MenuTreeProps {
  rootNodes: KconfigNode[];
  treeCache: Record<string, KconfigNode[]>;
  expandedMenuIds: string[];
  selectedMenuId: string | null;
  onToggleMenu: (menuId: string) => void;
  onSelectSymbol: (symbol: string) => void;
}

export const MenuTree: React.FC<MenuTreeProps> = ({
  rootNodes,
  treeCache,
  expandedMenuIds,
  selectedMenuId,
  onToggleMenu,
  onSelectSymbol,
}) => {
  const renderNodes = (nodes: KconfigNode[], depth: number): React.ReactNode => {
    return nodes.map((node) => {
      const isExpandable = node.kind === 'menu' || Boolean(node.hasChildren);
      const isExpanded = expandedMenuIds.includes(node.id);
      const isSelected = selectedMenuId === node.id;
      const children = treeCache[node.id] ?? [];

      return (
        <div key={node.id}>
          <div
            className={`kdev-tree-item ${isSelected ? 'selected' : ''} ${
              !node.visible ? 'invisible' : ''
            }`}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            onClick={() => {
              if (isExpandable) {
                onToggleMenu(node.id);
              } else if (node.kind === 'symbol' && node.name) {
                onSelectSymbol(node.name);
              }
            }}
            data-testid={`tree-node-${node.id}`}
          >
            <span>{isExpandable ? (isExpanded ? '▾' : '▸') : '•'}</span>
            <span>{node.prompt || node.name || node.id}</span>
          </div>
          {isExpandable && isExpanded && children.length > 0 && (
            <div>{renderNodes(children, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="kdev-pane-tree" data-testid="menu-tree">
      {renderNodes(rootNodes, 0)}
    </div>
  );
};
