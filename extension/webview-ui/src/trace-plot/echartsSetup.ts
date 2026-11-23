import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  ScatterChart,
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkPointComponent,
  MarkLineComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

export interface TracePlotTheme {
  textColor: string;
  mutedTextColor: string;
  borderColor: string;
  backgroundColor: string;
  tooltipBg: string;
  tooltipBorder: string;
  palette: string[];
}

export const FALLBACK_THEME: TracePlotTheme = {
  textColor: '#d4d4d4',
  mutedTextColor: '#9da5b4',
  borderColor: '#3c3c3c',
  backgroundColor: '#1e1e1e',
  tooltipBg: '#252526',
  tooltipBorder: '#454545',
  palette: [
    '#3794ff',
    '#d18616',
    '#89d185',
    '#b180d7',
    '#cca700',
    '#f14c4c',
  ],
};

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = style.getPropertyValue(name).trim();
  return val || fallback;
}

export function readVscodeChartTheme(): TracePlotTheme {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return FALLBACK_THEME;
  }
  const style = window.getComputedStyle(document.documentElement);
  return {
    textColor: readCssVar(style, '--vscode-editor-foreground', FALLBACK_THEME.textColor),
    mutedTextColor: readCssVar(
      style,
      '--vscode-descriptionForeground',
      FALLBACK_THEME.mutedTextColor
    ),
    borderColor: readCssVar(style, '--vscode-panel-border', FALLBACK_THEME.borderColor),
    backgroundColor: readCssVar(
      style,
      '--vscode-editor-background',
      FALLBACK_THEME.backgroundColor
    ),
    tooltipBg: readCssVar(
      style,
      '--vscode-editorHoverWidget-background',
      FALLBACK_THEME.tooltipBg
    ),
    tooltipBorder: readCssVar(
      style,
      '--vscode-editorHoverWidget-border',
      FALLBACK_THEME.tooltipBorder
    ),
    palette: [
      readCssVar(style, '--vscode-charts-blue', FALLBACK_THEME.palette[0]),
      readCssVar(style, '--vscode-charts-orange', FALLBACK_THEME.palette[1]),
      readCssVar(style, '--vscode-charts-green', FALLBACK_THEME.palette[2]),
      readCssVar(style, '--vscode-charts-purple', FALLBACK_THEME.palette[3]),
      readCssVar(style, '--vscode-charts-yellow', FALLBACK_THEME.palette[4]),
      readCssVar(style, '--vscode-charts-red', FALLBACK_THEME.palette[5]),
    ],
  };
}

export { echarts };
